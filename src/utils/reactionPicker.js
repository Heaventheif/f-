"use strict";
export const EMOJI_PAIRS = [
  ["👍", "❤️"], ["😆", "😮"], ["😢", "😡"],
  ["🥰", "👏"], ["🤩", "😘"], ["😍", "😭"],
  ["🤔", "😅"], ["😁", "🥹"], ["🥸", "😎"], ["🙂", "😇"],
];
export function attachReactionPicker({ sentMessageID, authorID, list, onPick, ttlMs = 120000 }) {
  if (!sentMessageID || !global.client?.reactionListener) return;
  let timer = null;
  const cleanup = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    delete global.client.reactionListener[sentMessageID];
    if (global.Kagenou?.replies) delete global.Kagenou.replies[sentMessageID];
  };
  global.client.reactionListener[sentMessageID] = {
    author: authorID,
    callback: async ({ event: reactionEvent }) => {
      const reaction = reactionEvent.reaction;
      const idx = EMOJI_PAIRS.findIndex(([primary, alt]) => reaction === primary || reaction === alt);
      if (idx < 0 || idx >= list.length) return;
      const altChosen = reaction === EMOJI_PAIRS[idx][1];
      cleanup();
      await onPick(list[idx], altChosen);
    },
  };
  timer = setTimeout(cleanup, ttlMs);
  timer.unref?.();
}
export function buildListText(results, wantMp4) {
  let text = `${wantMp4 ? "🎬" : "🎵"} نتائج البحث:\n${"─".repeat(22)}\n`;
  results.forEach((v, i) => {
    const [mp3E, mp4E] = EMOJI_PAIRS[i];
    text +=
      `${i + 1}. ${v.title}\n` +
      `   ⏱ ${v.duration || "--"}${v.uploader ? `  📺 ${v.uploader}` : ""}\n` +
      `   ${mp3E} mp3  |  ${mp4E} mp4\n` +
      `${"─".repeat(22)}\n`;
  });
  text += `تفاعل بالإيموجي لاختيار الأغنية\n⏳ تنتهي بعد دقيقتين`;
  return text;
}

// ─── Plugin Descriptor ──────────────────────────────────────────
/** @type {import('../plugin-provider.js').XxPlugin} */
export const $plugin = {
  name: 'xx-utils-reaction-picker',
  meta: { category: 'utils', path: 'src/utils/reactionPicker.js' },
  setup(_ctx) {
    // provides: EMOJI_PAIRS, attachReactionPicker, buildListText
  },
};
