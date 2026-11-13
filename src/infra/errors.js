// Typed errors: control flow uses `code`, never message text.
export class AppError extends Error {
  constructor(code, message, { cause, status, retryable = false, meta } = {}) {
    super(message || code, cause ? { cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.meta = meta;
  }
}
export const isCode = (e, ...codes) => e instanceof AppError && codes.includes(e.code);
// Arabic user-facing messages live in ONE table.
export const USER_MESSAGES = {
  too_large: "الملف كبير جدًا.",
  timeout: "انتهت المهلة، حاول مجددًا.",
  blocked_url: "هذا الرابط غير مسموح.",
  not_found: "لم أجد نتائج.",
  upstream: "الخدمة الخارجية لا تستجيب حاليًا.",
  rate_limited: "طلبات كثيرة، انتظر قليلًا.",
  bad_args: "صيغة الأمر غير صحيحة.",
};
export const userMessage = (e) => USER_MESSAGES[e?.code] || "حدث خطأ غير متوقع.";
