"use strict";
import fs from "fs-extra";
import os from "os";
import path from "path";
import http from "./fetchHttp.js";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * تنزيل صورة إلى ملف مؤقت.
 * - بدون tmpName: يُبنى الاسم من prefix + الوقت + الفهرس + امتداد الرابط.
 * - requireImage: يرفض أي رد content-type فيه ليس image/*.
 */
export async function downloadImageToTemp(url, index, { prefix = "manga", tmpName, timeout = 20000, headers, requireImage = false } = {}) {
  const target = path.join(
    os.tmpdir(),
    tmpName || `${prefix}_${Date.now()}_${index}${path.extname(url).split("?")[0] || ".jpg"}`
  );
  const res = await http.get(url, { responseType: "arraybuffer", timeout, headers });
  if (requireImage) {
    const contentType = res.headers["content-type"] || "";
    if (!contentType.startsWith("image/")) {
      throw new Error(`رد غير متوقع (${contentType}) بدل صورة من: ${url}`);
    }
  }
  await fs.writeFile(target, res.data);
  return target;
}

/** حذف مجموعة ملفات مؤقتة دون رمي أخطاء. */
export const removeFiles = (files) => Promise.allSettled(files.map((f) => fs.remove(f)));

/**
 * إرسال الصور على دفعات.
 * @param {string[]} files
 * @param {number} batchSize
 * @param {(payload, threadID, callback, replyID) => void} send
 * @param {(info:{groupNum:number,totalGroups:number,isFirst:boolean}) => string|undefined} [buildBody]
 *        إن أعاد undefined لا يُضاف body للرسالة.
 * @param {number} [delayMs]   انتظار بين الدفعات (0 = بلا انتظار)
 * @param {boolean} [stopOnError]  true: يرمي أول خطأ إرسال؛ false: يتابع ويُعيد allSent=false
 * @param {(err:Error)=>void} [onError]
 * @returns {Promise<boolean>} allSent
 */
export async function sendImageBatches({
  files, batchSize, send, threadID, replyToID = null,
  buildBody, delayMs = 0, stopOnError = false, onError,
}) {
  let allSent = true;
  const totalGroups = Math.ceil(files.length / batchSize);
  for (let i = 0; i < files.length; i += batchSize) {
    const group = files.slice(i, i + batchSize);
    const isFirst = i === 0;
    const payload = { attachment: group.map((f) => fs.createReadStream(f)) };
    const body = buildBody?.({ groupNum: Math.floor(i / batchSize) + 1, totalGroups, isFirst });
    if (body !== undefined) payload.body = body;
    try {
      await new Promise((resolve, reject) => {
        send(payload, threadID, (err) => (err ? reject(err) : resolve()), isFirst ? replyToID : null);
      });
    } catch (err) {
      if (stopOnError) throw err;
      allSent = false;
      onError?.(err);
    }
    if (delayMs && i + batchSize < files.length) await sleep(delayMs);
  }
  return allSent;
}
