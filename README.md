# OpenClaw Execution Gate template

This is a sanitized public template for a low-friction OpenClaw execution gate. It contains no production database, credentials, personal memory, address, account, or runtime state.

## Model

- **ALLOW**: ordinary workspace reads/writes, status queries, and bounded automation effects.
- **CONFIRM**: orders, payments, third-party messages, credential or security-policy changes, and unknown high-impact commands.
- **DENY**: explicit destructive system actions and deliberate bypasses.

The Telegram confirmation flow binds a pending operation to a stable actor/channel scope, tool name, and parameter hash. A model message asking for confirmation does not create an operation.

Automation Grants bind an enabled job to exact capabilities, tools, resources, commands, destinations, and a runtime context. REM scanning uses fictional memory examples and isolates per-file failure. Benefits orchestration keeps query/claim capabilities separate from order/payment capabilities.

Access control is an example interface only. It is disabled by default and contains no provider endpoint or physical location.

## Install

```bash
# Template repository: public code only.
git clone <REPOSITORY_URL> ~/openclaw-execution-gate-template
cd ~/openclaw-execution-gate-template
npm install

# Private overlay: ignored and retained only on this machine.
mkdir -p private-overlay
cp .env.example private-overlay/.env
# Edit private-overlay/.env locally.

# Runtime deployment: must be outside the template Git working tree.
bash scripts/install-template.sh ~/openclaw-execution-gate-runtime
bash scripts/apply-private-overlay.sh ~/openclaw-execution-gate-runtime
npm test
npm run build
```

Keep these locations separate:

```text
~/openclaw-execution-gate-template/                 public Git template
~/openclaw-execution-gate-template/private-overlay/ local ignored configuration
~/openclaw-execution-gate-runtime/                  deployed runtime files
```

The install and overlay scripts reject a runtime directory inside the template
repository. Do not use the template repository itself as a deployment target.

See [Architecture](docs/ARCHITECTURE.md), [Recovery](docs/RECOVERY.md), [Customization](docs/CUSTOMIZATION.md), and [Security model](docs/SECURITY-MODEL.md).

## Privacy

Never commit a private overlay, database, log, chat transcript, personal memory, address, or token. Run `npm run verify` before every public release.

Use `npm run verify` inside a Git repository: it scans the worktree, every tracked path, staged content, and recoverable Git history. Normal mode permits an untracked local `private-overlay/`.

Use `bash scripts/verify-public-template.sh --release` only against a clean export directory without `.git`, before creating an archive or uploading. Release mode rejects `private-overlay/` and other private runtime content.
