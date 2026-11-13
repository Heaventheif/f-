import { Readable } from "stream";
import { fetchJson } from "../../net/safeFetch.js";
import { AppError } from "../../infra/errors.js";
import { hfTarget } from "../../manga/hf.js";
import { chessStore } from "../../chess/store.js";
import { START_FEN, applyUci, isUciMove, normalizeMove, isReachableFen, statusOfFen, turnOf, fenToText } from "../../chess/rules.js";

const ENGINE_TIMEOUT_MS = 55e3;
const USERINFO_TIMEOUT_MS = 3e3;
const BOARD_SEND_TIMEOUT_MS = 3e4;
const SWEEP_EVERY_MS = 30 * 60 * 1e3;
const MAX_IMAGE_B64 = 8 * 1024 * 1024;
export const DEFAULT_DIFFICULTY = 10;
const NO_HF_MSG = "⚠️ خادم الشطرنج غير مُعدّ (HF_SPACE_URL مفقود). تواصل مع المطوّر.";
const PIECE_NAMES = { q: "وزير ♛", r: "قلعة ♜", b: "فيل ♝", n: "حصان ♞" };
const reply = (api, text, threadID, messageID) => global.safeSend(api, text, threadID, null, messageID);

let lastApi = null;
function ensureSweeper() {
  if (globalThis.__chessSweepTimer) return;
  globalThis.__chessSweepTimer = setInterval(() => {
    chessStore().sweep((g) => lastApi && global.safeSend(lastApi, "⌛ أُغلقت مباراة الشطرنج لعدم النشاط لأكثر من 24 ساعة.", g.threadID, null, undefined)).catch(() => {});
  }, SWEEP_EVERY_MS);
  globalThis.__chessSweepTimer.unref?.();
}

const NAME_CACHE_TTL_MS = 30 * 60 * 1e3;
const _names = new Map();
async function getUserName(api, uid) {
  if (uid === "bot") return "🤖 البوت";
  const hit = _names.get(uid);
  if (hit && hit.exp > Date.now()) return hit.name;
  const fallback = String(uid).slice(-4);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (v) {
        if (_names.size > 500) _names.delete(_names.keys().next().value);
        _names.set(uid, { name: v, exp: Date.now() + NAME_CACHE_TTL_MS });
      }
      resolve(v || fallback);
    };
    const timer = setTimeout(() => finish(null), USERINFO_TIMEOUT_MS);
    try {
      api.getUserInfo(uid, (err, data) => {
        const u = data?.[uid];
        if (err || !u) return finish(null);
        finish(u.name || u.fullName || `${u.firstName || ""} ${u.lastName || ""}`.trim());
      });
    } catch { finish(null); }
  });
}

// HF engine: bot move and/or board rendering only. Token goes to https allowlisted hosts only.
export async function callEngine({ fen, move, botMode, difficulty, perspective, target = hfTarget(), getJson = fetchJson }) {
  if (!target) throw new AppError("not_configured", "hf_not_configured");
  const d = await getJson(`${target.base}/process_move`, {
    method: "POST", timeoutMs: ENGINE_TIMEOUT_MS, headers: target.headers, allowHosts: [target.host],
    body: { fen, move: move || null, bot_mode: !!botMode, difficulty: Number.isInteger(difficulty) && difficulty >= 1 && difficulty <= 20 ? difficulty : DEFAULT_DIFFICULTY, perspective },
  });
  if (d && typeof d.image_base64 === "string" && d.image_base64.length > MAX_IMAGE_B64) d.image_base64 = null;
  return d || {};
}

async function sendBoard(api, threadID, messageID, imageBase64, caption, fen = null) {
  const textFallback = () => reply(api, [caption, fenToText(fen)].filter(Boolean).join("\n\n"), threadID, messageID);
  if (!imageBase64 || typeof imageBase64 !== "string" || imageBase64.length > MAX_IMAGE_B64) return textFallback();
  let timer;
  try {
    const stream = Readable.from(Buffer.from(imageBase64, "base64"));
    stream.path = "chess_board.png";
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("board send timeout")), BOARD_SEND_TIMEOUT_MS); });
    await Promise.race([global.mediaSend(api, { body: caption, attachment: stream }, threadID, void 0, messageID), timeout]);
  } catch (e) {
    console.error("[CHESS:ERR]", e?.message || e);
    await textFallback().catch(() => {});
  } finally { clearTimeout(timer); }
}

const HELP = `♟️ قواعد بوت الشطرنج الرسومي
━━━━━━━━━━━━━━━━━━━━━━━━━
🚀 بدء لعبة:
  chess bot      — ضد الذكاء الاصطناعي
  chess @شخص     — تحدي عضو في المجموعة
  ردّ على رسالة + chess — تحدي صاحبها
  ⚡ الألوان تُحدَّد عشوائياً عند البدء
🎮 كيف تكتب النقلة (نظام UCI):
  من أين + إلى أين (بمسافة أو بدونها)
  ✅ e2e4   ✅ E2 E4   ✅ e2 e4  (كلها مقبولة)
♟️ النقلات الخاصة:
  • التبييت القصير ← e1g1 (ملك أبيض)
                      e8g8 (ملك أسود)
  • التبييت الطويل ← e1c1 (ملك أبيض)
                      e8c8 (ملك أسود)
  • الأخذ بالتجاوز ← تلقائي (اكتب النقلة العادية)
  • ترقية البيدق:
      e7e8q  — وزير  ♛ (الأقوى، افتراضي)
      e7e8r  — قلعة  ♜
      e7e8b  — فيل   ♝
      e7e8n  — حصان  ♞
    (بدون حرف = ترقية تلقائية لوزير)
⚠️ أثناء اللعبة:
  resign     — استسلام فوري
  chess help — عرض هذه القواعد مجدداً
📌 ملاحظات:
  • لا يمكن بدء لعبتين في نفس الوقت
  • النقلات غير القانونية تُرفض مع سبب الرفض
  • في لعبة البوت: يرد تلقائياً بعد كل نقلتك`;
const START_USAGE = `♟️ بوت الشطرنج
  chess bot   — ضد الذكاء الاصطناعي
  chess @شخص  — ضد لاعب
  رد + chess  — تحدي صاحب الرسالة
  chess help  — القواعد والنقلات الخاصة`;
// Applies a player's move: local legality via chess.js, engine for the bot reply / rendering.
async function handleMove({ api, event, game, text }) {
  const { threadID, messageID } = event;
  const senderID = String(event.senderID);
  const isBotGame = game.player_white === "bot" || game.player_black === "bot";
  const me = game.player_white === senderID ? "white" : "black";
  const opponent = me === "white" ? game.player_black : game.player_white;
  const r = applyUci(game.fen, text);
  if (!r.ok) {
    return reply(api, r.reason === "illegal" ? `❌ نقلة غير قانونية: ${normalizeMove(text)}\nجرّب نقلة أخرى.` : "⚠️ تعذّر قراءة اللوحة. أبلغ المطوّر.", threadID, messageID);
  }
  const target = hfTarget();
  let fen = r.fen;
  let image = null;
  let gameOver = r.gameOver, result = r.result;
  let engineNote = "";
  if (isBotGame && !r.gameOver) {
    // engine plays the bot's reply; its FEN must be a legal continuation of ours
    let d;
    try { d = await callEngine({ fen: game.fen, move: r.uci, botMode: true, difficulty: game.difficulty, perspective: me, target }); }
    catch (e) {
      const msg = e?.code === "not_configured" ? NO_HF_MSG : `⚠️ فشل الاتصال بسيرفر الشطرنج. لم تُحتسب نقلتك، أعدها.`;
      return reply(api, msg, threadID, messageID);
    }
    if (typeof d.illegal_move_error === "string") return reply(api, d.illegal_move_error.slice(0, 200), threadID, messageID);
    if (typeof d.new_fen !== "string" || !isReachableFen(r.fen, d.new_fen)) {
      return reply(api, "⚠️ ردّ المحرك غير صالح. لم تُحتسب نقلتك، أعدها.", threadID, messageID);
    }
    fen = d.new_fen;
    image = d.image_base64;
    const st = statusOfFen(fen, me === "white" ? "b" : "w");
    gameOver = st.gameOver;
    result = st.result;
  } else if (target) {
    // human game / finishing move: engine only renders the board
    try { image = (await callEngine({ fen: game.fen, move: r.uci, botMode: false, difficulty: game.difficulty, perspective: me, target })).image_base64; } catch { engineNote = ""; }
  }
  const promo = r.promotion ? `\n⬆️ ترقية إلى ${PIECE_NAMES[r.promotion] || PIECE_NAMES.q}` : "";
  let caption, patch;
  if (gameOver) {
    const winnerId = result?.winner ? (result.winner === "white" ? game.player_white : game.player_black) : null;
    patch = { fen, status: "completed", winner: result?.winner || null, winnerId, endedAt: Date.now() };
    caption = winnerId ? `♟️ كش مات!\n🏆 الفائز: ${await getUserName(api, winnerId)}` : "🤝 تعادل!";
  } else {
    const next = isBotGame ? senderID : opponent;
    patch = { fen, current_turn: next };
    caption = isBotGame
      ? `✅ نقلتك: ${r.uci.toUpperCase()}${promo}\n🤖 البوت لعب — دورك الآن!`
      : `✅ نقلة: ${r.uci.toUpperCase()}${promo}\n🎯 دور: ${await getUserName(api, opponent)}`;
  }
  try { await chessStore().update(game.id, game.version, patch); }
  catch (e) { return reply(api, e?.code === "conflict" ? "⚠️ تغيّرت اللعبة، أعد المحاولة." : "⚠️ تعذّر حفظ النقلة. أعد المحاولة.", threadID, messageID); }
  void engineNote;
  await sendBoard(api, threadID, messageID, image, caption, fen);
}

async function onChat({ api, event }) {
  if (!event.isGroup) return;
  lastApi = api;
  ensureSweeper();
  const { threadID, body, messageID } = event;
  const senderID = String(event.senderID);
  const text = body?.trim();
  if (!text) return;
  const lower = text.toLowerCase();
  const store = chessStore();
  if (lower === "chess help" || lower === "شطرنج مساعدة") return reply(api, HELP, threadID, messageID);
  if (lower === "resign" || lower === "استسلام") {
    const g = await store.findActive(threadID, senderID);
    if (!g) return;
    return store.withLock(g.id, async () => {
      const cur = await store.get(g.id);
      if (!cur || cur.status !== "active") return;
      const winnerId = cur.player_white === senderID ? cur.player_black : cur.player_white;
      await store.update(cur.id, cur.version, { status: "completed", winner: winnerId === cur.player_white ? "white" : "black", winnerId, endedAt: Date.now() });
      return reply(api, `🏳️ استسلم اللاعب!\n🏆 الفائز: ${await getUserName(api, winnerId)}`, threadID, messageID);
    });
  }
  if (!isUciMove(text)) return;
  const firstWord = text.split(/\s+/)[0].toLowerCase();
  if (global.commands?.has(firstWord)) return;
  const game = await store.findActive(threadID, senderID);
  if (!game) return;
  // "not your turn" only now that the text really looks like a move
  if (game.current_turn !== senderID) return reply(api, "⏳ ليس دورك الآن.", threadID, messageID);
  await store.withLock(game.id, async () => {
    const cur = await store.get(game.id);
    if (!cur || cur.status !== "active" || cur.current_turn !== senderID) return;
    try { await handleMove({ api, event, game: cur, text }); }
    catch (e) { console.error("[CHESS]", e?.code || "", e?.message); await reply(api, "⚠️ حدث خطأ أثناء معالجة النقلة.", threadID, messageID).catch(() => {}); }
  });
}

async function onStart({ api, event, args }) {
  lastApi = api;
  ensureSweeper();
  const { threadID, messageID, mentions, messageReply } = event;
  const senderID = String(event.senderID);
  const store = chessStore();
  const words = args.map((a) => String(a).toLowerCase().trim()).filter(Boolean);
  const query = words.join(" ");
  const mentionIds = Object.keys(mentions || {});
  if (["help", "مساعدة", "قواعد"].includes(query)) return reply(api, HELP, threadID, messageID);
  if (!query && !messageReply && !mentionIds.length) return reply(api, START_USAGE, threadID, messageID);
  if (!hfTarget()) return reply(api, NO_HF_MSG, threadID, messageID);
  if (await store.findActive(threadID, senderID)) return reply(api, "⚠️ لديك مباراة نشطة!\nاكتب resign لإنهائها أولاً.", threadID, messageID);
  // optional difficulty: `chess bot 5` (1-20)
  let difficulty = DEFAULT_DIFFICULTY;
  let opponentId;
  if (/^(bot|بوت)$/.test(words[0] || "")) {
    opponentId = "bot";
    if (words[1] !== undefined) {
      const d = Number(words[1]);
      if (!Number.isInteger(d) || d < 1 || d > 20) return reply(api, "❌ مستوى الصعوبة من 1 إلى 20.\nمثال: chess bot 5", threadID, messageID);
      difficulty = d;
    }
  } else if (mentionIds.length) opponentId = String(mentionIds[0]);
  else if (messageReply) opponentId = String(messageReply.senderID);
  else return reply(api, "❌ حدد منافسك:\n  chess bot — ضد البوت\n  chess @شخص — ضد لاعب", threadID, messageID);
  if (!opponentId || opponentId === senderID) return reply(api, "❌ لا يمكنك تحدي نفسك!", threadID, messageID);
  if (opponentId !== "bot" && (await store.findActive(threadID, opponentId))) return reply(api, "⚠️ هذا اللاعب لديه مباراة نشطة بالفعل!", threadID, messageID);
  const senderWhite = Math.random() < 0.5;
  const white = senderWhite ? senderID : opponentId;
  const black = senderWhite ? opponentId : senderID;
  const [senderName, opponentName] = await Promise.all([getUserName(api, senderID), getUserName(api, opponentId)]);
  let game = await store.create({ threadID, player_white: white, player_black: black, current_turn: white, fen: START_FEN, difficulty });
  let image = null, currentFen = START_FEN, note = "";
  try {
    if (opponentId === "bot" && white === "bot") {
      let opening;
      try { opening = await callEngine({ fen: START_FEN, move: null, botMode: true, difficulty, perspective: "black" }); } catch (e) {
        await store.update(game.id, game.version, { status: "aborted", endedAt: Date.now() });
        return reply(api, "⚠️ تعذّر بدء اللعبة — فشل البوت في لعب النقلة الأولى.\nحاول مرة أخرى بعد قليل.", threadID, messageID);
      }
      if (typeof opening.new_fen !== "string" || !isReachableFen(START_FEN, opening.new_fen)) {
        await store.update(game.id, game.version, { status: "aborted", endedAt: Date.now() });
        return reply(api, "⚠️ ردّ المحرك غير صالح. حاول مرة أخرى.", threadID, messageID);
      }
      image = opening.image_base64;
      currentFen = opening.new_fen;
      note = "\n🤖 البوت فتح اللعبة — دورك الآن!";
      game = await store.update(game.id, game.version, { fen: currentFen, current_turn: senderID });
    } else {
      try { image = (await callEngine({ fen: START_FEN, move: null, botMode: false, difficulty, perspective: senderWhite ? "white" : "black" })).image_base64; } catch { /* text board fallback */ }
    }
  } catch (e) {
    console.error("[CHESS]", e?.code || "", e?.message);
    return reply(api, "⚠️ تعذّر بدء اللعبة. حاول لاحقاً.", threadID, messageID);
  }
  const firstPlayer = white === "bot" ? "🤖 البوت (لعب بالفعل)" : white === senderID ? senderName : opponentName;
  const caption =
    `♟️ بدأت مباراة شطرنج!\n${senderWhite ? "⬜ أبيض" : "⬛ أسود"}: ${senderName}\n${senderWhite ? "⬛ أسود" : "⬜ أبيض"}: ${opponentName}\n🎯 يبدأ: ${firstPlayer}${note}\n` +
    (opponentId === "bot" && white !== "bot" ? "🤖 البوت سيرد تلقائياً بعد كل نقلتك\n" : "") +
    `\n💡 chess help — لمعرفة النقلات الخاصة`;
  await sendBoard(api, threadID, messageID, image, caption, currentFen);
}
void turnOf;

export default {
  config: {
    name: "chess",
    aliases: ["شطرنج"],
    version: "3.0.0",
    author: "Sunken",
    countDown: 5,
    role: 0,
    category: "ألعاب وترفيه",
    groupOnly: true,
    description: "بوت شطرنج رسومي للمجموعات (ضد لاعب أو ضد البوت)",
    usage: [
      "{pn}chess bot [1-20] — بدء مباراة ضد الذكاء الاصطناعي (الرقم = الصعوبة، افتراضي 10)",
      "{pn}chess @شخص — تحدي لاعب عبر منشن",
      "رد على رسالة + {pn}chess — تحدي صاحب الرسالة",
      "e2e4 (أو أي نقلة صحيحة) — تُلعب تلقائياً أثناء مباراة نشطة، بلا أمر",
      "resign / استسلام — الاستسلام من المباراة الحالية",
      "{pn}chess help — عرض القواعد الكاملة والنقلات الخاصة",
    ],
  },
  onChat,
  onStart,
};
