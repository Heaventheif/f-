const MAX_PAGE_LENGTH = 1500;
const EMOJI_RE =
  /[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\uFE0E\uFE0F\u200D]|\p{Regional_Indicator}{2}/gu;
const CATEGORY_ORDER = [
  "ذكاء اصطناعي",
  "وسائط وتحميل",
  "مانجا وروايات",
  "ثقافة وترفيه",
  "ألعاب وترفيه",
  "أدوات عامة",
  "إدارة وإشراف",
  "أخرى",
];
const CATEGORY_RENAMES = new Map([
  ["admin", "إدارة وإشراف"],
  ["وسائط", "وسائط وتحميل"],
]);
export function stripEmoji(value) {
  return String(value ?? "")
    .replace(EMOJI_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}
function normalizeCategory(value) {
  const category = stripEmoji(value) || "أخرى";
  return CATEGORY_RENAMES.get(category.toLowerCase()) || category;
}
export function getLiveCommands() {
  const map = global.commands;
  if (!(map instanceof Map) || map.size === 0) return [];
  const seen = new Map();
  for (const command of map.values()) {
    const config = command?.config;
    if (!config?.name || config.hidden || config.enabled === false) continue;
    const name = String(config.name).toLowerCase();
    if (!seen.has(name)) seen.set(name, command);
  }
  return [...seen.values()];
}
const descOf = (config) =>
  typeof config.description === "string" ? config.description : config.description?.ar || "";
export function toEntry(command) {
  const config = command?.config || {};
  return {
    role: Number(config.role) || 0,
    usage: Array.isArray(config.usage) ? config.usage : config.guide?.ar ? String(config.guide.ar).split("\n") : [],
    name: stripEmoji(config.name || ""),
    aliases: Array.isArray(config.aliases) ? config.aliases.map(stripEmoji).filter(Boolean) : [],
    desc: stripEmoji(descOf(config)),
    cat: normalizeCategory(config.category),
  };
}
function orderedCategories(groups) {
  const rank = new Map(CATEGORY_ORDER.map((category, index) => [category, index]));
  return [...groups.entries()].sort(([a], [b]) => {
    const rankA = rank.has(a) ? rank.get(a) : CATEGORY_ORDER.length;
    const rankB = rank.has(b) ? rank.get(b) : CATEGORY_ORDER.length;
    return rankA - rankB || a.localeCompare(b, "ar");
  });
}
const block = (category, commands) => `${category}\n${commands.map(({ name }) => `• ${name}`).join("\n")}`;

// Splits blocks into pages <= MAX_PAGE_LENGTH; every page title gets a "(i/n)" suffix.
export function paginateBlocks(title, subtitle, blocks, footer = "") {
  const raw = [];
  let cur = [];
  let len = title.length + subtitle.length + footer.length + 40;
  for (const b of blocks) {
    if (cur.length && len + b.length + 2 > MAX_PAGE_LENGTH) {
      raw.push(cur);
      cur = [];
      len = title.length + subtitle.length + footer.length + 40;
    }
    cur.push(b);
    len += b.length + 2;
  }
  raw.push(cur);
  const n = raw.length;
  return raw.map((bs, i) => {
    const head = `${title}${n > 1 ? ` (${i + 1}/${n})` : ""}\n${subtitle}`;
    return [head, ...bs, i === n - 1 ? footer : "تابع في الرسالة التالية."].filter(Boolean).join("\n\n");
  });
}

const effectiveRole = (role) => Math.max(0, Number(role) || 0);
const visibleTo = (entry, role) => entry.role <= effectiveRole(role);

function searchEntries(entries, query) {
  const q = query.toLowerCase();
  return entries.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.aliases.some((a) => a.toLowerCase().includes(q)) ||
      c.desc.toLowerCase().includes(q) ||
      c.cat.toLowerCase().includes(q),
  );
}

function detail(entry, prefix) {
  const lines = [`📖 ${entry.name}`];
  if (entry.aliases.length) lines.push(`البدائل: ${entry.aliases.join("، ")}`);
  lines.push(`الفئة: ${entry.cat}`);
  if (entry.desc) lines.push(entry.desc);
  if (entry.usage.length) lines.push("", "الاستخدام:", ...entry.usage.map((u) => `  ${String(u).replace(/\{pn\}/g, prefix || "")}`));
  return lines.join("\n");
}

// Pure. commands: command objects ({config}); returns an array of message pages.
// Commands above the caller's role are invisible everywhere (list, search, details).
export function buildHelp(commands, { role = 0, query = "", prefix = "" } = {}) {
  const all = commands.map(toEntry).filter((e) => e.name && visibleTo(e, role));
  if (!all.length) return ["لا توجد أوامر لعرضها حالياً."];
  const q = stripEmoji(query).toLowerCase().slice(0, 80);
  if (q) {
    const exact = all.find((e) => e.name.toLowerCase() === q || e.aliases.some((a) => a.toLowerCase() === q));
    if (exact) return [detail(exact, prefix)];
    const found = searchEntries(all, q);
    if (!found.length) return [`لا توجد نتائج لـ «${q}».`];
    const blocks = found.map((c) => `• ${c.name}\n  ${c.cat}${c.desc ? ` — ${c.desc}` : ""}`);
    return paginateBlocks(`🔎 نتائج البحث: «${q}»`, `عدد النتائج: ${found.length}`, blocks, "للتفاصيل: مساعدة <اسم الأمر>");
  }
  const groups = new Map();
  for (const e of all) {
    if (!groups.has(e.cat)) groups.set(e.cat, []);
    groups.get(e.cat).push(e);
  }
  const blocks = [];
  for (const [cat, list] of orderedCategories(groups)) {
    list.sort((a, b) => a.name.localeCompare(b.name, "ar"));
    blocks.push(block(cat, list));
  }
  return paginateBlocks("📚 قائمة الأوامر", `━━━━━━━━━━━━\nعدد الأوامر: ${all.length}`, blocks, "━━━━━━━━━━━━\nللتفاصيل: مساعدة <اسم الأمر>");
}

// The live list is cached until the command map changes (identity or size).
let _cache = { map: null, size: -1, list: [] };
export function getLiveCommands() {
  const map = global.commands;
  if (!(map instanceof Map) || map.size === 0) return [];
  if (_cache.map === map && _cache.size === map.size) return _cache.list;
  const seen = new Map();
  for (const command of map.values()) {
    const config = command?.config;
    if (!config?.name || config.hidden || config.enabled === false) continue;
    const name = String(config.name).toLowerCase();
    if (!seen.has(name)) seen.set(name, command);
  }
  _cache = { map, size: map.size, list: [...seen.values()] };
  return _cache.list;
}

export default {
  config: {
    name: "help",
    aliases: ["اوامر", "مساعدة"],
    version: "6.0.0",
    author: "Sunken",
    countDown: 3,
    role: 0,
    category: "أدوات عامة",
    description: "قائمة الأوامر حسب الفئة، مع بحث وتفاصيل أي أمر",
    usage: ["{pn}مساعدة", "{pn}مساعدة <كلمة>", "{pn}مساعدة <اسم الأمر> — طريقة الاستخدام"],
  },
  onStart: async ({ api, event, args, role, isGroupAdmin, prefix }) => {
    const effective = role >= 2 ? 2 : isGroupAdmin ? 1 : 0;
    const pages = buildHelp(getLiveCommands(), { role: effective, query: (args || []).join(" "), prefix });
    let replyTo = event.messageID || null;
    for (const page of pages) {
      const sent = await global.safeSend(api, page, event.threadID, null, replyTo);
      replyTo = sent?.messageID || replyTo;
    }
  },
};
