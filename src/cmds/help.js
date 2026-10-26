
const MAX_PAGE_LENGTH = 1500;
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\uFE0E\uFE0F\u200D]|\p{Regional_Indicator}{2}/gu;
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
  return String(value ?? "").replace(EMOJI_RE, "").replace(/\s+/g, " ").trim();
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

export function toEntry(command) {
  const config = command?.config || {};
  return {
    name: stripEmoji(config.name || ""),
    aliases: Array.isArray(config.aliases) ? config.aliases.map(stripEmoji).filter(Boolean) : [],
    desc: stripEmoji(config.description || ""),
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

function categoryBlocks(category, commands) {
  // Keep each command on its own short line for comfortable reading in Messenger.
  return [`${category}\n${commands.map(({ name }) => `• ${name}`).join("\n")}`];
}

function paginateBlocks(header, blocks, footer = "") {
  const pages = [];
  let current = header;
  for (const block of blocks) {
    const extra = `\n\n${block}`;
    const footerLength = footer ? footer.length + 2 : 0;
    if (current.length + extra.length + footerLength > MAX_PAGE_LENGTH && current !== header) {
      pages.push(`${current}\n\nتابع في الرسالة التالية.`);
      current = header;
    }
    current += extra;
  }
  pages.push(footer ? `${current}\n\n${footer}` : current);
  return pages;
}

export function buildPages(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const category = normalizeCategory(entry.cat);
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push({ name: stripEmoji(entry.name) });
  }

  const blocks = [];
  for (const [category, commands] of orderedCategories(groups)) {
    commands.sort((a, b) => a.name.localeCompare(b.name, "ar"));
    blocks.push(...categoryBlocks(category, commands));
  }
  return paginateBlocks(`📚 قائمة الأوامر\n━━━━━━━━━━━━\nعدد الأوامر: ${entries.length}`, blocks, "━━━━━━━━━━━━\nللبحث: مساعدة <اسم الأمر>");
}

function searchEntries(entries, query) {
  return entries.filter((command) =>
    command.name.toLowerCase().includes(query) ||
    command.aliases.some((alias) => alias.toLowerCase().includes(query)) ||
    command.desc.toLowerCase().includes(query) ||
    command.cat.toLowerCase().includes(query),
  );
}

function send(api, text, threadID, replyToID) {
  const safeSend = typeof global.safeSend === "function" ? global.safeSend : null;
  if (safeSend) return safeSend(api, text, threadID, null, replyToID);
  return api.sendMessage(text, threadID, replyToID).catch((error) => {
    console.error("[help] " + error.message);
    return null;
  });
}

export default {
  config: {
    name: "help",
    aliases: ["اوامر", "مساعدة"],
    version: "5.0.0",
    author: "Sunken",
    countDown: 3,
    role: 0,
    category: "أدوات عامة",
    description: "قائمة مختصرة للأوامر مرتبة حسب الفئة، مع بحث بالاسم أو البديل",
    usage: ["{pn}مساعدة", "{pn}مساعدة <كلمة>"],
  },
  onStart: async ({ api, event, args }) => {
    const entries = getLiveCommands().map(toEntry);
    if (!entries.length) {
      await send(api, "لا توجد أوامر لعرضها حالياً.", event.threadID, event.messageID);
      return;
    }

    const query = stripEmoji((args || []).join(" ")).toLowerCase().slice(0, 80);
    if (query) {
      const results = searchEntries(entries, query);
      if (!results.length) {
        await send(api, `لا توجد نتائج لـ «${query}».`, event.threadID, event.messageID);
        return;
      }
      const blocks = results.map((command) => `• ${command.name}\n  ${command.cat}${command.desc ? ` — ${command.desc}` : ""}`);
      const pages = paginateBlocks(`🔎 نتائج البحث: «${query}»\nعدد النتائج: ${results.length}`, blocks, "للبحث عن أمر آخر: مساعدة <كلمة>");
      let replyToID = event.messageID || null;
      for (const page of pages) {
        const result = await send(api, page, event.threadID, replyToID);
        replyToID = result?.messageID || null;
      }
      return;
    }

    const pages = buildPages(entries);
    let replyToID = event.messageID || null;
    for (const page of pages) {
      const result = await send(api, page, event.threadID, replyToID);
      replyToID = result?.messageID || null;
    }
  },
};
