import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_DB_PATH = `${homedir()}/.openclaw/state/approval-delivery-dedupe.sqlite`;

// Keep the existing at-most-once policy: a claimed delivery is never reclaimed
// on a timeout or restart. A crashed/failed sender may already have delivered
// its card. Only a valid transport receipt can promote CLAIMED to SENT.
export class ApprovalDeliveryDedupe {
  constructor(dbPath = DEFAULT_DB_PATH) { this.dbPath = dbPath; this.db = null; }

  open() {
    if (this.db) return;
    mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.dbPath);
    chmodSync(this.dbPath, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS approval_delivery_dedupe (
        approval_id TEXT NOT NULL, channel TEXT NOT NULL, chat_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'CLAIMED', created_at INTEGER NOT NULL, sent_at INTEGER,
        message_id TEXT, delivered_chat_id TEXT, updated_at INTEGER, failure_code TEXT,
        PRIMARY KEY (approval_id, channel, chat_id)
      );`);
    const columns = new Set(this.db.prepare("PRAGMA table_info(approval_delivery_dedupe)").all().map((row) => row.name));
    for (const [name, type] of Object.entries({ message_id: "TEXT", delivered_chat_id: "TEXT", updated_at: "INTEGER", failure_code: "TEXT" })) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE approval_delivery_dedupe ADD COLUMN ${name} ${type}`);
    }
  }

  claim({ approvalId, channel, chatId, now = Date.now() }) {
    if (!validIdentity(approvalId, channel, chatId)) return false;
    this.open();
    return this.db.prepare(`
      INSERT INTO approval_delivery_dedupe (approval_id, channel, chat_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(approval_id, channel, chat_id) DO NOTHING
    `).run(approvalId, channel, String(chatId), now, now).changes === 1;
  }

  markSent({ approvalId, channel, chatId, messageId, deliveredChatId, now = Date.now() }) {
    if (!validIdentity(approvalId, channel, chatId)) return false;
    this.open();
    return this.db.prepare(`
      UPDATE approval_delivery_dedupe SET status = 'SENT', sent_at = ?, updated_at = ?,
        message_id = ?, delivered_chat_id = ?, failure_code = NULL
      WHERE approval_id = ? AND channel = ? AND chat_id = ? AND status = 'CLAIMED'
    `).run(now, now, messageId == null ? null : String(messageId), deliveredChatId == null ? null : String(deliveredChatId), approvalId, channel, String(chatId)).changes === 1;
  }

  markUncertain({ approvalId, channel, chatId, now = Date.now() }) {
    if (!validIdentity(approvalId, channel, chatId)) return false;
    this.open();
    return this.db.prepare(`
      UPDATE approval_delivery_dedupe SET status = 'UNCERTAIN', updated_at = ?, failure_code = 'DELIVERY_UNCERTAIN'
      WHERE approval_id = ? AND channel = ? AND chat_id = ? AND status = 'CLAIMED'
    `).run(now, approvalId, channel, String(chatId)).changes === 1;
  }

  get({ approvalId, channel, chatId }) {
    if (!validIdentity(approvalId, channel, chatId)) return null;
    this.open();
    return this.db.prepare("SELECT * FROM approval_delivery_dedupe WHERE approval_id = ? AND channel = ? AND chat_id = ?").get(approvalId, channel, String(chatId)) || null;
  }

  close() { this.db?.close(); this.db = null; }
}
function validIdentity(approvalId, channel, chatId) {
  return typeof approvalId === "string" && Boolean(approvalId.trim()) && approvalId === approvalId.trim()
    && typeof channel === "string" && Boolean(channel.trim())
    && ((typeof chatId === "string" && Boolean(chatId.trim())) || (typeof chatId === "number" && Number.isSafeInteger(chatId)));
}
const defaultStore = new ApprovalDeliveryDedupe();
export function claimTelegramApprovalDelivery(input) { return defaultStore.claim({ ...input, channel: "telegram" }); }
export function markTelegramApprovalDeliverySent(input) { return defaultStore.markSent({ ...input, channel: "telegram" }); }
export function markTelegramApprovalDeliveryUncertain(input) { return defaultStore.markUncertain({ ...input, channel: "telegram" }); }
