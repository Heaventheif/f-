//! نقل حرفي لمنطق src/utils/mangaScrapers.js:
//!   extractReaderImages / parseMangalikSearchResults / findMangalikChapterRedirect
//! أي تعديل هنا يجب أن يقابله تعديل في JS الأصلي (وإلا ينكسر parity).

use once_cell::sync::Lazy;
use percent_encoding::percent_decode_str;
use scraper::{ElementRef, Html, Selector};
use serde::Serialize;
use url::Url;

use crate::utils::strings::js_trim;

const MANGALIK_ORIGIN: &str = "https://mangalik.net";

fn sel(css: &str) -> Result<Selector, String> {
    Selector::parse(css).map_err(|e| format!("selector `{css}`: {e:?}"))
}

static SEL_READER: Lazy<Result<Selector, String>> = Lazy::new(|| {
    sel(".reading-content img.wp-manga-chapter-img, .reading-content .page-break img")
});
static SEL_ANCHOR: Lazy<Result<Selector, String>> = Lazy::new(|| sel("a[href*='/manga/']"));
static SEL_POST_TITLE: Lazy<Result<Selector, String>> = Lazy::new(|| sel(".post-title a"));
static SEL_IMG: Lazy<Result<Selector, String>> = Lazy::new(|| sel("img"));
static SEL_OPTION: Lazy<Result<Selector, String>> =
    Lazy::new(|| sel("select.single-chapter-select option[data-redirect]"));

fn get(s: &'static Lazy<Result<Selector, String>>) -> Result<&'static Selector, String> {
    match &**s {
        Ok(v) => Ok(v),
        Err(e) => Err(e.clone()),
    }
}

/// يطابق isAllowedHost(hostname, source). `source` ∈ {"StarzManga","Mangalik"}.
fn is_allowed_host(host: &str, source: &str) -> bool {
    let host = host.to_lowercase();
    match source {
        "StarzManga" => {
            host == "starzmanga.com"
                || host.ends_with(".starzmanga.com")
                || host == "manga-starz.net"
                || host.ends_with(".manga-starz.net")
        }
        "Mangalik" => host == "mangalik.net" || host.ends_with(".mangalik.net"),
        _ => false,
    }
}

/// يطابق `new URL(value, base)` (WHATWG). base فارغ = بلا base.
/// ملاحظة: في JS إن كان base غير صالح يُرمى TypeError حتى لو value مطلق، لذلك نُرجع None.
fn parse_url(value: &str, base: &str) -> Option<Url> {
    if base.is_empty() {
        return Url::parse(value).ok();
    }
    let base_url = Url::parse(base).ok()?;
    Url::options().base_url(Some(&base_url)).parse(value).ok()
}

fn normalize_reader_image_url(value: &str, source: &str, base: &str) -> Option<String> {
    let mut url = parse_url(value, base)?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || !is_allowed_host(url.host_str().unwrap_or(""), source)
    {
        return None;
    }
    url.set_fragment(None);
    Some(url.into())
}

fn normalize_mangalik_url(value: &str, base: &str) -> Option<Url> {
    let mut url = parse_url(value, base)?;
    if url.scheme() != "https" || !is_allowed_host(url.host_str().unwrap_or(""), "Mangalik") {
        return None;
    }
    url.set_fragment(None);
    Some(url)
}

fn text_of(el: ElementRef) -> String {
    el.text().collect::<String>()
}

fn path_segments(url: &Url) -> Vec<&str> {
    url.path().split('/').filter(|s| !s.is_empty()).collect()
}

/// decodeURIComponent: يفشل عند UTF-8 غير صالح (كما يرمي JS URIError).
fn decode_uri_component(s: &str) -> Result<String, String> {
    percent_decode_str(s)
        .decode_utf8()
        .map(|c| c.into_owned())
        .map_err(|_| "URIError: malformed URI sequence".to_string())
}

fn non_empty(s: Option<&str>) -> Option<&str> {
    s.filter(|v| !v.is_empty())
}

// ───────────────────────── extractReaderImages ─────────────────────────

pub fn extract_reader_images(
    html: &str,
    chapter_url: &str,
    source: &str,
) -> Result<Vec<String>, String> {
    let doc = Html::parse_document(html);
    let selector = get(&SEL_READER)?;
    let mut images: Vec<String> = Vec::new();
    for img in doc.select(selector) {
        let v = img.value();
        // JS: attr("data-src") || attr("data-lazy-src") || attr("data-original") || attr("src")
        // وإن كانت كلها غير موجودة يصبح raw = undefined فيُحوَّل لـ "undefined" داخل new URL.
        let raw = non_empty(v.attr("data-src"))
            .or_else(|| non_empty(v.attr("data-lazy-src")))
            .or_else(|| non_empty(v.attr("data-original")))
            .or_else(|| non_empty(v.attr("src")))
            .unwrap_or("undefined");
        if let Some(url) = normalize_reader_image_url(raw, source, chapter_url) {
            if !images.contains(&url) {
                images.push(url);
            }
        }
    }
    Ok(images)
}

// ─────────────────────── parseMangalikSearchResults ───────────────────────

#[derive(Serialize, Debug, PartialEq)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
}

pub fn parse_mangalik_search_results(html: &str) -> Result<Vec<SearchResult>, String> {
    let doc = Html::parse_document(html);
    let a_sel = get(&SEL_ANCHOR)?;
    let title_sel = get(&SEL_POST_TITLE)?;
    let img_sel = get(&SEL_IMG)?;
    let mut results: Vec<SearchResult> = Vec::new();

    for anchor in doc.select(a_sel) {
        let href = anchor.value().attr("href").unwrap_or("undefined");
        let url = match normalize_mangalik_url(href, MANGALIK_ORIGIN) {
            Some(u) => u,
            None => continue,
        };
        let segments = path_segments(&url);
        if segments.len() != 2 || segments[0] != "manga" {
            continue;
        }
        let slug = segments[1];
        let canonical = format!("{MANGALIK_ORIGIN}/manga/{slug}/");
        if results.iter().any(|r| r.url == canonical) {
            continue; // JS: أول ظهور يفوز، ولا يُحسب العنوان للمكرر
        }

        // container = anchor.closest(".c-tabs-item") (يشمل العنصر نفسه)
        let container = std::iter::once(*anchor)
            .chain(anchor.ancestors())
            .filter_map(ElementRef::wrap)
            .find(|e| e.value().classes().any(|c| c == "c-tabs-item"));

        let from_container = container
            .and_then(|c| c.select(title_sel).next())
            .map(|a| js_trim(&text_of(a)).to_string())
            .unwrap_or_default();

        let title = if !from_container.is_empty() {
            from_container
        } else if let Some(t) = non_empty(anchor.value().attr("title")) {
            t.to_string()
        } else if let Some(alt) = non_empty(
            anchor
                .select(img_sel)
                .next()
                .and_then(|i| i.value().attr("alt")),
        ) {
            alt.to_string()
        } else {
            let t = js_trim(&text_of(anchor)).to_string();
            if !t.is_empty() {
                t
            } else {
                let decoded = decode_uri_component(slug)?;
                collapse_dashes(&decoded)
            }
        };
        results.push(SearchResult {
            title,
            url: canonical,
        });
    }
    Ok(results)
}

/// JS: str.replace(/[-_]+/g, " ")
fn collapse_dashes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_run = false;
    for c in s.chars() {
        if c == '-' || c == '_' {
            if !in_run {
                out.push(' ');
                in_run = true;
            }
        } else {
            in_run = false;
            out.push(c);
        }
    }
    out
}

// ─────────────────────── findMangalikChapterRedirect ───────────────────────

/// JS: String(v||"").trim().replace(/,/g,".").replace(/[ _-](?=\d+$)/, ".")
/// Rust regex بلا lookahead، لذا ننفّذها يدوياً. \d في JS = ASCII فقط.
pub fn normalize_chapter_number(value: &str) -> String {
    let s = js_trim(value).replace(',', ".");
    let digits = s.bytes().rev().take_while(|b| b.is_ascii_digit()).count();
    if digits == 0 || digits == s.len() {
        return s;
    }
    let split = s.len() - digits; // حدّ ASCII بايت، آمن للـ char boundary
    let head = &s[..split];
    let mut chars = head.chars();
    match chars.next_back() {
        Some(c) if c == ' ' || c == '_' || c == '-' => {
            format!("{}.{}", chars.as_str(), &s[split..])
        }
        _ => s,
    }
}

pub fn find_mangalik_chapter_redirect(
    html: &str,
    manga_url: &str,
    chapter: &str,
) -> Result<Option<String>, String> {
    let target = normalize_chapter_number(chapter);
    let doc = Html::parse_document(html);
    let opt_sel = get(&SEL_OPTION)?;
    for option in doc.select(opt_sel) {
        let redirect = match option
            .value()
            .attr("data-redirect")
            .and_then(|r| normalize_mangalik_url(r, manga_url))
        {
            Some(r) => r,
            None => continue,
        };
        let last = path_segments(&redirect).last().copied().unwrap_or("");
        let last = decode_uri_component(last)?;
        let option_text = text_of(option);
        let text_candidate = js_trim(&option_text);
        let value_candidate = option.value().attr("value");
        if normalize_chapter_number(text_candidate) == target
            || value_candidate.is_some_and(|value| normalize_chapter_number(value) == target)
            || normalize_chapter_number(&last) == target
        {
            return Ok(Some(redirect.into()));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CH: &str = "https://mangalik.net/manga/pieceone/1085/";

    #[test]
    fn images_happy_path_and_dedupe() {
        let html = r#"<div class="reading-content">
          <img class="wp-manga-chapter-img" data-src=" https://mangalik.net/a.jpg#x ">
          <div class="page-break"><img src="/b.jpg"></div>
          <img class="wp-manga-chapter-img" src="https://mangalik.net/a.jpg"></div>"#;
        let out = extract_reader_images(html, CH, "Mangalik").unwrap();
        assert_eq!(
            out,
            vec!["https://mangalik.net/a.jpg", "https://mangalik.net/b.jpg"]
        );
    }

    #[test]
    fn images_security_rejects_foreign_http_and_creds() {
        let html = r#"<div class="reading-content">
          <img class="wp-manga-chapter-img" src="https://evil.com/a.jpg">
          <img class="wp-manga-chapter-img" src="http://mangalik.net/a.jpg">
          <img class="wp-manga-chapter-img" src="https://u:p@mangalik.net/a.jpg">
          <img class="wp-manga-chapter-img" src="https://notmangalik.net/a.jpg"></div>"#;
        assert!(extract_reader_images(html, CH, "Mangalik")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn images_edge_empty_and_malformed() {
        assert!(extract_reader_images("", CH, "Mangalik")
            .unwrap()
            .is_empty());
        assert!(
            extract_reader_images("<div class='reading-content'><img", CH, "Mangalik")
                .unwrap()
                .is_empty()
        );
        assert!(extract_reader_images("<p>x", "", "Mangalik")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn search_title_priority_and_canonical() {
        let html = r#"<div class="c-tabs-item"><div class="post-title"><a href="/manga/foo-bar/">Foo Bar</a></div>
          <a href="/manga/foo-bar/?x=1"><img alt="ignored"></a></div>
          <a href="/manga/baz_qux/"></a><a href="/manga/a/b/">no</a><a href="https://evil.com/manga/z/">no</a>"#;
        let r = parse_mangalik_search_results(html).unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!(
            r[0],
            SearchResult {
                title: "Foo Bar".into(),
                url: "https://mangalik.net/manga/foo-bar/".into()
            }
        );
        assert_eq!(r[1].title, "baz qux");
    }

    #[test]
    fn search_edge_empty() {
        assert!(parse_mangalik_search_results("").unwrap().is_empty());
    }

    #[test]
    fn normalize_chapter_number_cases() {
        assert_eq!(normalize_chapter_number(" 7,5 "), "7.5");
        assert_eq!(normalize_chapter_number("7-5"), "7.5");
        assert_eq!(normalize_chapter_number("1-2-3"), "1-2.3");
        assert_eq!(normalize_chapter_number("chapter 12"), "chapter.12");
        assert_eq!(normalize_chapter_number("12"), "12");
        assert_eq!(normalize_chapter_number("-5"), ".5");
    }

    #[test]
    fn redirect_happy_and_security() {
        let html = r#"<select class="single-chapter-select">
          <option data-redirect="https://evil.com/manga/x/1085/" value="1085">1085</option>
          <option data-redirect="/manga/pieceone/1085-2/" value="zzz">Chapter</option></select>"#;
        let r =
            find_mangalik_chapter_redirect(html, "https://mangalik.net/manga/pieceone/", "1085.2")
                .unwrap();
        assert_eq!(
            r.as_deref(),
            Some("https://mangalik.net/manga/pieceone/1085-2/")
        );
        let none =
            find_mangalik_chapter_redirect(html, "https://mangalik.net/manga/pieceone/", "1085")
                .unwrap();
        assert_eq!(none, None);
    }

    #[test]
    fn empty_query_does_not_match_missing_option_value() {
        let html = r#"<select class="single-chapter-select"><option data-redirect="/manga/pieceone/1/">1</option></select>"#;
        let result =
            find_mangalik_chapter_redirect(html, "https://mangalik.net/manga/pieceone/", "")
                .unwrap();
        assert_eq!(result, None);
    }
}
