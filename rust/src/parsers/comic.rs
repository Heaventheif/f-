//! نقل حرفي لـ matchChapter في src/cmds/_modules/comic.js.
//!
//! تنبيه تصميمي: الدالة الأصلية تعمل على كائنات Blogger feed (`c.title['$t']`) وتُرجع
//! الكائنات نفسها. لذلك Rust يستقبل **العناوين فقط** ويُرجع **فهارس**، والجسر في JS
//! يعيد ربط الفهارس بالكائنات الأصلية. هذا يحفظ التطابق التام ويتجنب تسلسل الكائنات كاملة.

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;

use crate::utils::strings::{js_trim, normalize_arabic_digits};

fn re(p: &str) -> Result<Regex, String> {
    Regex::new(p).map_err(|e| format!("regex `{p}`: {e}"))
}

static RE_ANNUAL: Lazy<Result<Regex, String>> = Lazy::new(|| re(r"(?i)سنوي|annual"));
static RE_FIRST_NUM: Lazy<Result<Regex, String>> = Lazy::new(|| re(r"([0-9]+(?:\.[0-9]+)?)"));
static RE_TITLE_NUM: Lazy<Result<Regex, String>> = Lazy::new(|| re(r"#?([0-9]+(?:\.[0-9]+)?)"));

fn get(r: &'static Lazy<Result<Regex, String>>) -> Result<&'static Regex, String> {
    match &**r {
        Ok(v) => Ok(v),
        Err(e) => Err(e.clone()),
    }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MatchResult {
    pub match_index: Option<usize>,
    pub ambiguous: bool,
    pub candidate_indices: Vec<usize>,
}

fn none() -> MatchResult {
    MatchResult {
        match_index: None,
        ambiguous: false,
        candidate_indices: vec![],
    }
}

pub fn match_chapter(titles: &[String], query: &str) -> Result<MatchResult, String> {
    let q = js_trim(query);
    if q.is_empty() {
        return Ok(none());
    }
    if let Some(i) = titles.iter().position(|t| js_trim(t) == q) {
        return Ok(MatchResult {
            match_index: Some(i),
            ambiguous: false,
            candidate_indices: vec![],
        });
    }
    let annual = get(&RE_ANNUAL)?;
    let wants_annual = annual.is_match(&q.to_lowercase());
    let q_norm = normalize_arabic_digits(q);
    let q_num = match get(&RE_FIRST_NUM)?.captures(&q_norm).and_then(|c| c.get(1)) {
        Some(m) => m.as_str().to_string(),
        None => return Ok(none()),
    };
    let title_num = get(&RE_TITLE_NUM)?;

    let mut candidates: Vec<usize> = Vec::new();
    for (i, raw) in titles.iter().enumerate() {
        let t = normalize_arabic_digits(raw);
        if wants_annual != annual.is_match(&t) {
            continue;
        }
        if let Some(m) = title_num.captures(&t).and_then(|c| c.get(1)) {
            if m.as_str() == q_num {
                candidates.push(i);
            }
        }
    }

    match candidates.len() {
        0 => Ok(none()),
        1 => Ok(MatchResult {
            match_index: Some(candidates[0]),
            ambiguous: false,
            candidate_indices: vec![],
        }),
        _ => {
            let hash_num = format!("#{q_num}");
            let exact = candidates
                .iter()
                .copied()
                .find(|&i| titles[i].ends_with(&hash_num) || titles[i].ends_with(&q_num));
            Ok(MatchResult {
                match_index: Some(exact.unwrap_or(candidates[0])),
                ambiguous: true,
                candidate_indices: candidates,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn exact_title_first() {
        let r = match_chapter(&t(&["العدد #1", "العدد #2"]), " العدد #2 ").unwrap();
        assert_eq!(r.match_index, Some(1));
        assert!(!r.ambiguous);
    }

    #[test]
    fn arabic_digits_and_decimal() {
        let r = match_chapter(&t(&["Moon Knight #7", "Moon Knight #7.5"]), "٧.٥").unwrap();
        assert_eq!(r.match_index, Some(1));
    }

    #[test]
    fn annual_separation_and_ambiguity() {
        let titles = t(&["Batman #1", "Batman Annual #1", "Batman #1 Variant"]);
        let r = match_chapter(&titles, "1").unwrap();
        assert!(r.ambiguous);
        assert_eq!(r.candidate_indices, vec![0, 2]);
        assert_eq!(r.match_index, Some(0));
        let a = match_chapter(&titles, "annual 1").unwrap();
        assert_eq!(a.match_index, Some(1));
        assert!(!a.ambiguous);
    }

    #[test]
    fn edge_empty_and_no_number() {
        assert_eq!(match_chapter(&t(&["a"]), "   ").unwrap(), none());
        assert_eq!(match_chapter(&t(&["a"]), "abc").unwrap(), none());
        assert_eq!(match_chapter(&[], "5").unwrap(), none());
    }
}
