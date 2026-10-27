// bun scripts/test-rust.js — فحص سريع: هل المكتبة تُحمَّل وهل ping يعمل؟
import { rustStatus, callRust, isRustAvailable } from "../src/utils/rustBridge.js";

const status = rustStatus();
console.log("rustStatus():", status);

if (!isRustAvailable()) {
  console.error(`❌ Rust غير متاح: ${status.reason}`);
  process.exit(1);
}
try {
  const res = callRust("ping");
  console.log("ping():", res);
  if (res?.pong !== true) throw new Error("pong !== true");
  console.log("pong: true");
  console.log("✅ OK");
} catch (err) {
  console.error("❌ فشل ping:", err.message);
  process.exit(1);
}
