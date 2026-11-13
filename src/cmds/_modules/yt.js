"use strict";
import fs from "../../utils/fsCompat.js";
import { withTempDir } from "../../io/tmp.js";
import { downloadYoutubeAudio, downloadYoutubeVideo } from "../../utils/yyApi.js";
import { buildListText } from "../../utils/reactionPicker.js";
import { splitFile, NEEDS_SPLIT } from "../../utils/mediaSplitter.js";
import {
  searchYt, assertAudioUrl, assertDuration, withinDuration, fmtDuration, audioErrorText, MAX_AUDIO_BYTES,
} from "../../media/audioSource.js";
import { reply, unsendQuiet } from "../../media/common.js";

const HELP = "yt <اسم> | yt s <اسم> للقائمة | أضف mp4 للفيديو";
const MAX_VIDEO_BYTES = 150 * 1024 * 1024;
const LIST_TTL_MS = 2 * 60_000;

// Pure: "mp4 3" / "3" -> { index, mp4 } (index is 0-based, -1 if not a pick).
export function parsePick(text, size) {
  const m = String(text || "").trim().toLowerCase().match(/^(?:(mp4)\s*)?(\d{1,2})$/);
  const index = m ? Number(m[2]) - 1 : -1;
  return index >= 0 && index < size ? { index, mp4: Boolean(m[1]) } : { index: -1, mp4: false };
}

async function downloadAndSend(api, threadID, messageID, ytUrl, wantMp4, listMsgId = null) {
  try {
    assertAudioUrl(ytUrl);
    await withTempDir(async (dir) => {
      const media = wantMp4
        ? await downloadYoutubeVideo(ytUrl, 360, { dir, maxBytes: MAX_VIDEO_BYTES })
        : await downloadYoutubeAudio(ytUrl, "mp3", { dir, maxBytes: MAX_AUDIO_BYTES });
      const { size } = await fs.stat(media.filePath);
      const files = NEEDS_SPLIT(size) ? await splitFile(media.filePath, wantMp4 ? "mp4" : "mp3", { dir }) : [media.filePath];
      for (const file of files) await global.mediaSendFile(api, file, threadID, messageID);
    }, "yt");
    await unsendQuiet(api, listMsgId);
  } catch (error) {
    console.error("[YT:ERR]", error?.code || "", String(error?.message || error).slice(0, 200));
    await reply(api, threadID, audioErrorText(error), messageID);
  }
}

function registerNumericReply(sent, event, list, threadID, messageID, api) {
  if (!sent?.messageID || !global.Kagenou?.replies) return;
  const sentID = String(sent.messageID);
  const entry = {
    author: event.senderID == null ? null : String(event.senderID),
    threadID: String(threadID),
    cmdKey: "yt",
    timestamp: Date.now(),
    callback: async ({ event: replyEvent }) => {
      const pick = parsePick(replyEvent?.body, list.length);
      if (pick.index < 0) {
        // keep the list alive: router deletes the entry before calling us
        global.Kagenou.replies[sentID] = entry;
        return;
      }
      clearTimeout(timer);
      await downloadAndSend(api, threadID, messageID, list[pick.index].url, pick.mp4, sent.messageID);
    },
  };
  const timer = setTimeout(() => { if (global.Kagenou.replies[sentID] === entry) delete global.Kagenou.replies[sentID]; }, LIST_TTL_MS);
  timer.unref?.();
  global.Kagenou.replies[sentID] = entry;
}

export default {
  config: {
    name: "yt",
    aliases: ["يوتيوب"],
    version: "2.0.0",
    role: 0,
    countDown: 0,
    category: "وسائط وتحميل",
    description: "تحميل YouTube مع قائمة اختيار دقيقة",
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
      // keep only clips within the duration cap (unknown duration passes)
      const found = (await searchYt(query, 10)).filter((i) => withinDuration(i.duration));
      if (!found.length) {
        return reply(api, threadID, "⏱ كل النتائج أطول من 10 دقائق.", messageID);
      }
      if (!showList) {
        assertDuration(found[0].duration);
        return downloadAndSend(api, threadID, messageID, found[0].url, wantMp4);
      }
      const list = found.map((i) => ({ ...i, uploader: i.artist, duration: fmtDuration(i.duration) }));
      const sent = await new Promise((resolve, reject) =>
        global.safeSend(api, buildListText(list, wantMp4), threadID, (e, info) => (e ? reject(e) : resolve(info)), messageID));
      registerNumericReply(sent, event, list, threadID, messageID, api);
    } catch (error) {
      console.error("[YT:ERR]", error?.code || "", String(error?.message || error).slice(0, 200));
      await reply(api, threadID, error?.code === "not_found" || error?.message === "no_results" ? "لم أجد نتائج مناسبة." : audioErrorText(error), messageID);
    }
  },
};
