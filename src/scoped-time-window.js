import { newId } from "./canonical-json.js";

export const SCOPED_TIME_WINDOW = "SCOPED_TIME_WINDOW";
export const SCOPED_TIME_WINDOW_TTL_MS = 300_000;

// A window is bound to the current task run as well as actor/channel/session.
// Each covered call still enters the trusted policy and is audited by the bus.
export class ScopedTimeWindowStore {
  constructor(operationStore) { this.operationStore = operationStore; }
  get db() { this.operationStore.open(); return this.operationStore.db; }

  ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scoped_time_windows (
        grant_id TEXT PRIMARY KEY,
        grant_type TEXT NOT NULL CHECK (grant_type = 'SCOPED_TIME_WINDOW'),
        actor_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        gateway_boot_id TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        revoke_reason TEXT
      );
    `);
    const columns = new Set(this.db.prepare("PRAGMA table_info(scoped_time_windows)").all().map((row) => row.name));
    if (!columns.has("run_id")) this.db.exec("ALTER TABLE scoped_time_windows ADD COLUMN run_id TEXT NOT NULL DEFAULT ''");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_scoped_time_windows_lookup_v2
        ON scoped_time_windows(actor_id, channel_id, session_id, run_id, gateway_boot_id, policy_version, status, expires_at);
    `);
  }

  create({ identity, policyVersion, ttlMs = SCOPED_TIME_WINDOW_TTL_MS, now = Date.now() }) {
    this.ensureSchema();
    const runId = text(identity?.runId);
    if (!runId) return null;
    const grantId = newId("scope");
    const expiresAt = now + SCOPED_TIME_WINDOW_TTL_MS; // fixed by policy; never caller-controlled
    this.db.prepare(`UPDATE scoped_time_windows SET status = 'REVOKED', revoked_at = ?, revoke_reason = 'superseded'
      WHERE actor_id = ? AND channel_id = ? AND session_id = ? AND run_id = ? AND gateway_boot_id = ? AND policy_version = ? AND status = 'ACTIVE'`).run(
      now, identity.actorId, identity.channelId, identity.sessionId, runId, identity.gatewayBootId, policyVersion
    );
    this.db.prepare(`INSERT INTO scoped_time_windows (
      grant_id, grant_type, actor_id, channel_id, session_id, run_id, gateway_boot_id, policy_version, status, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`)
      .run(grantId, SCOPED_TIME_WINDOW, identity.actorId, identity.channelId, identity.sessionId, runId, identity.gatewayBootId, policyVersion, now, expiresAt);
    return { grantId, expiresAt, ttlMs: SCOPED_TIME_WINDOW_TTL_MS };
  }

  findActive({ identity, policyVersion, now = Date.now() }) {
    this.ensureSchema();
    const runId = text(identity?.runId);
    if (!runId) return null;
    this.db.prepare("UPDATE scoped_time_windows SET status = 'EXPIRED' WHERE status = 'ACTIVE' AND expires_at <= ?").run(now);
    return this.db.prepare(`SELECT * FROM scoped_time_windows WHERE actor_id = ? AND channel_id = ? AND session_id = ? AND run_id = ?
      AND gateway_boot_id = ? AND policy_version = ? AND status = 'ACTIVE' AND expires_at > ?
      ORDER BY created_at DESC LIMIT 1`).get(identity.actorId, identity.channelId, identity.sessionId, runId, identity.gatewayBootId, policyVersion, now) || null;
  }

  revoke({ identity, policyVersion, reason = 'user_revoked', now = Date.now() }) {
    this.ensureSchema();
    const runId = text(identity?.runId);
    if (runId) {
      return this.db.prepare(`UPDATE scoped_time_windows SET status = 'REVOKED', revoked_at = ?, revoke_reason = ?
        WHERE actor_id = ? AND channel_id = ? AND session_id = ? AND run_id = ? AND gateway_boot_id = ? AND policy_version = ? AND status = 'ACTIVE'`).run(
        now, reason, identity.actorId, identity.channelId, identity.sessionId, runId, identity.gatewayBootId, policyVersion
      ).changes;
    }
    return this.db.prepare(`UPDATE scoped_time_windows SET status = 'REVOKED', revoked_at = ?, revoke_reason = ?
      WHERE actor_id = ? AND channel_id = ? AND session_id = ? AND gateway_boot_id = ? AND policy_version = ? AND status = 'ACTIVE'`).run(
      now, reason, identity.actorId, identity.channelId, identity.sessionId, identity.gatewayBootId, policyVersion
    ).changes;
  }
}

function text(value) { return typeof value === "string" ? value.trim() : ""; }
