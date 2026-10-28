import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { patchTelegramApprovalRuntime, planTelegramApprovalRuntimePatch, installTelegramApprovalRuntimePatch } from "../scripts/patch-openclaw-approval-runtime.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/telegram-delivery-source.json", import.meta.url), "utf8"));
const production = fixture.legacyRuntime;
const blockStart = production.indexOf("\t\tdeliverPending: async (");
const blockEnd = production.indexOf("\n\t\tupdateEntry: async (", blockStart);
const fixedV1 = production.slice(0, blockStart) + fixture.requestIdDelivery + production.slice(blockEnd);
const upstream = production.replace(/^import \{ claimTelegramApprovalDelivery.*\n/m, "")
  .replace(/\n\t\t\tif \(!claimTelegramApprovalDelivery\([\s\S]*?\n\t\t\t\}/, "")
  .replace(/\n\t\t\tmarkTelegramApprovalDeliverySent\([^\n]*\);/, "");

for (const [variant, source] of [["unpatched", upstream], ["legacy incorrect ID", production], ["existing request-ID candidate", fixedV1]]) {
  test(`patcher upgrades ${variant} and is idempotent`, () => {
    const result = patchTelegramApprovalRuntime(source);
    assert.match(result, /approvalId: request\.id/);
    assert.doesNotMatch(result, /pendingPayload\.approvalId/);
    assert.match(result, /markTelegramApprovalDeliveryUncertain/);
    assert.equal(patchTelegramApprovalRuntime(result), result);
  });
}

test("patcher preserves card rendering, callback protocol, expiry and unrelated edits exactly", () => {
  const modified = production + "\n// unrelated local modification\n";
  const result = patchTelegramApprovalRuntime(modified);
  const prefix = (s) => s.slice(s.indexOf("//#region"), s.indexOf("\t\tdeliverPending: async ("));
  const suffix = (s) => s.slice(s.indexOf("\n\t\tupdateEntry: async ("));
  assert.equal(prefix(result), prefix(modified)); assert.equal(suffix(result), suffix(modified));
});

test("unrecognized delivery changes fail closed rather than being overwritten", () => {
  assert.throws(() => patchTelegramApprovalRuntime(production.replace("return null;\n\t\t\t}\n\t\t\tconst options", "return false;\n\t\t\t}\n\t\t\tconst options")), /unrecognized/);
  assert.throws(() => patchTelegramApprovalRuntime("export const unknown = true;"), /anchors/);
});

for (const extension of ["js", "mjs"]) {
  test(`installer plan discovers .${extension} runtime and changes no files`, () => {
    const dir = mkdtempSync(join(tmpdir(), "telegram-patcher-"));
    try {
      const pkg = join(dir, "global/node_modules/openclaw"); const dist = join(pkg, "dist"); mkdirSync(dist, { recursive: true });
      writeFileSync(join(pkg, "package.json"), '{"version":"fixture","type":"module"}');
      const file = join(dist, `approval-handler.runtime-fixture.${extension}`); writeFileSync(file, production.replaceAll(".mjs\"", `.${extension}\"`));
      const launcher = join(dir, "openclaw"); writeFileSync(launcher, 'node "$basedir/global/node_modules/openclaw/openclaw.mjs"');
      const plan = planTelegramApprovalRuntimePatch({ launcher });
      assert.equal(plan.version, "fixture"); assert.equal(plan.changes.length, 2);
      assert.equal(plan.changes[0].path, file);
      assert.match(plan.changes[0].after, /delivery v2/);
      assert.equal(readFileSync(file, "utf8"), plan.changes[0].before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("already patched runtime still detects a stale deployed helper", () => {
  const dir = mkdtempSync(join(tmpdir(), "telegram-helper-refresh-"));
  try {
    const pkg = join(dir, "global/node_modules/openclaw"); const dist = join(pkg, "dist"); mkdirSync(dist, { recursive: true });
    writeFileSync(join(pkg, "package.json"), '{"version":"fixture"}');
    const fixed = patchTelegramApprovalRuntime(production);
    writeFileSync(join(dist, "approval-handler.runtime-fixture.mjs"), fixed);
    writeFileSync(join(dist, "execution-gate-approval-delivery-dedupe.js"), fixture.legacyHelper);
    const launcher = join(dir, "openclaw"); writeFileSync(launcher, 'node "$basedir/global/node_modules/openclaw/openclaw.mjs"');
    const plan = planTelegramApprovalRuntimePatch({ launcher });
    assert.equal(plan.changes[0].before, plan.changes[0].after);
    assert.notEqual(plan.changes[1].before, plan.changes[1].after);
    writeFileSync(join(dist, "execution-gate-approval-delivery-dedupe.js"), "// unrelated helper edit");
    assert.throws(() => planTelegramApprovalRuntimePatch({ launcher }), /unrecognized installed approval dedupe helper/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("production installer refuses this non-TTY test process before any mutation", () => {
  assert.notEqual(process.env.OPENCLAW_ADMIN_TEST_MODE, "1");
  assert.throws(() => installTelegramApprovalRuntimePatch(), /requires a local TTY/);
});

test("formal admin route also requires a real local TTY", async (t) => {
  const admin = new URL("../bin/openclaw-admin.mjs", import.meta.url).pathname;
  if (!existsSync(admin)) { t.skip("public distribution does not ship the production admin CLI"); return; }
  await assert.rejects(promisify(execFile)(process.execPath, [admin, "approvals", "patch-telegram-runtime"], { encoding: "utf8" }), (error) => {
    // Host-loaded logging may suppress console output; the existing admin
    // permission exit code is authoritative. The direct test above checks
    // the precise TTY error before any write or transaction lock.
    assert.equal(error.code, 77); return true;
  });
});
