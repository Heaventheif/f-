//! نقاط الدخول FFI. هذا الملف الوحيد المسموح فيه بـ `unsafe`.
//!
//! العقد (يجب أن يطابق src/utils/rustBridge.js):
//!  * كل دالة تُرجع `*mut c_char` يشير إلى JSON: {"ok":true,"data":...} أو {"ok":false,"error":"..."}.
//!  * المؤشر المُرجَع مملوك لـ Rust ويجب على المستدعي تمريره إلى `free_rust_string` مرة واحدة بالضبط.
//!  * المدخلات النصية تُمرَّر كـ (ptr: *const u8, len: u32) بترميز UTF-8، ولا تُحرَّر هنا (ملك JS).
//!  * `panic = "unwind"` + `safe_ffi!` (catch_unwind) في كل export: أي panic يتحول إلى {ok:false}
//!    فيسقط المستدعي إلى JS بدل إنهاء البوت. ومع ذلك يبقى الكود خالياً من unwrap/expect/indexing.

use std::ffi::{c_char, CString};
use std::slice;

use serde::Serialize;

use crate::parsers::{comic, manga, novel};

// ───────────────────────────── helpers ─────────────────────────────

#[derive(Serialize)]
#[serde(untagged)]
enum Envelope<T: Serialize> {
    Ok { ok: bool, data: T },
    Err { ok: bool, error: String },
}

const FALLBACK_ERR: &str = r#"{"ok":false,"error":"serialization failed"}"#;

fn into_c(json: String) -> *mut c_char {
    match CString::new(json) {
        Ok(c) => c.into_raw(),
        // serde_json يهرّب NUL دائماً، فهذا الفرع نظرياً غير قابل للوصول.
        Err(_) => CString::new(FALLBACK_ERR).unwrap_or_default().into_raw(),
    }
}

/// يغلّف Result في JSON envelope موحّد ويُرجع مؤشراً يجب تحريره بـ free_rust_string.
pub fn to_json_response<T: Serialize>(result: Result<T, String>) -> *mut c_char {
    let env = match result {
        Ok(data) => Envelope::Ok { ok: true, data },
        Err(error) => Envelope::Err { ok: false, error },
    };
    match serde_json::to_string(&env) {
        Ok(s) => into_c(s),
        Err(_) => into_c(FALLBACK_ERR.to_string()),
    }
}

/// تحويل آمن (ptr,len) → &str. len=0 يعني نصاً فارغاً (المؤشر قد يكون null).
///
/// # Safety
/// يجب أن يشير `ptr` إلى `len` بايت صالحة للقراءة طوال استدعاء FFI (يضمنها JS بإبقاء الـ Buffer حياً).
pub unsafe fn slice_to_str<'a>(ptr: *const u8, len: u32) -> Result<&'a str, String> {
    if len == 0 {
        return Ok("");
    }
    if ptr.is_null() {
        return Err("null pointer with non-zero length".to_string());
    }
    let bytes = slice::from_raw_parts(ptr, len as usize);
    std::str::from_utf8(bytes).map_err(|e| format!("invalid utf-8: {e}"))
}

// ───────────────────────────── exports ─────────────────────────────

/// يلتقط أي panic داخل الـ body ويحوّله إلى envelope {ok:false}. بدونه، unwinding عبر حدود
/// `extern "C"` يُنهي العملية. يتطلب `panic = "unwind"` في Cargo.toml (لا abort).
macro_rules! safe_ffi {
    ($body:expr) => {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| $body))
            .unwrap_or_else(|_| to_json_response::<()>(Err("rust panic caught".into())))
    };
}

/// يحرّر سلسلة سبق أن أُرجعت من هذه المكتبة. آمن عند null.
///
/// # Safety
/// `ptr` يجب أن يأتي من دالة في هذه المكتبة ولم يُحرَّر سابقاً.
#[no_mangle]
pub unsafe extern "C" fn free_rust_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        drop(CString::from_raw(ptr));
    }
}

#[derive(Serialize)]
struct Pong {
    pong: bool,
    version: &'static str,
}

#[no_mangle]
pub extern "C" fn ping() -> *mut c_char {
    safe_ffi!(to_json_response::<Pong>(Ok(Pong {
        pong: true,
        version: env!("CARGO_PKG_VERSION")
    })))
}

// ── manga ──

#[no_mangle]
pub unsafe extern "C" fn extract_reader_images(
    html: *const u8,
    html_len: u32,
    chapter_url: *const u8,
    chapter_url_len: u32,
    source: *const u8,
    source_len: u32,
) -> *mut c_char {
    safe_ffi!(to_json_response((|| {
        let html = slice_to_str(html, html_len)?;
        let url = slice_to_str(chapter_url, chapter_url_len)?;
        let source = slice_to_str(source, source_len)?;
        manga::extract_reader_images(html, url, source)
    })()))
}

#[no_mangle]
pub unsafe extern "C" fn parse_mangalik_search_results(
    html: *const u8,
    html_len: u32,
) -> *mut c_char {
    safe_ffi!(to_json_response((|| manga::parse_mangalik_search_results(
        slice_to_str(html, html_len)?
    ))()))
}

#[no_mangle]
pub unsafe extern "C" fn find_mangalik_chapter_redirect(
    html: *const u8,
    html_len: u32,
    manga_url: *const u8,
    manga_url_len: u32,
    chapter: *const u8,
    chapter_len: u32,
) -> *mut c_char {
    safe_ffi!(to_json_response((|| {
        let html = slice_to_str(html, html_len)?;
        let manga_url = slice_to_str(manga_url, manga_url_len)?;
        let chapter = slice_to_str(chapter, chapter_len)?;
        manga::find_mangalik_chapter_redirect(html, manga_url, chapter)
    })()))
}

// ── comic ──

/// titles_json: مصفوفة JSON من النصوص. تُرجع {matchIndex, ambiguous, candidateIndices}.
#[no_mangle]
pub unsafe extern "C" fn match_chapter(
    titles_json: *const u8,
    titles_len: u32,
    query: *const u8,
    query_len: u32,
) -> *mut c_char {
    safe_ffi!(to_json_response((|| {
        let titles: Vec<String> = serde_json::from_str(slice_to_str(titles_json, titles_len)?)
            .map_err(|e| format!("titles json: {e}"))?;
        let query = slice_to_str(query, query_len)?;
        comic::match_chapter(&titles, query)
    })()))
}

// ── novel ──

#[no_mangle]
pub unsafe extern "C" fn split_message(
    text: *const u8,
    text_len: u32,
    max_len: u32,
) -> *mut c_char {
    safe_ffi!(to_json_response((|| novel::split_message(
        slice_to_str(text, text_len)?,
        max_len as usize
    ))()))
}

#[no_mangle]
pub unsafe extern "C" fn clean_text(text: *const u8, text_len: u32) -> *mut c_char {
    safe_ffi!(to_json_response((|| novel::clean_text(slice_to_str(
        text, text_len
    )?))()))
}

#[no_mangle]
pub unsafe extern "C" fn is_filtered(text: *const u8, text_len: u32) -> *mut c_char {
    safe_ffi!(to_json_response((|| novel::is_filtered(slice_to_str(
        text, text_len
    )?))()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CStr;

    fn take(ptr: *mut c_char) -> String {
        let s = unsafe { CStr::from_ptr(ptr) }
            .to_string_lossy()
            .into_owned();
        unsafe { free_rust_string(ptr) };
        s
    }

    #[test]
    fn ping_envelope() {
        let s = take(ping());
        assert!(s.starts_with(r#"{"ok":true,"data":{"pong":true"#), "{s}");
    }

    #[test]
    fn invalid_utf8_returns_error_envelope() {
        let bad = [0xffu8, 0xfe];
        let s = take(unsafe { clean_text(bad.as_ptr(), 2) });
        assert!(s.contains(r#""ok":false"#), "{s}");
    }

    #[test]
    fn null_with_len_is_error_and_free_null_is_safe() {
        let s = take(unsafe { clean_text(std::ptr::null(), 5) });
        assert!(s.contains(r#""ok":false"#));
        unsafe { free_rust_string(std::ptr::null_mut()) };
    }

    #[test]
    fn panic_is_caught_and_returned_as_error_envelope() {
        let p = safe_ffi!({
            if std::hint::black_box(true) {
                panic!("boom");
            }
            to_json_response::<()>(Ok(()))
        });
        let s = take(p);
        assert_eq!(s, r#"{"ok":false,"error":"rust panic caught"}"#);
    }

    #[test]
    fn empty_input_ok() {
        let s = take(unsafe { clean_text(std::ptr::null(), 0) });
        assert_eq!(s, r#"{"ok":true,"data":""}"#);
    }
}
