/**
 * rustBridge.js — جسر FFI بين Bun و libsunken (Rust).
 *
 * الفلسفة: Rust طبقة تسريع اختيارية. لا شيء هنا يجب أن يوقف البوت.
 *   - فشل التحميل  → isRustAvailable() === false → المستدعون يستخدمون JS.
 *   - فشل استدعاء  → callRust يرمي → المستدعي يلتقط، يطبع console.warn، ويستخدم JS.
 *
 * ── JSON envelope ──────────────────────────────────────────────────────────
 * كل دالة في Rust تُرجع مؤشر C-string يحوي JSON:
 *     {"ok": true,  "data": <النتيجة>}
 *     {"ok": false, "error": "<رسالة>"}
 * callRust يفكّ الـ envelope ويُرجع `data`، أو يرمي Error(error) عند ok:false.
 *
 * ── Cleanup الذاكرة ────────────────────────────────────────────────────────
 * السلسلة المُرجَعة تخصّصها Rust (CString::into_raw). يجب تحريرها بـ free_rust_string
 * مرة واحدة بالضبط. callRust يقرأها ثم يحرّرها في `finally` — حتى لو فشل JSON.parse.
 * المدخلات (Buffer) تبقى ملكاً لـ JS ويديرها الـ GC؛ تُبقى حيّة أثناء الاستدعاء فقط.
 *
 * ── متغيرات البيئة ─────────────────────────────────────────────────────────
 *   DISABLE_RUST=1            يعطّل Rust بالكامل (لا dlopen أصلاً).
 *   DISABLE_RUST_FNS=a,b      يعطّل دوالاً محددة (مثلاً: match_chapter,clean_text).
 *   SUNKEN_RUST_LIB=/path     مسار بديل للمكتبة.
 *
 * ── الاستخدام ──────────────────────────────────────────────────────────────
 *   import { isRustAvailable, callRust } from "./rustBridge.js";
 *
 *   if (isRustAvailable("clean_text")) {
 *     try { return callRust("clean_text", text); }          // string → (ptr,len)
 *     catch (e) { console.warn("[RUST] clean_text:", e.message); }
 *   }
 *   return cleanTextJs(text);                                 // fallback دائماً
 *
 *   callRust("split_message", text, 9000)                     // number → u32
 *   callRust("extract_reader_images", html, url, "Mangalik")  // عدة strings
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** توقيعات الدوال: "s" = string → (ptr,len)، "u" = u32. المخرج دائماً ptr (envelope). */
const SIGS = {
  ping: [],
  extract_reader_images: ["s", "s", "s"],
  parse_mangalik_search_results: ["s"],
  find_mangalik_chapter_redirect: ["s", "s", "s"],
  match_chapter: ["s", "s"],
  split_message: ["s", "u"],
  clean_text: ["s"],
  is_filtered: ["s"],
};

const U32_MAX = 0xffffffff;

let _lib = null;          // نتيجة dlopen (cache)
let _ffi = null;          // وحدة bun:ffi
let _unavailable = false;
let _reason = "";
let _path = null;
let _loaded = false;
const _disabledFns = new Set(
  String(process.env.DISABLE_RUST_FNS || "").split(",").map((s) => s.trim()).filter(Boolean)
);

function libFileName() {
  if (process.platform === "win32") return "sunken.dll";
  if (process.platform === "darwin") return "libsunken.dylib";
  return "libsunken.so";
}

function resolveLibPath() {
  if (process.env.SUNKEN_RUST_LIB) return process.env.SUNKEN_RUST_LIB;
  return fileURLToPath(new URL(`../../rust/target/release/${libFileName()}`, import.meta.url));
}

function disable(reason) {
  _unavailable = true;
  _reason = reason;
  _lib = null;
}

function load() {
  if (_lib || _unavailable) return;
  if (process.env.DISABLE_RUST === "1") return disable("DISABLE_RUST=1");
  if (typeof Bun === "undefined") return disable("not running under Bun");
  try {
    _path = resolveLibPath();
    if (!existsSync(_path)) return disable(`library not found: ${_path}`);
    const { dlopen, FFIType } = _ffi;
    const T = FFIType;
    const symbols = {
      free_rust_string: { args: [T.ptr], returns: T.void },
    };
    for (const [name, kinds] of Object.entries(SIGS)) {
      const args = [];
      for (const k of kinds) {
        if (k === "s") args.push(T.ptr, T.u32);
        else args.push(T.u32);
      }
      symbols[name] = { args, returns: T.ptr };
    }
    _lib = dlopen(_path, symbols);
    _loaded = true;
    // smoke test: لو فشل ping نعتبر المكتبة غير صالحة.
    const pong = rawCall("ping", []);
    if (!pong || pong.pong !== true) throw new Error("ping returned unexpected payload");
    console.log(`[RUST] ✅ loaded (${_path})`);
  } catch (err) {
    disable(`load failed: ${err?.message || err}`);
    console.warn(`[RUST] ⚠️ unavailable — JS fallback (${_reason})`);
  }
}

// تحميل bun:ffi ديناميكياً كي لا يكسر الاستيراد خارج Bun (مثلاً أدوات Node).
if (typeof Bun !== "undefined") {
  try {
    _ffi = await import("bun:ffi");
  } catch (err) {
    _ffi = null;
    disable(`bun:ffi import failed: ${err?.message || err}`);
  }
}
if (_ffi) load();
else if (!_unavailable) disable(typeof Bun === "undefined" ? "not running under Bun" : "bun:ffi missing");
if (_unavailable && _reason !== "DISABLE_RUST=1" && !_reason.startsWith("load failed")) {
  // سبب غير مفاجئ (مثل تشغيل خارج Bun أو غياب .so) — سطر واحد للتتبع.
  console.warn(`[RUST] ⚠️ unavailable — JS fallback (${_reason})`);
}

/** هل Rust متاح؟ مرّر اسم دالة لاحترام DISABLE_RUST_FNS. */
export function isRustAvailable(fnName) {
  if (!_lib || _unavailable) return false;
  if (fnName && _disabledFns.has(fnName)) return false;
  return true;
}

/** { available, path, reason, loaded } */
export function rustStatus() {
  return { available: isRustAvailable(), path: _path, reason: _reason, loaded: _loaded };
}

/**
 * يمرّر نصاً كـ (ptr,len) ويبقي الـ Buffer حياً أثناء fn.
 *   passStr("abc", (buf, len) => lib.symbols.clean_text(buf, len))
 * يرمي عند وجود surrogate يتيم: Buffer.from سيستبدله بـ U+FFFD فيختلف السلوك عن JS،
 * فنفضّل fallback JS على نتيجة غير متطابقة.
 */
export function passStr(str, fn) {
  const s = String(str);
  if (typeof s.isWellFormed === "function" && !s.isWellFormed()) {
    throw new Error("string contains lone surrogate (JS fallback keeps exact semantics)");
  }
  const buf = Buffer.from(s, "utf8");
  if (buf.length > U32_MAX) throw new Error("string too large for FFI (u32 length)");
  return fn(buf, buf.length);
}

/** استدعاء خام بدون فحوص التوفر — يُستخدم داخلياً ولـ ping أثناء التحميل. */
function rawCall(fnName, args) {
  const kinds = SIGS[fnName];
  if (!kinds) throw new Error(`unknown rust function: ${fnName}`);
  if (args.length !== kinds.length) {
    throw new Error(`${fnName}: expected ${kinds.length} args, got ${args.length}`);
  }
  const flat = [];
  const keepAlive = []; // يمنع الـ GC من جمع الـ Buffers قبل انتهاء الاستدعاء
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i] === "s") {
      const s = String(args[i]);
      if (typeof s.isWellFormed === "function" && !s.isWellFormed()) {
        throw new Error("string contains lone surrogate (JS fallback keeps exact semantics)");
      }
      const buf = Buffer.from(s, "utf8");
      if (buf.length > U32_MAX) throw new Error("string too large for FFI (u32 length)");
      keepAlive.push(buf);
      flat.push(buf, buf.length);
    } else {
      const n = args[i];
      if (!Number.isInteger(n) || n < 0 || n > U32_MAX) throw new Error(`${fnName}: arg ${i} is not a valid u32`);
      flat.push(n);
    }
  }
  let ptr = 0;
  try {
    ptr = _lib.symbols[fnName](...flat);
    if (!ptr) throw new Error(`${fnName}: null pointer returned`);
    const text = new _ffi.CString(ptr).toString(); // نسخ إلى سلسلة JS قبل التحرير
    const env = JSON.parse(text);
    if (!env || env.ok !== true) throw new Error(env?.error || `${fnName}: rust returned ok:false`);
    return env.data;
  } finally {
    if (ptr) _lib.symbols.free_rust_string(ptr); // إلزامي: مرة واحدة، حتى عند الخطأ
    keepAlive.length = 0;
  }
}

/**
 * يستدعي دالة Rust ويُرجع `data`. يرمي عند أي فشل (المستدعي مسؤول عن try/catch + fallback).
 * string → (ptr,len)، number → u32.
 */
export function callRust(fnName, ...args) {
  if (!_lib || _unavailable) throw new Error(`rust unavailable: ${_reason}`);
  return rawCall(fnName, args);
}

/** اختصار لدوال كل مدخلاتها نصوص: callRustWithStrings("extract_reader_images", html, url, source) */
export function callRustWithStrings(fnName, ...strings) {
  return callRust(fnName, ...strings.map((s) => String(s)));
}

export default { isRustAvailable, rustStatus, callRust, callRustWithStrings, passStr };
