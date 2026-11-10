"use strict";

export const EMOJI_PAIRS = [
  ["👍", "❤️"], ["😆", "😮"], ["😢", "😡"], ["🥰", "👏"], ["🤩", "😘"],
  ["😍", "😭"], ["🤔", "😅"], ["😁", "🥹"], ["🥸", "😎"], ["🙂", "😇"],
];

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
      const idx = EMOJI_PAIRS.findIndex(([primary, alternate]) => reaction === primary || reaction === alternate);
      if (idx < 0 || idx >= list.length) return;
      const alternateChosen = reaction === EMOJI_PAIRS[idx][1];
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
    const [mp3Emoji, mp4Emoji] = EMOJI_PAIRS[i];
    text += `${i + 1}. ${v.title}\n   ⏱ ${v.duration || "--"}${v.uploader ? `  📺 ${v.uploader}` : ""}\n   ${mp3Emoji} mp3  |  ${mp4Emoji} mp4\n${"─".repeat(22)}\n`;
  });
  text += "تفاعل بالإيموجي أو أرسل رقم النتيجة للتحميل\n⏳ تنتهي بعد دقيقتين";
  return text;
}
