// Chess rules via chess.js (legality / SAN / UCI / FEN). The HF engine is only used for the bot
// move and board rendering; every position we persist is validated here first.
import { Chess } from "chess.js";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
export const normalizeMove = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();
export const isUciMove = (s) => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(normalizeMove(s));
export const colorName = (c) => (c === "w" ? "white" : "black");

// Parse "e2e4", "E2 E4", "e7e8q"; a bare pawn move to the last rank defaults to queen.
export function applyUci(fen, text) {
  const uci = normalizeMove(text);
  if (!isUciMove(uci)) return { ok: false, reason: "not_a_move" };
  let chess;
  try { chess = new Chess(fen); } catch { return { ok: false, reason: "bad_fen" }; }
  const from = uci.slice(0, 2), to = uci.slice(2, 4);
  let promotion = uci[4];
  const piece = chess.get(from);
  if (!promotion && piece?.type === "p" && (to[1] === "8" || to[1] === "1")) promotion = "q";
  if (promotion && piece?.type !== "p") promotion = undefined;
  let mv;
  try { mv = chess.move({ from, to, promotion }); } catch { mv = null; }
  if (!mv) return { ok: false, reason: "illegal" };
  return { ok: true, fen: chess.fen(), san: mv.san, uci: `${from}${to}${mv.promotion || ""}`, promotion: mv.promotion || null, ...status(chess, mv.color) };
}

// Game status after a move made by `mover` ("w"|"b").
export function status(chess, mover) {
  const over = chess.isGameOver();
  let result = null;
  if (over) result = chess.isCheckmate() ? { winner: colorName(mover) } : { winner: null, draw: true };
  return { gameOver: over, result, check: chess.isCheck() };
}
export function statusOfFen(fen, lastMover) {
  const c = new Chess(fen);
  return status(c, lastMover ?? (c.turn() === "w" ? "b" : "w"));
}
export const turnOf = (fen) => colorName(new Chess(fen).turn());

// An engine-returned FEN is accepted only if it is reachable from `fenBefore` by at most one legal
// move of the side to move (the bot's reply) - or equals it. Compare board+turn+castling.
const key = (fen) => String(fen).split(" ").slice(0, 3).join(" ");
export function isReachableFen(fenBefore, newFen) {
  let before, after;
  try { before = new Chess(fenBefore); after = new Chess(newFen); } catch { return false; }
  const target = key(after.fen());
  for (const m of before.moves({ verbose: true })) {
    const c = new Chess(fenBefore);
    c.move(m);
    if (key(c.fen()) === target) return true;
  }
  return false;
}
export function fenToText(fen) {
  const G = { K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘", P: "♙", k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
  const rows = String(fen || "").split(" ")[0].split("/");
  if (rows.length !== 8) return "";
  const lines = rows.map((row, i) => {
    let out = "";
    for (const ch of row) out += /\d/.test(ch) ? "· ".repeat(Number(ch)) : `${G[ch] || "?"} `;
    return `${8 - i} ${out.trimEnd()}`;
  });
  return `${lines.join("\n")}\n  a b c d e f g h`;
}
