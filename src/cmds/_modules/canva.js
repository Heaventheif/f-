"use strict";
import { validateText, validateUserId } from "../../utils/betadash.js";
import { createBetadashCommand } from "../../media/betadashCommand.js";

export const DESIGNS = [
  { name: "brat", label: "📝 Brat", text: true },
  { name: "brick-wall", label: "🧱 Brick Wall" },
  { name: "city-billboard", label: "🏙️ City Billboard" },
  { name: "night-city", label: "🌃 Night City" },
  { name: "wanted-poster", label: "🚨 Wanted Poster" },
  { name: "rainbow", label: "🌈 Rainbow" },
  { name: "beautiful", label: "✨ Beautiful" },
  { name: "calendar", label: "📅 Calendar" },
];
const designByName = new Map(DESIGNS.map((d) => [d.name, d]));

function targetId(event, args) {
  return validateUserId(
    Object.keys(event.mentions || {})[0] || event.messageReply?.senderID ||
      args.find((v) => /^\d{5,20}$/.test(v)) || event.senderID,
  );
}
export function candidates(design, value) {
  if (design.text) return [{ endpoint: design.name, params: { text: value } }];
  return [
    { endpoint: design.name, params: { userid: value } },
    ...DESIGNS.filter((d) => !d.text && d.name !== design.name).slice(0, 2).map((d) => ({ endpoint: d.name, params: { userid: value } })),
  ];
}
export const parseCanvaArgs = (args = []) => {
  const values = [...args];
  const requested = values[0]?.toLowerCase();
  if (requested === "list" || requested === "قائمة") return { list: true };
  const design = designByName.has(requested) ? requested : null;
  if (design) values.shift();
  return { design, text: values.join(" ").trim() };
};

export default createBetadashCommand({
  config: {
    name: "canva",
    aliases: ["لوحة"],
    version: "3.0.0",
    role: 0,
    countDown: 8,
    category: "ألعاب وترفيه",
    description: "توليد تصميم صورة أو نص من كتالوج Betadash مع بدائل تلقائية",
    usage: ["{pn}canva", "{pn}canva @منشن", "{pn}canva brat نص", "{pn}canva list"],
  },
  designs: DESIGNS,
  indexKey: "betadash_canva_index",
  tag: "canva",
  parseArgs: parseCanvaArgs,
  listText: `🎨 التصاميم: ${DESIGNS.map((d) => d.name).join(" · ")}\nاستخدم: canva <design> أو canva مع منشن.`,
  prepare: async ({ event, args, parsed, design }) => {
    const id = targetId(event, args);
    if (!id) return { error: "⚠️ أرسل UID صحيحاً، أو منشن الشخص، أو رد على رسالته." };
    const value = design.text ? validateText(parsed.text || "SunkenBot") : id;
    if (!value) return { error: "⚠️ اكتب نصاً قصيراً بعد اسم التصميم." };
    return { candidates: candidates(design, value) };
  },
});
