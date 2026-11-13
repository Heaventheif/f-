"use strict";
import { pool } from "../infra/limiter.js";
// Bounded-parallel map; failed items become null, order is preserved.
export async function downloadWithLimit(items, fetchFn, limit = 6) {
  const results = await pool(items, limit, fetchFn);
  return results.map((r) => (r.ok ? r.value : null));
}
