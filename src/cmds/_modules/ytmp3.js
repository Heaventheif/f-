"use strict";
import { withTempDir } from "../../io/tmp.js";
import { getApiUrl } from "../../utils/yyApi.js";
import {
  normalizeYtResults, searchYt, fetchAudioFile, ytMusicUrl, assertDuration, audioErrorText,
  isAllowedAudioUrl,
} from "../../media/audioSource.js";
import { reply } from "../../media/common.js";

export { getApiUrl };
export const normalizeSearchResults = normalizeYtResults;
export const search = searchYt;
export const downloadAudio = (sourceUrl, format = "mp3", opts = {}) => fetchAudioFile(sourceUrl, { ...opts, format });
export const download = (videoId, opts = {}) => fetchAudioFile(ytMusicUrl(videoId), { ...opts, format: "m4a" });

// Pure: decide the source URL for a query (URL must be allow-listed; text is searched).
export function classifyQuery(query) {
  const q = String(query || "").trim();
  if (!q) return { kind: "empty" };
  if (/^https?:\/\//i.test(q)) return isAllowedAudioUrl(q) ? { kind: "url", url: q } : { kind: "blocked" };
  return { kind: "search", query: q };
}

export default {
  config: {
    name: "ytmp3",
    version: "2.0.0",
    role: 0,
    countDown: 4,
    category: "وسائط وتحميل",
    description: "تحميل صوت MP3 من YouTube أو رابط صوتي عبر yy",
    usage: [
      "{pn}ytmp3 <اسم الأغنية> — البحث وتنزيل أول نتيجة كـMP3",
      "{pn}ytmp3 <رابط YouTube أو SoundCloud> — تنزيل الصوت",
    ],
  },
  onStart: async ({ api, message, args, event }) => {
    const { threadID, messageID } = event;
    const q = classifyQuery((args || []).join(" "));
    if (q.kind === "empty") return message.reply("الاستخدام: ytmp3 <اسم الأغنية أو رابط YouTube/SoundCloud>");
    if (q.kind === "blocked") return message.reply(audioErrorText({ code: "blocked_url" }));
    try {
      getApiUrl();
      let sourceUrl = q.url;
      if (q.kind === "search") {
        const [first] = await searchYt(q.query, 1);
        assertDuration(first.duration);
        sourceUrl = first.url;
      }
      await withTempDir(async (dir) => {
        const filePath = await fetchAudioFile(sourceUrl, { dir, format: "mp3" });
        await global.mediaSendFile(api, filePath, threadID, messageID);
      }, "ytmp3");
    } catch (error) {
      console.error("[ytmp3]", error?.code || "", String(error?.message || error).slice(0, 200));
      await reply(api, threadID, audioErrorText(error), messageID);
    }
  },
};
