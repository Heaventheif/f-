# CHANGELOG-RUST — إصلاحات نسخة 2026-10-27

## أخطاء اكتُشفت وصُححت

1. **فشل Docker build بإصدار Rust المحدد:** كانت الصورة تستخدم `rust:1.85-alpine` بينما `Cargo.lock` يحتوي ICU 2.4 الذي يتطلب Rust 1.88. تم تثبيت الحد الأدنى `rust-version = "1.88"` وتحديث الصورة إلى `rust:1.88-alpine`. ثبت فشل 1.85.1 برسالة MSRV، ثم نجح build وtest على 1.88.0.
2. **غياب C linker في مرحلة Alpine:** أضيف `build-base` إلى Rust builder مع `musl-dev` حتى يتوفر compiler/linker المطلوب لبناء `cdylib`.
3. **بناء غير مقفول:** أضيف `--locked` إلى Docker و`build:rust` لمنع Cargo من حل اعتماديات مختلفة عن lockfile.
4. **اختلاف parity في redirect عند query فارغ:** كان Rust يعتبر `option.value` الغائب سلسلة فارغة ويطابق query فارغاً، بخلاف Cheerio. صار Rust لا يقارن value إلا إن كان attribute موجوداً. أصبحت النتيجة: **92 PASS / 0 FAIL**.
5. **دالة بطيئة ظلت مفعلة على Render:** القياس أظهر تراجع `split_message`؛ أضيفت إلى `DISABLE_RUST_FNS` في `render.yaml` مع `match_chapter`, `clean_text`, و`is_filtered`.
6. **أوامر دليل التشغيل كانت تستدعي Bun من مجلد `rust/`:** صُححت لتعمل من جذر المشروع.
7. **عينة benchmark لـ `cleanText` كانت أصغر من حد الإنتاج (2000 محرف):** زيد طولها لتقيس حجماً يصل إليه مسار Rust فعلياً.

## التحقق المنفذ

- `cargo +1.88.0 test --locked --manifest-path rust/Cargo.toml`: **25 اختباراً ناجحاً**.
- `cargo +1.88.0 build --locked --release --manifest-path rust/Cargo.toml`: ناجح.
- `cargo clippy --locked --manifest-path rust/Cargo.toml -- -D warnings`: ناجح على Rust stable 1.99.
- `bun run test:rust`: نجاح اختبار تحميل FFI و`ping`.
- `bun run parity:rust`: **92 PASS / 0 FAIL**.
- `bun run bench:rust`: اكتمل (2000 iterations).

## Benchmark (ms لكل استدعاء، على ARM64 Linux في Sandbox)

| الدالة | JavaScript | Rust/FFI | النسبة | قرار Render |
|---|---:|---:|---:|---|
| `extractReaderImages` | 1.9107 | 0.9373 | 2.04x أسرع | Rust مفعّل |
| `parseMangalikSearchResults` | 2.3881 | 0.7722 | 3.09x أسرع | Rust مفعّل |
| `findMangalikChapterRedirect` | 11.7309 | 4.7227 | 2.48x أسرع | Rust مفعّل |
| `matchChapter` | 0.4288 | 0.9824 | 0.44x (أبطأ) | JavaScript |
| `splitMessage` | 0.1209 | 0.9792 | 0.12x (أبطأ) | JavaScript |
| `cleanText` (>2000 محرف) | 0.0328 | 0.0670 | 0.49x (أبطأ) | JavaScript |
| `isFiltered` | 0.0023 | 0.0037 | 0.63x (أبطأ) | JavaScript |

قاس السكربت `RSS delta` بقيمة **+116.7 MB** أثناء دورة قياس اصطناعية تجمع أحجام إدخال كبيرة وتكرارات عديدة؛ هذه ليست مقارنة isolated لزيادة ذاكرة المكتبة أو قياس steady-state، ولا أعدّها تحقيقاً لحد RSS (<10MB). يلزم قياس الذاكرة على الخدمة الفعلية قبل اعتماد هذا المعيار.

## حدود التحقق

لا تتوفر Docker/Podman/Buildah في بيئة الفحص؛ لذلك عُدّل Dockerfile واختُبر build على Rust 1.88 المضيف، لكن **لم تُبنَ صورة Alpine أو تُشغّل**. لم يُقَس زمن startup. المكتبة المحلية المبنية glibc/ARM64 ولا تُضمّن في ملف التسليم؛ Docker يجب أن يبني نسخة musl داخل مرحلته.

## أوامر الإعادة من جذر المشروع

```sh
cargo +1.88.0 test --locked --manifest-path rust/Cargo.toml
cargo +1.88.0 build --locked --release --manifest-path rust/Cargo.toml
bun run test:rust
bun run parity:rust
bun run bench:rust
```
