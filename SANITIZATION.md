# Sanitization record

| Category | Public representation |
|---|---|
| Personal identity | `<USER_NAME>`, `<USER_EMAIL>` |
| Telegram identity | `<TELEGRAM_USER_ID>`, `<TELEGRAM_CHAT_ID>`, `<BOT_USERNAME>` |
| Automation state | `<JOB_ID>`, `<GRANT_ID>`, `<OPERATION_ID>`, `<RUN_ID>`, `<SESSION_ID>` |
| Address/access control | `<COMMUNITY_NAME>`, `<BUILDING_ID>`, `<UNIT_ID>`, `<ACCESS_CONTROL_SCOPE>` |
| Server/network | `<SERVER_HOST>`, `<SERVER_IP>`, `<DOMAIN>`, `<WEBHOOK_URL>` |
| Credentials | Environment-variable placeholders only |

The export uses an allowlist. Databases, logs, backups, sessions, caches, binaries, and personal memories are excluded. A local `private-overlay/` is allowed only when untracked during ordinary development verification; release verification rejects it.

Inside a Git repository, `npm run verify` scans the worktree, every tracked path (including earlier committed paths), staged content, and every recoverable Git blob. Use `--release` only for a clean export directory without `.git`. Set `SANITIZE_DENYLIST_FILE` to an external, untracked file with one real value per line. Findings report only path, rule, line, and object identity; values are never printed.
