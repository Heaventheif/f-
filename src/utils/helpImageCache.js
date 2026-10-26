import fs from "fs-extra";
import path from "node:path";
import crypto from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import { fileURLToPath } from "node:url";

const CACHE_DIR = path.resolve(process.cwd(), "data", "cache", "help");
const IMAGE_PATH = path.join(CACHE_DIR, "commands.png");
const META_PATH = path.join(CACHE_DIR, "commands.json");
const ARABIC_FONT_PATH = fileURLToPath(new URL("../assets/fonts/arabic-basseet.ttf", import.meta.url));
const ENGLISH_FONT_PATH = fileURLToPath(new URL("../assets/fonts/english-the-life.otf", import.meta.url));
const ARABIC_FONT = "Basseet-Free";
const ENGLISH_FONT = "The Life";
let buildPromise = null;
let buildFingerprint = null;

function escapeXml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[char]);
}

function stableEntries(entries) {
  return entries.map((entry) => ({
    name: String(entry.name || "").trim(),
    aliases: [...(entry.aliases || [])].map(String).sort((a, b) => a.localeCompare(b, "ar")),
    desc: String(entry.desc || "").trim(),
    cat: String(entry.cat || "أخرى").trim(),
  })).sort((a, b) => a.cat.localeCompare(b.cat, "ar") || a.name.localeCompare(b.name, "ar"));
}

function fontFor(value) {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/u.test(String(value)) ? ARABIC_FONT : ENGLISH_FONT;
}

function makeSvg(entries) {
  const width = 1100;
  const margin = 54;
  const cardWidth = width - margin * 2;
  const lineHeight = 42;
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.cat)) groups.set(entry.cat, []);
    groups.get(entry.cat).push(entry);
  }

  const blocks = [];
  let y = 205;
  for (const [category, commands] of groups) {
    const rows = [];
    for (let i = 0; i < commands.length; i += 3) rows.push(commands.slice(i, i + 3));
    const cardHeight = 76 + rows.length * lineHeight;
    blocks.push(`<rect x="${margin}" y="${y}" width="${cardWidth}" height="${cardHeight}" rx="24" fill="#151d31" stroke="#33415f" stroke-width="2"/>`);
    blocks.push(`<text x="${width - margin - 24}" y="${y + 48}" text-anchor="end" direction="rtl" unicode-bidi="plaintext" font-family="${ARABIC_FONT}" font-size="29" font-weight="700" fill="#7dd3fc">${escapeXml(category)}</text>`);
    let rowY = y + 98;
    for (const row of rows) {
      const cellWidth = (cardWidth - 48) / 3;
      row.forEach((command, index) => {
        const x = margin + 24 + index * cellWidth + cellWidth / 2;
        blocks.push(`<text x="${x}" y="${rowY}" text-anchor="middle" direction="rtl" unicode-bidi="plaintext" font-family="${fontFor(command.name)}" font-size="23" fill="#f8fafc">${escapeXml(command.name)}</text>`);
      });
      rowY += lineHeight;
    }
    y += cardHeight + 22;
  }
  const footerY = y + 12;
  const height = footerY + 72;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#090e1b"/><stop offset="100%" stop-color="#17233d"/></linearGradient><linearGradient id="accent" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#a78bfa"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#bg)"/><rect x="${margin}" y="42" width="${cardWidth}" height="8" rx="4" fill="url(#accent)"/>
    <text x="${width / 2}" y="112" text-anchor="middle" direction="rtl" unicode-bidi="plaintext" font-family="${ARABIC_FONT}" font-size="48" font-weight="800" fill="#ffffff">قائمة الأوامر</text>
    <text x="${width / 2}" y="157" text-anchor="middle" direction="rtl" unicode-bidi="plaintext" font-family="${ARABIC_FONT}" font-size="22" fill="#a9b7d0">${entries.length} أمرًا متاحًا • اكتب «مساعدة كلمة» للبحث</text>
    ${blocks.join("\n")}
    <text x="${width / 2}" y="${footerY + 38}" text-anchor="middle" font-family="${ENGLISH_FONT}" font-size="19" fill="#9baac4">SUNKE N • COMMAND CENTER</text>
  </svg>`;
}

export async function getHelpImage(entries) {
  const normalized = stableEntries(entries);
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  await fs.ensureDir(CACHE_DIR);

  try {
    const meta = await fs.readJson(META_PATH);
    const stat = await fs.stat(IMAGE_PATH);
    if (meta.fingerprint === fingerprint && stat.size > 0) return IMAGE_PATH;
  } catch (_) {}

  if (buildPromise && buildFingerprint !== fingerprint) {
    await buildPromise.catch(() => {});
    return getHelpImage(normalized);
  }
  if (!buildPromise) {
    buildFingerprint = fingerprint;
    buildPromise = (async () => {
      const svg = makeSvg(normalized);
      const tempPath = path.join(CACHE_DIR, `commands-${process.pid}-${Date.now()}.tmp.png`);
      try {
        const renderer = new Resvg(svg, {
          font: {
            fontFiles: [ARABIC_FONT_PATH, ENGLISH_FONT_PATH],
            loadSystemFonts: false,
            defaultFontFamily: ARABIC_FONT,
          },
          fitTo: { mode: "original" },
        });
        await fs.writeFile(tempPath, renderer.render().asPng());
        await fs.move(tempPath, IMAGE_PATH, { overwrite: true });
        await fs.writeJson(META_PATH, { fingerprint, count: normalized.length, updatedAt: new Date().toISOString() }, { spaces: 2 });
        return IMAGE_PATH;
      } finally {
        await fs.remove(tempPath).catch(() => {});
      }
    })().finally(() => { buildPromise = null; buildFingerprint = null; });
  }
  return buildPromise;
}
