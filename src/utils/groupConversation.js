const NAME_CACHE_TTL = 6 * 60 * 60 * 1000;
const NAME_CACHE_MAX = 2000;
const nameCache = new Map();

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
  nameCache.set(String(senderID), { name, at: Date.now() });
  if (nameCache.size > NAME_CACHE_MAX) {
    const oldestKey = nameCache.keys().next().value;
    if (oldestKey) nameCache.delete(oldestKey);
  }
}

function fetchUserInfo(api, senderID) {
  if (!api?.getUserInfo || !senderID) return Promise.resolve(null);
  return new Promise(resolve => {
    let settled = false;
    let timer = null;
    const finish = value => {
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
      } else if (result && typeof result === "object" && (
        result[senderID] || result.user || result.name || result.fullName || result.displayName
      )) {
        finish(result);
      }
    } catch (_) {
      finish(null);
    }
  });
}

export async function resolveGroupUsername(api, event) {
  const senderID = String(event?.senderID || "").trim();
  const eventName = event?.senderName || event?.userName || event?.username || event?.displayName || event?.name;
  if (eventName && String(eventName).trim() !== senderID) {
    const name = sanitizeGroupName(eventName);
    rememberName(senderID, name);
    return name;
  }

  const cached = senderID ? nameCache.get(senderID) : null;
  if (cached && Date.now() - cached.at < NAME_CACHE_TTL) return cached.name;

  const info = await fetchUserInfo(api, senderID);
  const item = info?.[senderID] || info?.[String(senderID)] || info?.user || info || {};
  const apiName = item?.name || item?.fullName || item?.displayName || item?.firstName;
  if (apiName && String(apiName).trim() !== senderID) {
    const name = sanitizeGroupName(apiName);
    rememberName(senderID, name);
    return name;
  }

  const fallback = senderID ? `عضو ${senderID.slice(-4)}` : "عضو";
  const name = sanitizeGroupName(fallback);
  rememberName(senderID, name);
  return name;
}

export function formatGroupTurn(username, content) {
  const speaker = sanitizeGroupName(username);
  const text = String(content || "").trim() || "[رسالة فارغة]";
  return `[${speaker}]: ${text}`;
}

function normalizeStoredUserTurn(turn) {
  const content = String(turn?.content || "").trim();
  const tagged = content.match(/^\[([^\]]{1,40})\]:\s*([\s\S]*)$/);
  const username = turn?.username || turn?.senderName || tagged?.[1] || "عضو سابق";
  const text = tagged && (!turn?.username && !turn?.senderName || tagged[1] === username)
    ? tagged[2]
    : content;
  return formatGroupTurn(username, text);
}

export function formatThreadHistory(history, limit = 12) {
  if (!Array.isArray(history)) return "";
  const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
  const selected = safeLimit ? history.slice(-safeLimit) : [];
  return selected.map(turn => {
    const content = String(turn?.content || "").trim();
    if (!content) return "";
    if (turn?.role === "assistant") return `البوت: ${content}`;
    return normalizeStoredUserTurn(turn);
  }).filter(Boolean).join("\n");
}

export function buildGroupPrompt(history, username, currentText, limit = 12) {
  const transcript = formatThreadHistory(history, limit);
  const sections = [
    "أنت مساعد داخل محادثة جماعية. الرسائل السابقة والحالية موسومة باسم أصحابها؛ حافظ على هذا التفريق، واستخدم سياق المجموعة عند متابعة النقاش، ولا تنسب كلام عضو إلى عضو آخر.",
  ];
  if (transcript) sections.push(`سياق المجموعة السابق:\n${transcript}`);
  sections.push(`الرسالة الحالية:\n${formatGroupTurn(username, currentText)}`);
  return sections.join("\n\n");
}
