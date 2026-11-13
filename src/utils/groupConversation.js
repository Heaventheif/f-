import { getStore } from "../state/kv.js";
import { LRU } from "../infra/lru.js";

const NAME_CACHE_TTL = 6 * 60 * 60 * 1e3;
const nameCache = new LRU({ maxEntries: 2000, maxBytes: 2 * 1024 * 1024, ttlMs: NAME_CACHE_TTL });
let _ns = null;
export function _useNamespace(ns) {
  _ns = ns;
}
async function ns() {
  return (_ns ??= (await getStore()).ns("group_names", { ttlMs: NAME_CACHE_TTL }));
}
async function cachedName(id) {
  const hit = nameCache.get(id);
  if (hit) return hit.name;
  try {
    const e = await (await ns()).get(id);
    if (e?.name) {
      nameCache.set(id, e);
      return e.name;
    }
  } catch {}
  return null;
}

export function sanitizeGroupName(value, fallback = "عضو") {
  const clean = String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[\[\]{}<>`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return clean || fallback;
}
function rememberName(senderID, name) {
  if (!senderID || !name) return;
  const id = String(senderID);
  const prev = nameCache.get(id);
  nameCache.set(id, { name });
  if (!prev || prev.name !== name)
    ns()
      .then((n) => n.set(id, { name }))
      .catch((e) => console.warn("[NAMES] save failed:", e?.message));
}
function fetchUserInfo(api, senderID) {
  if (!api?.getUserInfo || !senderID) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value || null);
    };
    timer = setTimeout(() => finish(null), 2500);
    try {
      const result = api.getUserInfo(senderID, (error, data) => finish(error ? null : data));
      if (result && typeof result.then === "function") {
        result.then(finish, () => finish(null));
      } else if (
        result &&
        typeof result === "object" &&
        (result[senderID] || result.user || result.name || result.fullName || result.displayName)
      ) {
        finish(result);
      }
    } catch (_) {
      finish(null);
    }
  });
}
export async function resolveGroupUsername(api, event) {
  const senderID = String(event?.senderID || "").trim();
  const eventName =
    event?.senderName || event?.userName || event?.username || event?.displayName || event?.name;
  if (eventName && String(eventName).trim() !== senderID) {
    const name2 = sanitizeGroupName(eventName);
    rememberName(senderID, name2);
    return name2;
  }
  const cached = senderID ? await cachedName(senderID) : null;
  if (cached) return cached;
  const info = await fetchUserInfo(api, senderID);
  const item = info?.[senderID] || info?.[String(senderID)] || info?.user || info || {};
  const apiName = item?.name || item?.fullName || item?.displayName || item?.firstName;
  if (apiName && String(apiName).trim() !== senderID) {
    const name2 = sanitizeGroupName(apiName);
    rememberName(senderID, name2);
    return name2;
  }
  const fallback = senderID ? `عضو ${senderID.slice(-4)}` : "عضو";
  const name = sanitizeGroupName(fallback);
  rememberName(senderID, name);
  return name;
}
// Lines in user text that look like speaker tags ("[Name]: ..." or "البوت: ...")
// are defanged so a member cannot impersonate someone else in the transcript.
function neutralizeTags(text) {
  return text
    .replace(/^([ \t]*)\[([^\]\n]{1,40})\](\s*:)/gm, "$1‹$2›$3")
    .replace(/^([ \t]*)(البوت)(\s*:)/gm, "$1«$2»$3");
}
export function formatGroupTurn(username, content) {
  const speaker = sanitizeGroupName(username);
  const text = neutralizeTags(String(content || "").trim()) || "[رسالة فارغة]";
  return `[${speaker}]: ${text}`;
}
function normalizeStoredUserTurn(turn) {
  const content = String(turn?.content || "").trim();
  const tagged = content.match(/^\[([^\]]{1,40})\]:\s*([\s\S]*)$/);
  const username = turn?.username || turn?.senderName || tagged?.[1] || "عضو سابق";
  const text =
    tagged && ((!turn?.username && !turn?.senderName) || tagged[1] === username)
      ? tagged[2]
      : content;
  return formatGroupTurn(username, text);
}
export function formatThreadHistory(history, limit = 12) {
  if (!Array.isArray(history)) return "";
  const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
  const selected = safeLimit ? history.slice(-safeLimit) : [];
  return selected
    .map((turn) => {
      const content = String(turn?.content || "").trim();
      if (!content) return "";
      if (turn?.role === "assistant") return `البوت: ${content}`;
      return normalizeStoredUserTurn(turn);
    })
    .filter(Boolean)
    .join("\n");
}
export function buildGroupPrompt(history, username, currentText, limit = 12) {
  const transcript = formatThreadHistory(history, limit);
  const sections = [
    "أنت مساعد داخل محادثة جماعية. الرسائل السابقة والحالية موسومة باسم أصحابها؛ حافظ على هذا التفريق، واستخدم سياق المجموعة عند متابعة النقاش، ولا تنسب كلام عضو إلى عضو آخر.",
  ];
  if (transcript)
    sections.push(`سياق المجموعة السابق:
${transcript}`);
  sections.push(`الرسالة الحالية:
${formatGroupTurn(username, currentText)}`);
  return sections.join("\n\n");
}
