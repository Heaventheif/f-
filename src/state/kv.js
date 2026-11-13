// One persistence primitive: kv(namespace) -> get/set/del/list/update.
// Backends: Postgres (single table) or atomic JSON files. No silent split-brain:
// if the chosen backend fails, calls THROW; a corrupt file is quarantined, never overwritten.
import { readFile, writeFile, rename, mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { KeyedMutex } from "../infra/limiter.js";
import { AppError } from "../infra/errors.js";

export class MemoryBackend {
  constructor() { this.data = new Map(); }
  async load(ns) { return this.data.get(ns) || {}; }
  async save(ns, obj) { this.data.set(ns, structuredClone(obj)); }
}

export class FileBackend {
  constructor(dir) { this.dir = dir; this.corrupt = new Set(); }
  path(ns) { return join(this.dir, `${ns.replace(/[^\w.-]/g, "_")}.json`); }
  async load(ns) {
    try { return JSON.parse(await readFile(this.path(ns), "utf8")); }
    catch (e) {
      if (e.code === "ENOENT") return {};
      this.corrupt.add(ns);
      await copyFile(this.path(ns), `${this.path(ns)}.corrupt-${Date.now()}`).catch(() => {});
      throw new AppError("state_corrupt", `cannot read ${ns}`, { cause: e });
    }
  }
  async save(ns, obj) {
    if (this.corrupt.has(ns)) throw new AppError("state_corrupt", `${ns} quarantined`);
    const p = this.path(ns);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(obj), { mode: 0o600 });
    await rename(tmp, p);
  }
}

export class PgBackend {
  constructor(pool) { this.pool = pool; this.ready = null; }
  async init() {
    this.ready ??= this.pool.query(
      `CREATE TABLE IF NOT EXISTS sunkenbot_kv (ns TEXT NOT NULL, k TEXT NOT NULL, v JSONB NOT NULL,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (ns, k))`).catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }
  async load(ns) {
    await this.init();
    const r = await this.pool.query("SELECT k, v FROM sunkenbot_kv WHERE ns=$1", [ns]);
    return Object.fromEntries(r.rows.map((x) => [x.k, x.v]));
  }
  // per-key write path used by Namespace for efficiency
  async put(ns, k, v) {
    await this.init();
    await this.pool.query(
      `INSERT INTO sunkenbot_kv (ns,k,v) VALUES ($1,$2,$3) ON CONFLICT (ns,k) DO UPDATE SET v=EXCLUDED.v, updated_at=NOW()`,
      [ns, k, JSON.stringify(v)]);
  }
  async remove(ns, k) { await this.init(); await this.pool.query("DELETE FROM sunkenbot_kv WHERE ns=$1 AND k=$2", [ns, k]); }
}

export class Store {
  constructor(backend) { this.backend = backend; this.cache = new Map(); this.mutex = new KeyedMutex(); }
  ns(name, { ttlMs = 0, now = Date.now } = {}) { return new Namespace(this, name, ttlMs, now); }
}

class Namespace {
  constructor(store, name, ttlMs, now) { Object.assign(this, { store, name, ttlMs, now }); }
  async #data() {
    const c = this.store.cache;
    if (!c.has(this.name)) c.set(this.name, await this.store.backend.load(this.name));
    return c.get(this.name);
  }
  #wrap(v) { return { v, t: this.now() }; }
  #live(e) { return e && (!this.ttlMs || this.now() - e.t < this.ttlMs); }
  async get(key) { const e = (await this.#data())[key]; return this.#live(e) ? e.v : undefined; }
  async list() { const d = await this.#data(); return Object.entries(d).filter(([, e]) => this.#live(e)).map(([k, e]) => [k, e.v]); }
  async #commit(key, entry) {
    const b = this.store.backend, d = await this.#data();
    const had = Object.prototype.hasOwnProperty.call(d, key), prev = d[key];
    if (entry === undefined) delete d[key]; else d[key] = entry;
    try {
      if (b.put) await (entry === undefined ? b.remove(this.name, key) : b.put(this.name, key, entry));
      else await b.save(this.name, d);
    } catch (e) { // roll back memory so it never diverges from storage
      if (had) d[key] = prev; else delete d[key];
      throw e;
    }
  }
  set(key, v) { return this.store.mutex.run(`${this.name}:${key}`, () => this.#commit(key, this.#wrap(v))); }
  del(key) { return this.store.mutex.run(`${this.name}:${key}`, () => this.#commit(key, undefined)); }
  // atomic read-modify-write
  update(key, fn, init) {
    return this.store.mutex.run(`${this.name}:${key}`, async () => {
      const cur = (await this.#data())[key];
      const next = await fn(this.#live(cur) ? structuredClone(cur.v) : init);
      await this.#commit(key, this.#wrap(next));
      return next;
    });
  }
  async sweep() {
    if (!this.ttlMs) return 0;
    let n = 0;
    for (const [k, e] of Object.entries(await this.#data())) if (!this.#live(e)) { await this.del(k); n++; }
    return n;
  }
}

let _store;
export async function getStore() {
  if (_store) return _store;
  const { getPostgresPool } = await import("../utils/postgres.js");
  const pool = getPostgresPool();
  const dir = process.env.STATE_DIR || join(process.cwd(), "data");
  return (_store = new Store(pool ? new PgBackend(pool) : new FileBackend(dir)));
}
export const _resetStoreForTests = () => { _store = null; };
