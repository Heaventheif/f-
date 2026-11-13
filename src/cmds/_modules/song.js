"use strict";
import { withTempDir } from "../../io/tmp.js";
import { fetchJson, fetchText } from "../../net/safeFetch.js";
import { AppError } from "../../infra/errors.js";
import { SingleFlight } from "../../infra/limiter.js";
import { getApiUrl } from "../../utils/yyApi.js";
import {
  searchYt, fetchAudioFile, ytMusicUrl, assertAudioUrl, withinDuration, fmtDuration, audioErrorText,
} from "../../media/audioSource.js";
import { reply, unsendQuiet } from "../../media/common.js";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};
const SC_HOSTS = ["soundcloud.com", "sndcdn.com"];
const TRACK_EMOJIS = ["👍", "❤️", "😆", "😮", "😢", "😡", "🥰", "🤩"];
const LIST_SIZE = 7;
const LIST_TTL_MS = 12e4;
const CLIENT_ID_TTL_MS = 60 * 60 * 1e3;
const HELP =
  "🎵 موسيقى\n\nsong <اسم الأغنية>      — تشغيل أول نتيجة\nsong s <اسم الأغنية>    — عرض قائمة للاختيار\n(أو موسيقى بدل song)\n\nيبحث في SoundCloud أولاً، وإن لم يجد\nيستخدم بحث YouTube كاحتياطي.\n\nمثال:\nsong after the dark mr kitty\nsong s mr kitty";

const isStale = (err) => [401, 403, 404].includes(err?.status);
let _clientId = null;
let _clientExp = 0;
const clientFlight = new SingleFlight();

async function fetchClientId() {
  const page = await fetchText("https://soundcloud.com", { headers: BROWSER_HEADERS, timeoutMs: 15e3, allowHosts: SC_HOSTS });
  const scriptUrls = [...page.matchAll(/https:\/\/a-v2\.sndcdn\.com\/[^"]+\.js/g)].map((m) => m[0]);
  if (!scriptUrls.length) throw new AppError("upstream", "لم تُوجد سكريبتات SoundCloud");
  for (const url of scriptUrls.slice(-8).reverse()) {
    try {
      const text = await fetchText(url, { headers: BROWSER_HEADERS, timeoutMs: 1e4, allowHosts: SC_HOSTS, maxBytes: 4 * 1024 * 1024 });
      const match =
        text.match(/[{,]client_id:"([a-zA-Z0-9]{20,40})"/) ||
        text.match(/"client_id"\s*:\s*"([a-zA-Z0-9]{20,40})"/) ||
        text.match(/client_id\s*=\s*"([a-zA-Z0-9]{20,40})"/);
      if (match) return match[1];
    } catch (e) {
      console.warn("[SONG] client_id bundle:", String(e?.message || e).slice(0, 80));
    }
  }
  throw new AppError("upstream", "فشل استخراج client_id من SoundCloud");
}
async function getClientId(forceRefresh = false) {
  if (!forceRefresh && _clientId && Date.now() < _clientExp) return _clientId;
  return clientFlight.run("id", async () => {
    const id = await fetchClientId();
    _clientId = id;
    _clientExp = Date.now() + CLIENT_ID_TTL_MS;
    return id;
  });
}

// Normalised track: { title, artist, durationSec, url, videoId? }. SoundCloud durations are milliseconds.
export function normalizeScTrack(t) {
  const ms = t.full_duration || t.duration;
  return {
    title: t.title || "بدون عنوان",
    artist: t.user?.username || "",
    durationSec: Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : null,
    url: t.permalink_url,
  };
}
export const normalizeYtTrack = (t) => ({
  title: t.title || "بدون عنوان", artist: t.artist || "", durationSec: t.duration, url: t.url, videoId: t.videoId,
});

async function searchSC(query, limit) {
  const doSearch = async (forceRefresh) => {
    const client_id = await getClientId(forceRefresh);
    const u = new URL("https://api-v2.soundcloud.com/search/tracks");
    for (const [k, v] of Object.entries({
      q: query, client_id, limit: limit * 3, offset: 0, linked_partitioning: 1,
      app_version: process.env.SC_APP_VERSION || "1733219585", app_locale: "en",
    })) u.searchParams.set(k, String(v));
    const data = await fetchJson(u.href, { headers: BROWSER_HEADERS, timeoutMs: 15e3, allowHosts: SC_HOSTS });
    const all = (data?.collection || []).filter((t) => t?.permalink_url);
    const playable = all.filter((t) => t.access !== "preview" && t.access !== "blocked" && t.policy !== "SNIP" && t.policy !== "BLOCK");
    const tracks = (playable.length ? playable : all).map(normalizeScTrack).filter((t) => withinDuration(t.durationSec)).slice(0, limit);
    if (!tracks.length) throw new AppError("not_found", "no_results");
    return tracks;
  };
  try {
    return await doSearch(false);
  } catch (err) {
    if (isStale(err)) return doSearch(true);
    throw err;
  }
}

// SoundCloud first; any non-"no results" SoundCloud failure is logged and reported via `scError`.
export async function searchTracks(query, limit, { sc = searchSC, yt = searchYt } = {}) {
  let scError = null;
  try {
    return { source: "sc", tracks: await sc(query, limit), scError };
  } catch (err) {
    scError = err;
    if (err?.code !== "not_found") console.warn("[SONG] SoundCloud failed:", err?.code || "", String(err?.message).slice(0, 120));
  }
  const found = (await yt(query, limit)).filter((t) => withinDuration(t.duration));
  if (!found.length) throw new AppError("too_large", "all_over_duration", { meta: { reason: "duration" } });
  return { source: "yt", tracks: found.map(normalizeYtTrack), scError };
}

async function sendTrack(api, threadID, messageID, track, source, listMsgId = null) {
  await withTempDir(async (dir) => {
    let filePath;
    if (source === "sc") {
      assertAudioUrl(track.url);
      try {
        filePath = await fetchAudioFile(track.url, { dir, format: "mp3" });
      } catch (err) {
        console.error("[SONG] SoundCloud download failed:", err?.code || "", String(err?.message).slice(0, 120));
        // A YouTube match may be a different upload: say so instead of silently swapping the song.
        const [yt] = await searchYt(`${track.title} ${track.artist}`.trim(), 1).catch(() => []);
        if (!yt?.videoId || !withinDuration(yt.duration)) throw err;
        await reply(api, threadID, `⚠️ تعذّر التحميل من SoundCloud؛ سأرسل أقرب نتيجة من YouTube بدلًا منه:\n${yt.title}${yt.artist ? ` — ${yt.artist}` : ""}`, messageID);
        filePath = await fetchAudioFile(ytMusicUrl(yt.videoId), { dir, format: "m4a" });
      }
    } else {
      filePath = await fetchAudioFile(ytMusicUrl(track.videoId), { dir, format: "m4a" });
    }
    await global.mediaSendFile(api, filePath, threadID, messageID);
  }, "song");
  await unsendQuiet(api, listMsgId);
}

export function renderTrackList(list, source) {
  const line = "─".repeat(22);
  const srcName = source === "sc" ? "SoundCloud" : "YouTube";
  let text = `🎵 نتائج البحث في ${srcName}:\n${line}\n`;
  list.slice(0, TRACK_EMOJIS.length).forEach((t, i) => {
    const d = fmtDuration(t.durationSec);
    text += `${TRACK_EMOJIS[i]} ${t.title}\n   👤 ${t.artist} ${d ? `⏱ ${d}` : ""}\n${line}\n`;
  });
  return text + "تفاعل بالإيموجي لاختيار الأغنية\n⏳ تنتهي بعد دقيقتين";
}

async function showTrackList(api, event, list, source, notice) {
  const { threadID, messageID } = event;
  list = list.slice(0, TRACK_EMOJIS.length);
  const text = (notice ? `${notice}\n` : "") + renderTrackList(list, source);
  const sent = await new Promise((res, rej) =>
    global.safeSend(api, text, threadID, (err, info) => (err ? rej(err) : res(info)), messageID));
  const listeners = global.client?.reactionListener;
  if (!sent?.messageID || !listeners) return;
  const timer = setTimeout(() => delete listeners[sent.messageID], LIST_TTL_MS);
  timer.unref?.();
  listeners[sent.messageID] = {
    threadID: String(threadID),
    cmdKey: "song",
    author: event.senderID,
    callback: async ({ api: api2, event: re }) => {
      const idx = TRACK_EMOJIS.indexOf(re.reaction);
      if (idx === -1 || idx >= list.length) return;
      clearTimeout(timer);
      delete listeners[sent.messageID];
      try {
        await sendTrack(api2, threadID, messageID, list[idx], source, sent.messageID);
      } catch (err) {
        console.error("[music] خطأ:", err?.code || "", String(err?.message).slice(0, 200));
        await reply(api2, threadID, audioErrorText(err), messageID);
      }
    },
  };
}

export default {
  config: {
    name: "song",
    aliases: ["موسيقى"],
    version: "4.0.0",
    role: 0,
    countDown: 0,
    category: "وسائط وتحميل",
    description: "بحث وتشغيل مقاطع — SoundCloud أولاً، وYouTube احتياطيًا عبر yt-search",
    usage: [
      "{pn}song <اسم> — تشغيل أول نتيجة مباشرة",
      "{pn}song s <اسم> — عرض قائمة نتائج للاختيار",
      "{pn}موسيقى <اسم> — نفس الأمر بالعربية",
    ],
  },
  onStart: async ({ api, message, args, event }) => {
    const { threadID, messageID } = event;
    if (!args[0]) return message.reply(HELP);
    const showList = args[0].toLowerCase() === "s";
    const query = (showList ? args.slice(1) : args).join(" ").trim();
    if (!query) return message.reply("❌ أرسل اسم الأغنية.");
    try {
      getApiUrl();
      const { source, tracks, scError } = await searchTracks(query, showList ? LIST_SIZE : 1);
      const notice = source === "yt" && scError && scError.code !== "not_found" ? "ℹ️ SoundCloud غير متاح حاليًا، النتائج من YouTube." : "";
      if (showList) await showTrackList(api, event, tracks, source, notice);
      else {
        if (notice) await reply(api, threadID, notice, messageID);
        await sendTrack(api, threadID, messageID, tracks[0], source);
      }
    } catch (err) {
      console.error("[music] خطأ:", err?.code || "", String(err?.message).slice(0, 200));
      await reply(api, threadID, err?.code === "not_found" ? "❌ لم تُوجد نتائج على SoundCloud أو YouTube." : audioErrorText(err), messageID);
    }
  },
};
