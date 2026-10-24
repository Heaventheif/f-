"use strict";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { searchImagesWithFallback, downloadImagesWithLimit } from "../../utils/pinterestProviders.js";
const BATCH_SIZE = 15;
function parseArgs(args) {
  const raw = args.join(" ").trim();
  const quotedMatch = raw.match(/["“]([^"”]+)["”]\s*(.*)$/);
  let query, rest;
  if (quotedMatch) {
    [, query, rest] = quotedMatch;
  } else {
    const parts = raw.split(/\s+/);
    const last = parts[parts.length - 1];
    if (parts.length > 1 && /^-?\d+$/.test(last)) {
      rest = last;
      query = parts.slice(0, -1).join(" ");
    } else {
      query = raw;
      rest = "";
    }
  }
  const numMatch = rest.match(/-?(\d+)/);
  const count = numMatch ? Math.min(Math.max(parseInt(numMatch[1]), 1), 20) : 5;
  return { query: query.trim(), count };
}
export default {
  config: {
    name: "pin",
    aliases: ["صور"],
    version: "3.0",
    role: 0,
    countDown: 10,
    category: "وسائط وتحميل",
    description: "بحث عن صور عالية الدقة من Pinterest (يجرّب أكثر من مزوّد تلقائياً)",
    usage: [
      "{pn}صور <كلمة البحث> <العدد> — مثال: صور cars 12",
      '{pn}صور "<كلمة البحث>" <العدد> — مثال: صور "sunset" 10',
      "{pn}صور <كلمة البحث> — بدون تحديد عدد (افتراضي 5 صور)",
    ],
  },
  onStart: async function ({ api, event, args }) {
    const { threadID, messageID } = event;
    const { query, count } = parseArgs(args);
    if (!query) {
      return api.sendMessage("❌ أدخل اسم الصورة للبحث.\nمثال: pin cars 12", threadID, null, messageID);
    }
    const tmpFiles = [];
    try {
      const images = await searchImagesWithFallback(query, count);
      const tmpDir = os.tmpdir();
      const downloaded = await downloadImagesWithLimit(images, tmpDir);
      tmpFiles.push(...downloaded);
      if (downloaded.length === 0) {
        const urls = images.map((url, i) => `${i + 1}. ${url}`).join("\n");
        return api.sendMessage(`⚠️ تعذّر تحميل أي صورة. إليك الروابط:\n\n${urls}`, threadID, null, messageID);
      }
      for (let i = 0; i < downloaded.length; i += BATCH_SIZE) {
        const batch = downloaded.slice(i, i + BATCH_SIZE);
        try {
          await api.sendMessage(
            { body: "", attachment: batch.map(f => fs.createReadStream(f)) },
            threadID
          );
        } catch (batchErr) {
          console.warn("[pin] فشل إرسال دفعة:", batchErr.message);
        }
        if (i + BATCH_SIZE < downloaded.length) await new Promise(r => setTimeout(r, 1200));
      }
    } catch (error) {
      console.error("[pin] خطأ:", error.message);
      console.error("[pin:onStart]", error.message);
      return api.sendMessage(
        `😕 لم أجد صوراً لكلمة "${query}".\n${error.message.substring(0, 150)}`,
        threadID, null, messageID
      );
    } finally {
      await Promise.allSettled(tmpFiles.map(f => fs.remove(f)));
    }
  },
};
