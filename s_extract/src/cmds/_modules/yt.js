"use strict";
import fs from "../../utils/fsCompat.js";
import { searchYoutube } from "../../utils/youtubeSearch.js";
import { downloadYoutubeAudio, downloadYoutubeVideo } from "../../utils/yyApi.js";
import { removeTempFile } from "../../utils/mediaFile.js";
import { buildListText } from "../../utils/reactionPicker.js";
import { splitFile, cleanupParts, NEEDS_SPLIT } from "../../utils/mediaSplitter.js";

const HELP = "yt <اسم> | yt s <اسم> للقائمة | أضف mp4 للفيديو";

function durationText(item) {
  return item?.duration?.timestamp || item?.timestamp || item?.duration?.seconds || item?.seconds || item?.duration || "";
}
function authorText(item) {
  return typeof item?.author === "string" ? item.author : item?.author?.name || item?.channel?.name || item?.channel || "";
}
async function search(query, limit = 10) {
  const result = await searchYoutube(query);
  if (!result?.status || !Array.isArray(result.results)) throw new Error("لا توجد نتائج");
  const seen = new Set();
  return result.results
    .filter(item => item && (item.type == null || item.type === "video") && /^[\w-]{11}$/.test(String(item.videoId || "")))
    .map(item => ({
      videoId: String(item.videoId),
      url: item.url || `https://www.youtube.com/watch?v=${item.videoId}`,
      title: item.title || item.name || "YouTube video",
      duration: durationText(item),
      uploader: authorText(item),
    }))
    .filter(item => !seen.has(item.videoId) && seen.add(item.videoId))
    .slice(0, Math.max(1, Math.min(10, limit)));
}

async function downloadAndSend(api, threadID, messageID, ytUrl, wantMp4, listMsgId = null) {
  let filePath = null;
  let partPaths = [];
  try {
    const media = wantMp4 ? await downloadYoutubeVideo(ytUrl, 360) : await downloadYoutubeAudio(ytUrl, "mp3");
    filePath = media.filePath;
    const { size } = await fs.stat(filePath);
    const files = NEEDS_SPLIT(size) ? (partPaths = await splitFile(filePath, wantMp4 ? "mp4" : "mp3")) : [filePath];
    for (const file of files) await global.mediaSendFile(api, file, threadID, messageID);
    if (listMsgId) await api.unsendMessage(listMsgId).catch(() => {});
  } catch (error) {
    console.error("[YT:ERR]", error?.message || error);
    await global.safeSend(api, "تعذّر تحميل الملف.", threadID, null, messageID).catch(() => {});
  } finally {
    if (partPaths.length) await cleanupParts(partPaths);
    if (filePath) await removeTempFile(filePath);
  }
}

function registerNumericReply(sent, event, list, threadID, messageID, api, commandName = "yt") {
  if (!sent?.messageID || !global.Kagenou?.replies) return;
  const sentID = String(sent.messageID);
  const entry = {
    author: event.senderID == null ? null : String(event.senderID),
    threadID: String(threadID),
    cmdKey: commandName,
    timestamp: Date.now(),
    callback: async ({ event: replyEvent }) => {
      const text = String(replyEvent?.body || "").trim().toLowerCase();
      const match = text.match(/^(?:(mp4)\s*)?(\d{1,2})$/);
      const index = match ? Number(match[2]) - 1 : -1;
      if (index < 0 || index >= list.length) {
        // keep the list alive: router deletes the entry before calling us
        global.Kagenou.replies[sentID] = entry;
        return;
      }
      await downloadAndSend(api, threadID, messageID, list[index].url, Boolean(match[1]), sent.messageID);
    },
  };
  global.Kagenou.replies[sentID] = entry;
}

export default {
  config: {
    name: "yt", aliases: ["يوتيوب"], version: "1.1.0", role: 0, countDown: 0,
    category: "وسائط وتحميل", description: "تحميل YouTube مع قائمة اختيار دقيقة",
    usage: ["{pn}yt <اسم>", "{pn}yt s <اسم>", "{pn}yt mp4 <اسم>", "{pn}yt <رابط>"],
  },
  onStart: async ({ api, message, args, event }) => {
    const { threadID, messageID } = event;
    if (!args[0]) return message.reply(HELP);
    const rest = [...args];
    let showList = false;
    let wantMp4 = false;
    while (rest.length) {
      const word = rest[0].toLowerCase();
      if (word === "s" && !showList) showList = true;
      else if (word === "mp4" && !wantMp4) wantMp4 = true;
      else break;
      rest.shift();
    }
    const query = rest.join(" ").trim();
    if (!query) return message.reply(HELP);
    if (/^https?:\/\//i.test(query)) return downloadAndSend(api, threadID, messageID, query, wantMp4);
    try {
      const list = await search(query, showList ? 10 : 1);
      if (!showList) {
        // yt-search already orders by relevance; never choose the shortest video.
        return downloadAndSend(api, threadID, messageID, list[0].url, wantMp4);
      }
      const sent = await new Promise((resolve, reject) => {
        global.safeSend(api, buildListText(list, wantMp4), threadID, (error, info) => error ? reject(error) : resolve(info), messageID);
      });
      registerNumericReply(sent, event, list, threadID, messageID, api);
    } catch (error) {
      console.error("[YT:ERR]", error?.message || error);
      await global.safeSend(api, "لم أجد نتائج مناسبة.", threadID, null, messageID).catch(() => {});
    }
  },
};
