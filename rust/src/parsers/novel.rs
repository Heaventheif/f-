//! نقل حرفي لـ isFiltered / cleanText / splitMessage / splitLongParagraph
//! من src/cmds/_modules/novel.js.
//!
//! نقاط parity حساسة:
//!  * `.length` في JS = وحدات UTF-16 → نستخدم utf16_len (الإيموجي يُحسب 2).
//!  * `\s` في JS ≠ `\s` في Rust → نستخدم صنفاً صريحاً (انظر WS).
//!  * regex /i في JS ASCII-فقط لهذه الأنماط → نخفّض الحروف ASCII يدوياً بدل (?i) Unicode.

use once_cell::sync::Lazy;
use regex::Regex;

use crate::utils::strings::{js_trim, utf16_len};

const FILTER_WORDS: [&str; 14] = [
    "novelfull.com",
    "boxnovel",
    "novelmt.com",
    "mtlnovel.me",
    "advertisement",
    "report chapter",
    "next chapter",
    "prev chapter",
    "table of contents",
    "access denied",
    "just a moment",
    "cloudflare",
    "enable javascript",
    "read more at",
];

/// يطابق `\s` في JS تماماً.
const WS: &str = r"[\x09-\x0D\x20\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";

fn re(p: &str) -> Result<Regex, String> {
    Regex::new(p).map_err(|e| format!("regex `{p}`: {e}"))
}

static MULTI_BULLETS: Lazy<Result<Regex, String>> = Lazy::new(|| re("[•◆▪]{2,}"));
static MULTI_DOT: Lazy<Result<Regex, String>> = Lazy::new(|| re(r"\.{4,}"));
static MULTI_SPACE: Lazy<Result<Regex, String>> = Lazy::new(|| re(&format!("{WS}{{2,}}")));
static SENTENCE: Lazy<Result<Regex, String>> =
    Lazy::new(|| re("[^.!?\u{061f}\u{060c}]+[.!?\u{061f}\u{060c}]*"));

/// الأنماط مكتوبة بحروف صغيرة وتُطبَّق على نص مُخفَّض ASCII (بديل /i في JS).
static STOLEN_PATTERNS: Lazy<Result<Vec<Regex>, String>> = Lazy::new(|| {
    [
        format!(r"stol(en|e){WS}+(content|chapter|novel)"),
        format!(r"(this|the){WS}+(chapter|content|novel){WS}+(is|was){WS}+stolen"),
        format!(r"if{WS}+you('| a)re{WS}+reading{WS}+this{WS}+on"),
        format!(r"please{WS}+read{WS}+(this|it){WS}+on{WS}+(the{WS}+)?original"),
        format!(r"unauthorized{WS}+(use|reproduction|copy)"),
        format!(r"support{WS}+the{WS}+(author|translator){WS}+by{WS}+reading"),
    ]
    .iter()
    .map(|p| re(p))
    .collect()
});

fn get<T>(r: &'static Lazy<Result<T, String>>) -> Result<&'static T, String> {
    match &**r {
        Ok(v) => Ok(v),
        Err(e) => Err(e.clone()),
    }
}

pub fn is_filtered(t: &str) -> Result<bool, String> {
    let lower = t.to_lowercase();
    if FILTER_WORDS.iter().any(|w| lower.contains(w)) {
        return Ok(true);
    }
    let ascii_lower = t.to_ascii_lowercase();
    Ok(get(&STOLEN_PATTERNS)?
        .iter()
        .any(|re| re.is_match(&ascii_lower)))
}

pub fn clean_text(t: &str) -> Result<String, String> {
    let s = t.replace('\u{00a0}', " ");
    let s = get(&MULTI_BULLETS)?.replace_all(&s, " ");
    let s = get(&MULTI_DOT)?.replace_all(&s, "...");
    let s = get(&MULTI_SPACE)?.replace_all(&s, " ");
    Ok(js_trim(&s).to_string())
}

fn split_long_paragraph(p: &str, max_len: usize) -> Result<Vec<String>, String> {
    if utf16_len(p) <= max_len {
        return Ok(vec![p.to_string()]);
    }
    let mut sentences: Vec<&str> = get(&SENTENCE)?.find_iter(p).map(|m| m.as_str()).collect();
    if sentences.is_empty() {
        sentences.push(p); // JS: match(...) || [p]
    }
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut cur_len = 0usize;
    for s in sentences {
        let sl = utf16_len(s);
        if cur_len + sl > max_len && !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
            cur.push_str(s);
            cur_len = sl;
        } else {
            cur.push_str(s);
            cur_len += sl;
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    Ok(out)
}

pub fn split_message(text: &str, max_len: usize) -> Result<Vec<String>, String> {
    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut current_len = 0usize;
    for para in text.split("\n\n") {
        let pieces = if utf16_len(para) > max_len {
            split_long_paragraph(para, max_len)?
        } else {
            vec![para.to_string()]
        };
        for piece in pieces {
            let pl = utf16_len(&piece);
            if current_len + pl + 2 > max_len {
                let trimmed = js_trim(&current);
                if !trimmed.is_empty() {
                    chunks.push(trimmed.to_string());
                }
                current = format!("{piece}\n\n");
                current_len = pl + 2;
            } else {
                current.push_str(&piece);
                current.push_str("\n\n");
                current_len += pl + 2;
            }
        }
    }
    let trimmed = js_trim(&current);
    if !trimmed.is_empty() {
        chunks.push(trimmed.to_string());
    }
    if chunks.is_empty() {
        chunks.push(text.to_string());
    }
    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_text_cases() {
        assert_eq!(
            clean_text("  a\u{00a0}\u{00a0}b •••• c.....d  ").unwrap(),
            "a b c...d"
        );
        assert_eq!(clean_text("").unwrap(), "");
        assert_eq!(clean_text("a\u{feff}\u{feff}b").unwrap(), "a b");
    }

    #[test]
    fn filter_words_and_patterns() {
        assert!(is_filtered("Click NEXT CHAPTER now").unwrap());
        assert!(is_filtered("This chapter was   stolen").unwrap());
        assert!(is_filtered("If you're reading this on a pirate site").unwrap());
        assert!(!is_filtered("A normal paragraph of prose.").unwrap());
        assert!(!is_filtered("").unwrap());
    }

    #[test]
    fn split_message_basic() {
        let out = split_message("aaa\n\nbbb\n\nccc", 10).unwrap();
        assert_eq!(out, vec!["aaa\n\nbbb", "ccc"]);
    }

    #[test]
    fn split_message_long_paragraph_and_empty() {
        let para = "Hello world. Second sentence here. Third one!";
        let out = split_message(para, 20).unwrap();
        assert!(out.len() >= 2);
        assert_eq!(split_message("", 10).unwrap(), vec![""]);
    }

    #[test]
    fn split_counts_utf16() {
        // 😀 = 2 وحدات UTF-16 → "😀😀😀" = 6 + 2 = 8 ≤ 8 تبقى قطعة واحدة
        assert_eq!(split_message("😀😀😀", 8).unwrap().len(), 1);
        assert_eq!(split_message("😀😀😀😀", 8).unwrap().len(), 1); // قطعة واحدة طويلة: 8+2 > 8 لكن current فارغ
    }
}
