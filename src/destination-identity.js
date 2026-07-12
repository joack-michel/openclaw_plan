import { isRecord } from "./canonical-json.js";

export function canonicalDestinationIdentity(params = {}, ctx = {}) {
  const input = isRecord(params) ? params : {};
  const channel = String(input.channel || ctx.channelId || "").trim().toLowerCase();
  const accountId = String(input.accountId || input.account_id || ctx.accountId || "default").trim() || "default";
  const target = normalizeTarget(input.target || input.to || input.chatId || input.recipient_id || "");

  if (!channel || !target) {
    return { ok: false, reason: "destination channel or target is missing" };
  }

  if (channel === "telegram") {
    if (/^-\d+$/.test(target)) {
      return { ok: true, identity: { channel, account_id: accountId, recipient_type: "group", recipient_id: target } };
    }
    if (/^\d+$/.test(target)) {
      return { ok: true, identity: { channel, account_id: accountId, recipient_type: "user", recipient_id: target } };
    }
    return { ok: false, reason: "telegram destination must be canonical numeric id" };
  }

  return { ok: true, identity: { channel, account_id: accountId, recipient_type: "unknown", recipient_id: target } };
}

export function destinationKey(identity) {
  if (!identity) return "";
  return `${identity.channel}:${identity.account_id}:${identity.recipient_type}:${identity.recipient_id}`;
}

function normalizeTarget(value) {
  let text = String(value || "").trim();
  if (text.startsWith("telegram:")) {
    text = text.slice("telegram:".length);
  }
  return text;
}
