# sunken-rust

طبقة Rust اختيارية لتسريع دوال CPU-bound في SunkenBot عبر `bun:ffi`. كل دالة لها نسخة JS كاملة تُستخدم تلقائياً عند أي فشل.

## البنية
```
rust/
├── Cargo.toml            # cdylib "sunken"، panic="unwind" + catch_unwind، lto="fat"
└── src/
    ├── lib.rs
    ├── ffi.rs            # الوحيد المسموح فيه unsafe؛ نقاط الدخول + JSON envelope
    ├── parsers/{manga,comic,novel}.rs
    └── utils/strings.rs  # js_trim / utf16_len / normalize_arabic_digits (تطابق JS)
../src/utils/rustBridge.js   # الجسر
```

## البناء
```bash
cargo build --locked --release --manifest-path rust/Cargo.toml
cargo test --locked --manifest-path rust/Cargo.toml
bun run test:rust
bun run parity:rust
bun run bench:rust
```
يتطلب `rust-version = 1.88` بسبب ICU 2.4 المقفول في Cargo.lock. على Alpine/musl يضبط Dockerfile `RUSTFLAGS="-C target-feature=-crt-static"` ويثبت `build-base` لتوفير C linker المطلوب لبناء `cdylib`.

## العقد FFI
- المدخلات: نصوص UTF-8 كـ `(ptr, len:u32)`، أرقام كـ `u32`.
- المخرج: `*mut c_char` → JSON `{"ok":true,"data":…}` أو `{"ok":false,"error":"…"}`.
- يجب تحرير المخرج بـ `free_rust_string` (الجسر يفعل ذلك في `finally`).

## إضافة دالة جديدة (checklist)
1. اكتب المنطق في `src/parsers/*.rs` كدالة `Result<T, String>` (بلا `unwrap`/`expect`/indexing غير محمي) + 3 اختبارات (happy / edge / security).
2. أضف نقطة دخول في `ffi.rs` (`#[no_mangle] pub unsafe extern "C"`) تستخدم `slice_to_str` و`to_json_response`.
3. أضف التوقيع في `SIGS` داخل `src/utils/rustBridge.js` (`"s"` نص، `"u"` رقم).
4. في ملف JS: أعد تسمية الأصل إلى `xxxJs` (بلا تعديل) وأضف wrapper: `isRustAvailable(name)` → `try callRust` → `catch console.warn` → `xxxJs`.
5. أضف حالات في `test-fixtures/cases.js` (≥10) وفرعاً في `scripts/parity-test.js` و`bench-rust.js`.
6. شغّل `cargo test` + parity + bench؛ لا تدمج إن لم تتحقق الأهداف.

## نقاط parity الدقيقة (أخطاء متوقعة عند النقل)
- `\s` و`trim()` في JS ≠ Rust (U+FEFF مسافة في JS فقط، U+0085 مسافة في Rust فقط) → `is_js_space`.
- `\d` في Rust يطابق Unicode → استخدم `[0-9]`.
- `.length` في JS = UTF-16 → `utf16_len`.
- Rust regex بلا lookahead → `normalize_chapter_number` يدوي.
- `/i` في JS ASCII فقط لهذه الأنماط → `to_ascii_lowercase` بدل `(?i)`.
- surrogate يتيم في نص JS → الجسر يرفض ويسقط لـ JS (Buffer كان سيستبدله بـ U+FFFD).

## Rollback
`DISABLE_RUST=1` · `DISABLE_RUST_FNS=match_chapter,clean_text` · حذف/إعادة تسمية `libsunken.so` · `git revert`.
