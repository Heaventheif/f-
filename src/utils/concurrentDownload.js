"use strict";
/**
 * تحميل مجموعة عناصر بالتوازي مع حد أقصى للتزامن.
 *
 * @param {any[]}    items    - قائمة المدخلات (روابط، معرفات، ...)
 * @param {Function} fetchFn  - دالة async تأخذ (item, index) وتُعيد النتيجة
 * @param {number}   limit    - الحد الأقصى للعمليات المتزامنة (افتراضي 6)
 * @returns {Promise<(any|null)[]>} - نفس طول items، null عند فشل أي عنصر
 */
export async function downloadWithLimit(items, fetchFn, limit = 6) {
  const results = new Array(items.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { results[i] = await fetchFn(items[i], i); }
      catch { results[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
