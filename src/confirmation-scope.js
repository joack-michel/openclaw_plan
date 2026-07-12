import { sha256Hex, stableStringify } from "./canonical-json.js";

export function buildConfirmationScope(event = {}, ctx = {}) {
  const sessionKey = firstString(ctx.sessionKey, event.sessionKey);
  const agentId = firstString(ctx.agentId, event.agentId, agentFromSessionKey(sessionKey));
  const channelId = normalizeChannelId(firstString(ctx.channelId, event.channelId, ctx.chatId, event.chatId, event.to));
  const provider = normalizeProvider(firstString(ctx.messageProvider, ctx.channel, event.messageProvider, event.channel, providerFromSessionKey(sessionKey)));
  const accountId = firstString(ctx.accountId, event.accountId);
  const actorId = normalizeActorId(firstString(ctx.senderId, event.senderId, ctx.actorId, event.actorId, telegramActorFallback(provider, channelId)));
  return { sessionKey, agentId, provider, channelId, accountId, actorId };
}

export function buildConfirmationScopeKey(event = {}, ctx = {}) {
  return sha256Hex(stableStringify(buildConfirmationScope(event, ctx)));
}

function normalizeChannelId(value) {
  return String(value || "").trim().replace(/^(telegram|discord|slack):/i, "");
}

function normalizeActorId(value) {
  return String(value || "").trim().replace(/^(telegram|discord|slack):/i, "");
}

function normalizeProvider(value) {
  return String(value || "").trim().toLowerCase();
}

function providerFromSessionKey(sessionKey) {
  const match = /:(telegram|discord|slack):/.exec(sessionKey);
  return match?.[1] || "";
}

function agentFromSessionKey(sessionKey) {
  const match = /^agent:([^:]+):/.exec(sessionKey);
  return match?.[1] || "";
}

function telegramActorFallback(provider, channelId) {
  return provider === "telegram" ? channelId : "";
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return "";
}

