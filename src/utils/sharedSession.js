"use strict";
/**
 * sharedSession.js
 * ────────────────
 * تخزين جلسات AI (GPT / Gemini / Groq) في MongoDB عبر MONGO_URI.
 * عند غياب MONGO_URI → يستخدم الذاكرة (Map) تلقائياً.
 */

// ── اتصال MongoDB (مُشترك بين جميع الأوامر) ─────────────────────────────────
// HIGH-04 FIX: استبدال spin-wait (setTimeout 1500ms) بـ Promise barrier حقيقي.
// المشكلة السابقة: إذا اتصل عدة أوامر بـ loadCtx/saveCtx قبل اكتمال اتصال MongoDB،
// كل منها ينتظر 1500ms ثم يتحقق _connected. إذا استغرق الاتصال > 1500ms، كلهم
// يعودون null ويستخدمون RAM — وهكذا تُفقد البيانات بصمت.
// الحل: نُخزّن وعد الاتصال الجاري ونُعيده مباشرة لكل المتصلين المتزامنين.
let _mongoose       = null;
let _connected      = false;
let _connectPromise = null;  // ← الـ Promise barrier

async function getMongoose() {
  if (_connected) return _mongoose;

  // إذا كان اتصال جارٍ، أعد نفس الوعد — لا spin-wait
  if (_connectPromise) return _connectPromise;

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || "";
  if (!uri) return null;

  _connectPromise = (async () => {
    try {
      const mod   = await import("mongoose");
      _mongoose   = mod.default ?? mod;

      if (_mongoose.connection.readyState === 0) {
        await _mongoose.connect(uri, {
          dbName:                   "sunkenbot",
          serverSelectionTimeoutMS: 8000,
          socketTimeoutMS:          30000,
        });
      }

      _connected = true;
      console.log("[SESSION] ✅ MongoDB متصل (جلسات AI)");
      return _mongoose;
    } catch (e) {
      console.warn("[SESSION] ⚠️ MongoDB غير متاح — سيُستخدم RAM:", e.message);
      return null;
    } finally {
      // امسح الوعد حتى يُعاد المحاولة عند الاستدعاء التالي بعد الفشل
      if (!_connected) _connectPromise = null;
    }
  })();

  return _connectPromise;
}

// ── نماذج Mongoose (cached) ───────────────────────────────────────────────────
const _models = new Map();

function getModel(mg, collectionName) {
  if (_models.has(collectionName)) return _models.get(collectionName);
  const schema = new mg.Schema(
    {
      _id:       String,
      messages:  { type: Array, default: [] },
      updatedAt: { type: Date,  default: Date.now },
    },
    { collection: collectionName }
  );
  const name  = collectionName.replace(/[^a-zA-Z0-9]/g, "_");
  const model = mg.models[name] ?? mg.model(name, schema);
  _models.set(collectionName, model);
  return model;
}

// ── RAM fallback ──────────────────────────────────────────────────────────────
const _ram = new Map(); // key: `${collection}::${id}`

function ramKey(col, id) { return `${col}::${id}`; }

// ── API ───────────────────────────────────────────────────────────────────────

export async function loadCtx(collectionName, id, limit = 20) {
  try {
    const mg = await getMongoose();
    if (mg) {
      const doc = await getModel(mg, collectionName).findById(String(id)).lean();
      return doc?.messages?.slice(-limit) || [];
    }
    // RAM fallback
    return (_ram.get(ramKey(collectionName, id)) || []).slice(-limit);
  } catch (_) {
    return (_ram.get(ramKey(collectionName, id)) || []).slice(-limit);
  }
}

export async function saveCtx(collectionName, id, messages, limit = 20) {
  const sliced = messages.slice(-limit);
  try {
    const mg = await getMongoose();
    if (mg) {
      await getModel(mg, collectionName).findByIdAndUpdate(
        String(id),
        { messages: sliced, updatedAt: new Date() },
        { upsert: true }
      );
      return;
    }
  } catch (_) {}
  // RAM fallback
  _ram.set(ramKey(collectionName, id), sliced);
}

export async function clearCtx(collectionName, id) {
  try {
    const mg = await getMongoose();
    if (mg) {
      await getModel(mg, collectionName).findByIdAndDelete(String(id));
      return;
    }
  } catch (_) {}
  _ram.delete(ramKey(collectionName, id));
}

// ── Plugin Descriptor ─────────────────────────────────────────────────────────
export const $plugin = {
  name:  "xx-utils-shared-session",
  meta:  { category: "utils", path: "src/utils/sharedSession.js" },
  setup: (_ctx) => {},
};
