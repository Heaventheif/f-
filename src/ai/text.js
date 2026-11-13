// Pure text helpers shared by the AI commands.
const TABLE_LINE = /^\s*\|.*\|\s*$/;
const RULE_LINE = /^\s*[-=_*]{3,}\s*$/;

// Strips chat-service artefacts but keeps fenced code blocks and tables verbatim.
export function cleanReply(text) {
  if (!text || typeof text !== "string") return text;
  let inFence = false;
  const out = [];
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence || TABLE_LINE.test(line)) {
      out.push(line);
      continue;
    }
    if (RULE_LINE.test(line)) continue;
    out.push(
      line
        .replace(/@DONE@/gi, "")
        .replace(/@[A-Z_]{3,}@/g, "")
        .replace(/(-=\s*|\s*=-)+/g, " ")
        .replace(/\*{2,}/g, "")
        .replace(/^(\s*)#{1,6}\s+/, "$1")
        .replace(/[ \t]+$/g, ""),
    );
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Splits on newline/space boundaries into pieces <= max chars.
export function chunkText(text, max = 1800) {
  const chunks = [];
  let rest = String(text ?? "");
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.4) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.4) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}

// Keeps the tail (the current question) and drops the oldest part of the prompt.
export function fitPrompt(prompt, max) {
  const p = String(prompt ?? "");
  if (!max || p.length <= max) return p;
  return "…" + p.slice(p.length - (max - 1));
}

export function isErrorText(s) {
  return /^\s*[❌⚠]/.test(String(s ?? ""));
}
