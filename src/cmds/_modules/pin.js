"use strict";
import { createReadStream } from "node:fs";
import { withTempDir } from "../../io/tmp.js";
import {
  searchImagesWithFallback,
  downloadImagesWithLimit,
} from "../../utils/pinterestProviders.js";
import { sendImageBatches as deliverImageBatches } from "../../utils/mangaDelivery.js";
const BATCH_SIZE = 5;
// "cars 12" | '"red cars" 12' | "cars" | "12 cars" (count only counts when it is a standalone number).
export function parseArgs(args) {
  const raw = (Array.isArray(args) ? args.join(" ") : String(args || "")).trim();
  const clamp = (n) => Math.min(Math.max(n, 1), 20);
  let query = raw;
  let count = 5;
  const quoted = raw.match(/^["“]([^"”]+)["”]\s*(-?\d+)?\s*$/);
  if (quoted) {
    query = quoted[1];
    if (quoted[2]) count = clamp(Math.abs(parseInt(quoted[2], 10)));
  } else {
    const parts = raw.split(/\s+/);
    const last = parts[parts.length - 1];
    if (parts.length > 1 && /^\d{1,3}$/.test(last)) {
      count = clamp(parseInt(last, 10));
      query = parts.slice(0, -1).join(" ");
    }
  }
  return { query: query.trim().slice(0, 100), count };
}
function formatSourceLinks(sourceUrls) {
  return sourceUrls.map((url, index) => `${index + 1}. ${url}`).join("\n");
}
function closeStreams(streams) {
  return Promise.all(
    streams.map(
      (stream) =>
        new Promise((resolve) => {
          if (stream.closed) return resolve();
          stream.once("close", resolve);
          stream.once("error", () => {});
          stream.destroy();
        }),
    ),
  );
}
function openImageStream(file) {
  const stream = createReadStream(file);
  stream.once("error", () => {});
  return stream;
}
export async function sendImageBatches(
  api,
  threadID,
  files,
  sourceUrls,
  { batchSize = BATCH_SIZE, pauseMs = 1200 } = {},
) {
  const failures = [];
  let sent = 0;
  let cursor = 0;
  await deliverImageBatches({
    files,
    batchSize,
    threadID,
    delayMs: pauseMs,
    buildBody: () => "",
    send: async (payload, tid, done) => {
      const streams = payload.attachment;
      streams.forEach((stream) => stream.once?.("error", () => {}));
      const batch = files.slice(cursor, cursor + streams.length);
      cursor += streams.length;
      try {
        await api.sendMessage(payload, tid);
        sent += batch.length;
        await closeStreams(streams);
      } catch (batchError) {
        await closeStreams(streams);
        console.warn(
          "[pin] فشل إرسال دفعة؛ ستُجرّب الصور منفردة:",
          batchError?.message || batchError,
        );
        for (const file of batch) {
          const stream = openImageStream(file);
          try {
            await api.sendMessage({ body: "", attachment: stream }, tid);
            sent++;
            await closeStreams([stream]);
          } catch (error) {
            await closeStreams([stream]);
            failures.push({ file, error });
            console.warn("[pin] فشل إرسال صورة منفردة:", error?.message || error);
          }
        }
      } finally {
        done();
      }
    },
  });
  if (failures.length > 0) {
    const links = formatSourceLinks(sourceUrls);
    const status = `⚠️ تم تنزيل ${files.length} صورة وإرسال ${sent}، لكن تعذّر رفع ${failures.length} إلى Facebook. روابط المصدر:

${links || "لا توجد روابط مصدر متاحة."}`;
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
    if (!query) return api.sendMessage("❌ أدخل اسم الصورة للبحث.\nمثال: pin cars 12", threadID, null, messageID);
    // search failure and send failure are reported separately
    let images;
    try {
      images = await searchImagesWithFallback(query, count);
    } catch (error) {
      console.error("[pin:search]", error.errors || error.message);
      return api.sendMessage(`😕 لم أجد صوراً لكلمة "${query}".`, threadID, null, messageID);
    }
    try {
      await withTempDir(async (dir) => {
        const downloaded = await downloadImagesWithLimit(images, dir);
        if (downloaded.length === 0) {
          await api.sendMessage(`⚠️ تعذّر تحميل أي صورة. إليك الروابط:\n\n${formatSourceLinks(images)}`, threadID, null, messageID);
          return;
        }
        await sendImageBatches(api, threadID, downloaded, images);
      }, "pin");
    } catch (error) {
      console.error("[pin:send]", error?.message || error);
      await api.sendMessage(`⚠️ وجدت الصور لكن تعذّر إرسالها. الروابط:\n\n${formatSourceLinks(images)}`, threadID, null, messageID).catch(() => {});
    }
  },
};
