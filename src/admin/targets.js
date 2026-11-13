// Target resolution for admin commands (mentions, reply target, raw ids).
const ID_RE = /^\d{6,}$/;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Removes mention names (multi-word, with or without "@") from text; longest names first
// so "@Ali Hassan" is not half-eaten by a mention of "Ali".
export function stripMentions(text, mentions) {
  let out = String(text ?? "");
  const names = Object.values(mentions || {})
    .map((n) => String(n ?? "").trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const n of names) {
    const bare = n.replace(/^@/, "");
    out = out.replace(new RegExp(`@?${escapeRe(bare)}`), " ");
  }
  return out.replace(/\s+/g, " ").trim();
}

// -> { ids: string[], names: Map<id,string>, text: string, via: "mention"|"id"|"reply"|"none" }
// `text` is the argument text with mentions and id tokens removed (e.g. a new nickname).
export function resolveTargets(event, args = []) {
  const mentions = event?.mentions || {};
  const names = new Map();
  const ids = [];
  const add = (id) => {
    const s = String(id ?? "").trim();
    if (s && !ids.includes(s)) ids.push(s);
  };
  for (const [id, n] of Object.entries(mentions)) {
    add(id);
    const clean = String(n ?? "").replace(/^@/, "").trim();
    if (clean) names.set(String(id), clean);
  }
  const idArgs = (args || []).map(String).filter((a) => ID_RE.test(a));
  for (const a of idArgs) add(a);
  let via = Object.keys(mentions).length ? "mention" : idArgs.length ? "id" : "none";
  if (!ids.length) {
    const replyID = event?.messageReply?.senderID ?? event?.messageReply?.author;
    if (replyID) {
      add(replyID);
      via = "reply";
    }
  }
  const joined = (args || []).map(String).filter((a) => !ID_RE.test(a)).join(" ");
  const text = stripMentions(joined, mentions);
  return { ids, names, text, via };
}

function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error("timeout")), ms)))]).finally(() => clearTimeout(t));
}

// Resolves display names for ids: known (mention) names first, then one batched getUserInfo.
export async function displayNames(api, ids, known = new Map()) {
  const out = new Map(known);
  const need = ids.filter((id) => !out.get(id));
  if (need.length && typeof api?.getUserInfo === "function") {
    try {
      const info = (await withTimeout(Promise.resolve(api.getUserInfo(need)), 5000)) || {};
      for (const id of need) {
        const it = info[id] || {};
        const n = it.name || it.fullName || it.displayName || it.firstName;
        if (n) out.set(id, String(n));
      }
    } catch (e) {
      console.warn("[ADMIN] getUserInfo failed:", e?.message);
    }
  }
  return (id) => out.get(String(id)) || String(id);
}

export function botId(api) {
  try {
    return String(api?.getCurrentUserID?.() ?? "");
  } catch {
    return "";
  }
}
export function protectedIds(api) {
  const set = new Set([...(global.config?.developers || []), ...(global.config?.admins || [])].map(String));
  const me = botId(api);
  if (me) set.add(me);
  return set;
}

// Pure: splits targets into allowed / refused for a kick.
export function planKick(ids, { botID = "", protectedSet = new Set(), threadAdmins = [], senderID = "" }) {
  const admins = new Set(threadAdmins.map(String));
  const allowed = [];
  const refused = [];
  for (const id of ids) {
    if (id === String(senderID)) refused.push({ id, reason: "self" });
    else if (id === botID) refused.push({ id, reason: "bot" });
    else if (protectedSet.has(id)) refused.push({ id, reason: "protected" });
    else if (admins.has(id)) refused.push({ id, reason: "admin" });
    else allowed.push(id);
  }
  return { allowed, refused };
}
export const REFUSE_TEXT = {
  self: "لا يمكنك تنفيذ ذلك على نفسك",
  bot: "لا يمكن تنفيذ ذلك على البوت",
  protected: "هذا الحساب محمي (مطوّر/مشرف البوت)",
  admin: "هذا مشرف في المجموعة؛ أزل إشرافه أولاً",
};
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
