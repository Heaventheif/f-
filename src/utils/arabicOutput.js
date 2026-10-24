import { translateTextStrict } from "./translator.js";

export function hasArabicText(value) {
  const text = String(value || "");
  const letters = text.match(/[\p{L}\p{N}]/gu) || [];
  const arabic = text.match(/[\u0600-\u06FF]/g) || [];
  return arabic.length > 0 && (letters.length === 0 || arabic.length / letters.length >= 0.18);
}

export async function toArabicOutput(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("لا يوجد محتوى لترجمته.");
  if (hasArabicText(text)) return text;
  const translated = await translateTextStrict(text, "ar");
  if (!translated || !hasArabicText(translated)) {
    throw new Error("تعذرت ترجمة المحتوى إلى العربية حالياً.");
  }
  return translated.trim();
}

export async function toArabicOutputBatch(values) {
  const inputs = values.map(value => String(value || "").trim());
  if (!inputs.length || inputs.some(value => !value)) {
    throw new Error("توجد قيمة فارغة ضمن المحتوى المطلوب ترجمته.");
  }
  if (inputs.every(hasArabicText)) return inputs;

  const bundle = inputs.map((value, index) => `[[F${index}]] ${value}`).join("\n");
  const translated = await translateTextStrict(bundle, "ar");
  if (translated) {
    const pattern = /\[\[F(\d+)\]\]\s*([\s\S]*?)(?=\n\s*\[\[F\d+\]\]|$)/g;
    const parsed = new Map();
    for (const match of translated.matchAll(pattern)) {
      parsed.set(Number(match[1]), match[2].trim());
    }
    const output = inputs.map((original, index) => parsed.get(index) || (hasArabicText(original) ? original : ""));
    if (output.every(hasArabicText)) return output;
  }

  return Promise.all(inputs.map(value => toArabicOutput(value)));
}
