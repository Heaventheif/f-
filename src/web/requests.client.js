(() => {
  if (typeof window === "undefined") return; // browser-only script (importable under Bun for smoke checks)
  const { $, esc, api, notice, busy, confirm } = window.SB;
  const CHUNK = 25;
  let folder = "PENDING", items = [], selected = new Set(), nextCursor = null;
  const nt = $("notice");
  const say = (t, type) => notice(nt, t, type);

  function updateSelection() {
    const valid = new Set(items.map((x) => x.threadID));
    selected = new Set([...selected].filter((x) => valid.has(x)));
    $("all").checked = items.length > 0 && selected.size === items.length;
    $("bulkAccept").disabled = $("bulkReject").disabled = !selected.size;
    $("count").textContent = `${items.length} محادثة · ${selected.size} محددة`;
    $("more").hidden = !nextCursor;
  }
  function render() {
    updateSelection();
    $("list").innerHTML = items.length
      ? items.map((x) => `<article class="item"><input type="checkbox" aria-label="تحديد ${esc(x.name || x.threadID)}" data-select="${esc(x.threadID)}" ${selected.has(x.threadID) ? "checked" : ""}><div class="item-main"><div class="item-name" dir="auto">${esc(x.name || x.threadID)}</div><div class="item-sub" dir="auto">${x.isGroup ? "مجموعة" : "محادثة"}${x.snippet ? " · " + esc(x.snippet) : ""}</div></div><div class="item-actions"><button class="good" data-action="accept" data-id="${esc(x.threadID)}">قبول</button><button class="danger" data-action="reject" data-id="${esc(x.threadID)}">رفض</button></div></article>`).join("")
      : '<div class="empty">لا توجد محادثات</div>';
  }
  async function load(more = false) {
    try {
      const q = new URLSearchParams({ kind: "messages", folder, limit: "100" });
      if (more && nextCursor) q.set("cursor", nextCursor);
      const d = await api("/api/requests?" + q);
      const m = d.messages;
      items = more ? items.concat(m.items.filter((n) => !items.some((o) => o.threadID === n.threadID))) : m.items;
      nextCursor = m.nextCursor;
      if (!more) selected.clear();
      render();
    } catch (e) { say(e.message, "error"); if (!more) $("list").innerHTML = '<div class="empty">تعذر التحميل</div>'; }
  }
  async function change(btn, id, action) {
    await busy(btn, async () => {
      try { await api(`/api/requests/messages/${encodeURIComponent(id)}/${action}`, { method: "POST" }); say(action === "accept" ? "تم القبول" : "تم الرفض"); await load(); }
      catch (e) { say(e.message, "error"); }
    });
  }
  async function bulk(btn, action) {
    const ids = [...selected];
    if (!ids.length) return;
    if (!(await confirm(`${action === "accept" ? "قبول" : "رفض"} ${ids.length} طلب؟`))) return;
    await busy(btn, async () => {
      const failures = [];
      let done = 0;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        try {
          const d = await api("/api/requests/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "messages", action, ids: chunk }) });
          done += d.succeeded;
          d.results.filter((r) => !r.success).forEach((r) => failures.push(r));
        } catch (e) {
          if (e.data && e.data.results) e.data.results.forEach((r) => failures.push(r));
          else chunk.forEach((id) => failures.push({ id, error: e.message }));
          if (e.status === 401 || e.status === 429) break;
        }
      }
      const name = (id) => (items.find((x) => x.threadID === id) || {}).name || id;
      say(`نجح ${done} · فشل ${failures.length}` + (failures.length ? "\n" + failures.slice(0, 10).map((f) => `${name(f.id)}: ${f.error || ""}`).join("\n") : ""), failures.length ? "error" : "ok");
      await load();
    });
  }

  $("list").addEventListener("change", (e) => {
    const id = e.target.dataset && e.target.dataset.select;
    if (!id) return;
    e.target.checked ? selected.add(id) : selected.delete(id);
    updateSelection();
  });
  $("list").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-action]");
    if (b) change(b, b.dataset.id, b.dataset.action);
  });
  $("refresh").addEventListener("click", (e) => busy(e.currentTarget, () => load()));
  $("more").addEventListener("click", (e) => busy(e.currentTarget, () => load(true)));
  $("bulkAccept").addEventListener("click", (e) => bulk(e.currentTarget, "accept"));
  $("bulkReject").addEventListener("click", (e) => bulk(e.currentTarget, "reject"));
  $("all").addEventListener("change", (e) => { selected = e.target.checked ? new Set(items.map((x) => x.threadID)) : new Set(); render(); });
  const tabs = [...document.querySelectorAll("[role=tab]")];
  const pick = (tab) => {
    folder = tab.dataset.folder;
    tabs.forEach((t) => { const on = t === tab; t.setAttribute("aria-selected", on); t.tabIndex = on ? 0 : -1; t.classList.toggle("active", on); });
    $("panel").setAttribute("aria-labelledby", tab.id);
    load();
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => pick(t));
    t.addEventListener("keydown", (e) => {
      const d = { ArrowLeft: 1, ArrowRight: -1 }[e.key]; // RTL: left = next
      if (!d) return;
      const n = tabs[(i + d + tabs.length) % tabs.length];
      n.focus(); pick(n);
    });
  });
  window.SB.gate({ gate: $("gate"), app: $("app"), form: $("login"), input: $("pw"), error: $("loginError"), logout: $("logout"), onUnlock: () => load(), onLock: () => { items = []; selected.clear(); } });
})();
