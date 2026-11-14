"use strict";

export function buildListText(results, wantMp4) {
  let text = `${wantMp4 ? "🎬" : "🎵"} نتائج البحث:\n${"─".repeat(22)}\n`;
  results.forEach((v, i) => {
    text += `${i + 1}. ${v.title}\n   ⏱ ${v.duration || "--"}${v.uploader ? `  📺 ${v.uploader}` : ""}\n${"─".repeat(22)}\n`;
  });
  text += "رُد على هذه الرسالة برقم النتيجة (mp4 + رقم للفيديو)\n⏳ تنتهي بعد دقيقتين";
  return text;
}
