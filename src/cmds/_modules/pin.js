"use strict";
import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import { searchImagesWithFallback, downloadImagesWithLimit } from "../../utils/pinterestProviders.js";

const BATCH_SIZE = 5;

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

function formatSourceLinks(sourceUrls) {
  return sourceUrls.map((url, index) => `${index + 1}. ${url}`).join("\n");
}

function closeStreams(streams) {
  return Promise.all(streams.map(stream => new Promise(resolve => {
    if (stream.closed) return resolve();
    stream.once("close", resolve);
    stream.once("error", () => {});
    stream.destroy();
  })));
}

function openImageStream(file) {
  const stream = createReadStream(file);
  stream.once("error", () => {});
  return stream;
}

export async function sendImageBatches(api, threadID, files, sourceUrls, {
  batchSize = BATCH_SIZE,
  pauseMs = 1200,
} = {}) {
  const failures = [];
  let sent = 0;

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const streams = batch.map(openImageStream);
    try {
      await api.sendMessage({ body: "", attachment: streams }, threadID);
      sent += batch.length;
      await closeStreams(streams);
    } catch (batchError) {
      await closeStreams(streams);
      console.warn("[pin] فشل إرسال دفعة؛ ستُجرّب الصور منفردة:", batchError?.message || batchError);

      for (const file of batch) {
        const stream = openImageStream(file);
        try {
          await api.sendMessage({ body: "", attachment: stream }, threadID);
          sent++;
          await closeStreams([stream]);
        } catch (error) {
          await closeStreams([stream]);
          failures.push({ file, error });
          console.warn("[pin] فشل إرسال صورة منفردة:", error?.message || error);
        }
      }
    }

    if (i + batchSize < files.length && pauseMs > 0) {
      await new Promise(resolve => setTimeout(resolve, pauseMs));
    }
  }

  if (failures.length > 0) {
    const links = formatSourceLinks(sourceUrls);
    const status = `⚠️ تم تنزيل ${files.length} صورة وإرسال ${sent}، لكن تعذّر رفع ${failures.length} إلى Facebook. روابط المصدر:\n\n${links || "لا توجد روابط مصدر متاحة."}`;
    try {
      await api.sendMessage(status, threadID);
    } catch (error) {
      console.error("[pin] تعذر إرسال إشعار فشل الرفع:", error?.message || error);
    }
  }

  return { sent, failures };
}

export default {
  config: {
    name: "pin",
    aliases: ["صور"],
    version: "3.1",
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
      const downloaded = await downloadImagesWithLimit(images, os.tmpdir());
      tmpFiles.push(...downloaded);
      if (downloaded.length === 0) {
        const urls = formatSourceLinks(images);
        return api.sendMessage(`⚠️ تعذّر تحميل أي صورة. إليك الروابط:\n\n${urls}`, threadID, null, messageID);
      }
      await sendImageBatches(api, threadID, downloaded, images);
    } catch (error) {
      console.error("[pin] خطأ:", error.message);
      console.error("[pin:onStart]", error.message);
      return api.sendMessage(`😕 لم أجد صوراً لكلمة "${query}".\n${error.message.substring(0, 150)}`, threadID, null, messageID);
    } finally {
      await Promise.allSettled(tmpFiles.map(file => rm(file, { force: true })));
    }
  },
};
