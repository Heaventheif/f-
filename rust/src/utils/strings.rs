/// مجموعة المسافات في JS لـ `\s` و `String.prototype.trim`:
/// U+0009–000D، U+0020، U+00A0، U+1680، U+2000–200A، U+2028/2029، U+202F، U+205F، U+3000، U+FEFF.
/// ملاحظة: تختلف عن `char::is_whitespace` في Rust (Rust يضيف U+0085 ولا يعرف U+FEFF).
pub fn is_js_space(c: char) -> bool {
    matches!(c,
        '\u{0009}'..='\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}'
        | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}'
        | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

/// يطابق `String.prototype.trim` في JS.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// عدد وحدات UTF-16 (يطابق `.length` في JS؛ الرموز خارج BMP تُحسب 2).
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// يحوّل الأرقام العربية-الهندية (٠-٩) إلى ASCII (يطابق normalizeNums في comic.js).
pub fn normalize_arabic_digits(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '\u{0660}'..='\u{0669}' => char::from(b'0' + (c as u32 - 0x0660) as u8),
            _ => c,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_matches_js() {
        assert_eq!(js_trim("\u{feff} a \u{00a0}"), "a");
        assert_eq!(js_trim("\u{0085}a"), "\u{0085}a"); // JS لا يعتبر NEL مسافة
    }

    #[test]
    fn utf16_counts_astral_as_two() {
        assert_eq!(utf16_len("a😀"), 3);
    }

    #[test]
    fn arabic_digits() {
        assert_eq!(normalize_arabic_digits("٠١٢٣٤٥٦٧٨٩x"), "0123456789x");
    }
}
