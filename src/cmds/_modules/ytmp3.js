"use strict";
import { Innertube } from "youtubei.js";
import { rm } from "node:fs/promises";
import {
  getApiUrl,
  downloadYoutubeAudio,
} from "../../utils/yyApi.js";

// تُترك قابلة للتخصيص لخدمة yy المستضافة ذاتيًا؛ القيمة الافتراضية عنوان مستودع yy المنشور.
export { getApiUrl };

/** تنزيل الصوت من YouTube أو SoundCloud عبر /api/v1/audio في yy. */
export async function downloadAudio(sourceUrl, format = "mp3") {
  const media = await downloadYoutubeAudio(sourceUrl, format);
  return media.filePath;
}

let ytPromise = null;
function getYT() {
  if (!ytPromise) {
    ytPromise = Innertube.create({ lang: "en", location: "US" }).catch((err) => {
      ytPromise = null;
      throw err;
    });
  }
  return ytPromise;
}

/** البحث في YouTube Music وإرجاع نتائج بالشكل الذي تستخدمه song.js. */
export async function search(query, limit = 1) {
  const yt = await getYT();
  const res = await yt.music.search(String(query || "").trim(), { type: "song" });
  const items = (res.songs?.contents ?? []).filter((item) => item?.id);
  if (!items.length) throw new Error("no_results");
  return items.slice(0, limit).map((item) => ({
    id: item.id,
    videoId: item.id,
    title: item.title || "",
    artists: (item.artists || []).map((artist) => artist.name).join(", "),
    duration: item.duration?.seconds ?? null,
    thumbnail: item.thumbnails?.[0]?.url ?? null,
  }));
}

/** تحميل أغنية YouTube Music (الـ API يقبل رابط YouTube القياسي). */
export async function download(videoId) {
  if (!/^[\w-]{11}$/.test(String(videoId || ""))) {
    throw new Error("معرّف فيديو غير صالح");
  }
  const media = await downloadYoutubeAudio(`https://music.youtube.com/watch?v=${videoId}`, "m4a");
  return media.filePath;
}

export default {
  config: {
    name: "ytmp3",
    version: "1.0.0",
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
    const query = (args || []).join(" ").trim();
    if (!query) return message.reply("الاستخدام: ytmp3 <اسم الأغنية أو رابط YouTube/SoundCloud>");

    let filePath = null;
    try {
      getApiUrl();
      let sourceUrl = query;
      if (!/^https?:\/\//i.test(query)) {
        const [first] = await search(query, 1);
        if (!first?.videoId) throw new Error("لم أجد نتيجة بحث.");
        sourceUrl = `https://www.youtube.com/watch?v=${first.videoId}`;
      }
      filePath = await downloadAudio(sourceUrl, "mp3");
      await global.mediaSendFile(api, filePath, event.threadID, event.messageID);
    } catch (error) {
      console.error("[ytmp3]", error?.message || error);
      await message.reply(`❌ تعذّر تنزيل الصوت: ${String(error?.message || "خطأ غير معروف").slice(0, 220)}`);
    } finally {
      if (filePath) await rm(filePath, { force: true }).catch(() => {});
    }
  },
};
