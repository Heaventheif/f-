"use strict";
import fs from "fs-extra";
import https from "https";
import http from "http";
import { splitFile, cleanupParts, NEEDS_SPLIT } from "./mediaSplitter.js";
import { assertSafeUrl } from "./fetchHttp.js";
import { directSend, directSendParts } from "./send.js";
import { streamToTempFile } from "./mediaFile.js";
// Hard cap: abort downloads that exceed this size to avoid OOM / disk exhaustion.
// Facebook Messenger's max attachment is 25 MB; 200 MB covers legitimate large videos.
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

async function fetchStream(url, redirectCount = 0) {
  // SSRF guard on every URL, including redirect destinations.
  // Prevents a malicious CDN redirect chain from reaching internal cloud metadata.
  await assertSafeUrl(url);
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("تجاوز الحد الأقصى لإعادة التوجيه"));
    const isHttps = url.startsWith("https");
    const lib = isHttps ? https : http;
    lib.get(url, { timeout: 120000 }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode === 301 || statusCode === 302 || statusCode === 307 || statusCode === 308) {
        res.resume(); 
        const location = headers.location;
        if (!location) return reject(new Error("إعادة توجيه بدون Location header"));
        return fetchStream(location, redirectCount + 1).then(resolve).catch(reject);
      }
      if (statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${statusCode} من الخادم`));
      }
      resolve({ stream: res, contentLength: parseInt(headers["content-length"] || "0", 10) });
    }).on("error", reject)
      .on("timeout", function() { this.destroy(new Error("انتهت مهلة الاتصال")); });
  });
}
async function downloadToTemp(url, ext = "mp4") {
  const { stream, contentLength } = await fetchStream(url);

  // Reject before writing anything if Content-Length already exceeds the cap.
  if (contentLength > 0 && contentLength > MAX_DOWNLOAD_BYTES) {
    stream.resume(); // drain socket
    throw new Error(`حجم الملف (${Math.round(contentLength / 1024 / 1024)}MB) يتجاوز الحد المسموح (${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)}MB)`);
  }

  const media = await streamToTempFile(stream, {
    prefix: "media",
    ext,
    totalBytes: contentLength || null,
    maxBytes: MAX_DOWNLOAD_BYTES,
  });
  return { tmpPath: media.filePath, size: media.bytes, contentLength };
}
async function streamAndSend(api, threadID, mediaUrl, title, ext = "mp4", replyToID = undefined) {
  let tmpPath;
  let partPaths = [];
  try {
    const { tmpPath: downloaded, size } = await downloadToTemp(mediaUrl, ext);
    tmpPath = downloaded;
    console.log(`[MEDIA_STREAM] تم تحميل ${Math.round(size / 1024 / 1024 * 10) / 10}MB (${ext})`);
    if (NEEDS_SPLIT(size)) {
      partPaths = await splitFile(tmpPath, ext);
      const streams = partPaths.map(p => ({
        stream: fs.createReadStream(p),
        reopen: () => fs.createReadStream(p),
      }));
      const { sent } = await directSendParts(api, threadID, title, streams, replyToID);
      return sent > 0;
    } else {
      const ok = await directSend(
        api,
        threadID,
        { attachment: fs.createReadStream(tmpPath) },
        replyToID
      );
      return ok;
    }
  } catch (e) {
    console.error("[MEDIA_STREAM] خطأ:", e.message?.substring(0, 200));
    if (e.code === "FILE_TOO_LARGE") {
      await global.safeSend(api, `⚠️ ${e.message}`, threadID, null, replyToID).catch(() => {});
      return true; 
    }
    return false;
  } finally {
    if (tmpPath) fs.remove(tmpPath).catch(() => {});
    if (partPaths.length > 0) cleanupParts(partPaths).catch(() => {});
  }
}
export { streamAndSend, downloadToTemp, fetchStream };
