"use strict";

export const EMOJI_PAIRS = [
  ["👍", "❤️"], ["😆", "😮"], ["😢", "😡"], ["🥰", "👏"], ["🤩", "😘"],
  ["😍", "😭"], ["🤔", "😅"], ["😁", "🥹"], ["🥸", "😎"], ["🙂", "😇"],
];

const norm = e => String(e ?? "").replace(/[\uFE0E\uFE0F]/g, "");

export function attachReactionPicker({ sentMessageID, authorID, list, onPick, threadID = null, commandName = null, cmdKey = null, ttlMs = 120000 }) {
  if (!sentMessageID || !global.client?.reactionListener) return;
  let timer = null;
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    delete global.client.reactionListener[sentMessageID];
    if (global.Kagenou?.replies) delete global.Kagenou.replies[sentMessageID];
  };
  global.client.reactionListener[sentMessageID] = {
    author: authorID == null ? null : String(authorID),
    threadID: threadID == null ? null : String(threadID),
    cmdKey: String(cmdKey ?? commandName ?? "").trim().toLowerCase() || null,
    callback: async ({ event: reactionEvent }) => {
      const reaction = reactionEvent?.reaction ?? reactionEvent?.reactionEmoji ?? reactionEvent?.emoji;
      const r = norm(reaction);
      const idx = EMOJI_PAIRS.findIndex(([primary, alternate]) => r === norm(primary) || r === norm(alternate));
      if (idx < 0) console.log("[REACT:IGNORED]", JSON.stringify(reaction));
      if (idx < 0 || idx >= list.length) return;
      const alternateChosen = r === norm(EMOJI_PAIRS[idx][1]);
      cleanup();
      await onPick(list[idx], alternateChosen);
    },
  };
  timer = setTimeout(cleanup, ttlMs);
  timer.unref?.();
}

export function buildListText(results, wantMp4) {
  let text = `${wantMp4 ? "🎬" : "🎵"} نتائج البحث:\n${"─".repeat(22)}\n`;
  results.forEach((v, i) => {
    text += `${i + 1}. ${v.title}\n   ⏱ ${v.duration || "--"}${v.uploader ? `  📺 ${v.uploader}` : ""}\n${"─".repeat(22)}\n`;
  });
  text += "رُد على هذه الرسالة برقم النتيجة (mp4 + رقم للفيديو)\n⏳ تنتهي بعد دقيقتين";
  return text;
}
