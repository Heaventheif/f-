(() => {
  if (typeof window === "undefined") return; // browser-only script (importable under Bun for smoke checks)
  const { $, esc, size, api, upload, notice, busy, confirm } = window.SB;
  let groups = [], selected = new Set(), files = [], limits = { maxFileBytes: 52428800, maxTotalBytes: 104857600, maxTargets: 300 };
  let pollTimer = null, pollDelay = 5000, polling = false;
  const POLL_MIN = 5000, POLL_MAX = 60000;
  const statusNames = { queued: "في الانتظار", running: "قيد الإرسال", paused: "متوقفة مؤقتاً", cancelled: "أُلغيت", completed: "اكتملت", completed_with_errors: "اكتملت مع أخطاء", review: "تحتاج مراجعة", pending: "في الانتظار", processing: "جارٍ الإرسال", sent: "تم الإرسال", failed: "فشل", unknown: "نتيجة غير مؤكدة" };
  const waitNames = { hourly_cap: "بلغت الحد الساعي؛ ستُستأنف تلقائيًا", daily_cap: "بلغت الحد اليومي؛ ستُستأنف تلقائيًا" };
  const say = (t, type) => notice($("notice"), t, type);
  const fileKey = (f) => `${f.name}:${f.size}:${f.lastModified}`;

  // ---- groups ----
  const visibleGroups = () => {
    const q = $("groupSearch").value.trim().toLocaleLowerCase();
    return groups.filter((g) => g.name.toLocaleLowerCase().includes(q));
  };
  const countText = () => { $("groupCount").textContent = `${selected.size} محددة من ${groups.length}`; };
  function renderGroups() {
    const v = visibleGroups();
    $("groups").innerHTML = v.length
      ? v.map((g) => `<label class="group"><input type="checkbox" data-id="${esc(g.id)}" ${selected.has(g.id) ? "checked" : ""}><span dir="auto">${esc(g.name)}</span><small>${g.participantCount ?? "—"} عضو</small></label>`).join("")
      : '<div class="group muted">لا توجد مجموعات مطابقة.</div>';
    countText();
  }
  async function loadGroups(refresh) {
    try {
      groups = (await api("/api/broadcast/groups" + (refresh ? "?refresh=1" : ""))).groups || [];
      const ids = new Set(groups.map((g) => g.id));
      selected = new Set([...selected].filter((id) => ids.has(id))); // drop stale ids
      renderGroups(); updatePreview();
    } catch (e) { say(e.message, "error"); }
  }

  // ---- files ----
  function renderFiles() {
    const el = $("fileList");
    el.textContent = "";
    if (!files.length) { el.textContent = "لم يتم اختيار ملفات."; }
    files.forEach((f, i) => {
      const row = document.createElement("div");
      row.className = "frow";
      const name = document.createElement("span");
      name.dir = "auto"; name.textContent = `${f.name} (${size(f.size)})`;
      const rm = document.createElement("button");
      rm.type = "button"; rm.textContent = "إزالة"; rm.setAttribute("aria-label", "إزالة " + f.name);
      rm.addEventListener("click", () => { files.splice(i, 1); renderFiles(); });
      row.append(name, rm);
      el.append(row);
    });
    updatePreview();
  }
  function updatePreview() {
    const text = $("message").value.trim();
    const p = $("preview");
    p.textContent = "";
    const line = (label, node) => { const d = document.createElement("div"); const b = document.createElement("b"); b.textContent = label + " "; d.append(b, node); p.append(d); };
    line("الوجهات:", document.createTextNode(`${selected.size} مجموعة`));
    const t = document.createElement("span");
    t.dir = "auto"; t.style.whiteSpace = "pre-wrap"; t.textContent = text || "بدون نص";
    line("النص:", t);
    line("المرفقات:", document.createTextNode(files.length ? files.map((f) => `${f.name} (${size(f.size)})`).join("، ") : "لا توجد"));
  }

  // ---- create ----
  async function create(btn) {
    const text = $("message").value.trim();
    if (!selected.size) return say("اختر مجموعة واحدة على الأقل", "error");
    if (!text && !files.length) return say("أدخل نصاً أو اختر ملفاً", "error");
    if (selected.size > limits.maxTargets) return say("عدد الوجهات يتجاوز الحد المسموح", "error");
    if (files.some((f) => f.size > limits.maxFileBytes) || files.reduce((a, f) => a + f.size, 0) > limits.maxTotalBytes) return say("حجم المرفقات يتجاوز الحدود المعروضة", "error");
    if (!(await confirm(`تأكيد إرسال المحتوى إلى ${selected.size} مجموعة؟ لا يمكن سحب الرسائل بعد إرسالها.`, "إرسال"))) return;
    const fd = new FormData();
    fd.set("text", text);
    fd.set("targetIds", JSON.stringify([...selected]));
    files.forEach((f) => fd.append("files", f, f.name));
    const prog = $("uploadProg");
    prog.hidden = !files.length; prog.value = 0;
    await busy(btn, async () => {
      try {
        await upload("/api/broadcast", fd, { "Idempotency-Key": crypto.randomUUID() }, (r) => { prog.value = r * 100; });
        say("أُنشئت الحملة. يمكنك متابعة تقدمها في السجل.");
        $("message").value = ""; files = []; selected.clear();
        renderFiles(); renderGroups();
        await loadCampaigns();
      } catch (e) { say(e.message, "error"); } finally { prog.hidden = true; }
    });
  }

  // ---- campaigns (keyed DOM updates so open <details> and focus survive polling) ----
  const nodes = new Map();
  const doneCount = (n) => (n.sent || 0) + (n.failed || 0) + (n.unknown || 0) + (n.cancelled || 0);
  function build(id) {
    const a = document.createElement("article");
    a.className = "campaign"; a.dataset.id = id;
    a.innerHTML = `<div class="campaign-head"><b class="when"></b><span class="status st"></span></div><div class="muted txt" dir="auto"></div><div class="warning why"></div><div class="files fl" dir="auto"></div><div class="bar" role="progressbar" aria-label="تقدم الحملة" aria-valuemin="0" aria-valuemax="100"><i></i></div><div class="counts"></div><div class="row acts" style="margin-top:10px"></div><details style="margin-top:10px"><summary>تفاصيل الوجهات</summary><div class="tg"></div></details>`;
    return a;
  }
  function fill(a, c) {
    const n = c.counts || {}, pct = n.total ? Math.round((doneCount(n) / n.total) * 100) : 0;
    const set = (sel, t) => { const e = a.querySelector(sel); if (e.textContent !== t) e.textContent = t; };
    set(".when", new Date(c.createdAt).toLocaleString());
    const st = a.querySelector(".st");
    st.className = "status st " + c.status; set(".st", statusNames[c.status] || c.status);
    set(".txt", (c.text || "بدون نص").slice(0, 180));
    set(".why", waitNames[c.waitReason] || (c.status === "paused" && c.pauseReason) || "");
    set(".fl", (c.files || []).map((f) => f.name).join(" · "));
    const bar = a.querySelector(".bar");
    bar.setAttribute("aria-valuenow", pct); bar.firstElementChild.style.width = pct + "%";
    set(".counts", `الإجمالي: ${n.total || 0} · أُرسل: ${n.sent || 0} · فشل: ${n.failed || 0} · غير مؤكد: ${n.unknown || 0} · متبقٍ: ${(n.pending || 0) + (n.processing || 0)}`);
    const acts = [];
    if (["queued", "running"].includes(c.status)) acts.push(["pause", "إيقاف مؤقت", ""]);
    if (c.status === "paused") acts.push(["resume", "استئناف", ""]);
    if (!["completed", "completed_with_errors", "cancelled"].includes(c.status)) acts.push(["cancel", "إلغاء الباقي", "danger"]);
    if (n.failed) acts.push(["retry", `إعادة محاولة الفاشل (${n.failed})`, ""]);
    const sig = JSON.stringify(acts);
    const ae = a.querySelector(".acts");
    if (ae.dataset.sig !== sig) {
      ae.dataset.sig = sig; ae.textContent = "";
      for (const [act, label, cls] of acts) {
        const b = document.createElement("button");
        b.type = "button"; b.dataset.action = act; b.dataset.id = c.id; b.className = cls; b.textContent = label;
        ae.append(b);
      }
    }
    const tsig = JSON.stringify((c.targets || []).map((t) => [t.threadID, t.status, t.error]));
    const tg = a.querySelector(".tg");
    if (tg.dataset.sig !== tsig) {
      tg.dataset.sig = tsig;
      tg.innerHTML = (c.targets || []).map((t) => `<div class="group"><span dir="auto">${esc(t.name || t.threadID)}</span><span class="status ${esc(t.status)}">${esc(statusNames[t.status] || t.status)}</span>${t.error ? `<small>${esc(t.error)}</small>` : ""}${t.status === "unknown" ? `<span class="row"><button type="button" data-target="${esc(t.threadID)}" data-id="${esc(c.id)}" data-tact="resolve">وصلت</button><button type="button" data-target="${esc(t.threadID)}" data-id="${esc(c.id)}" data-tact="skip">تجاهل</button></span>` : ""}</div>`).join("");
    }
  }
  function renderCampaigns(items) {
    const host = $("campaigns");
    const ids = new Set(items.map((c) => c.id));
    for (const [id, el] of nodes) if (!ids.has(id)) { el.remove(); nodes.delete(id); }
    host.querySelectorAll(".empty").forEach((e) => e.remove());
    let prev = null;
    for (const c of items) {
      let el = nodes.get(c.id);
      if (!el) { el = build(c.id); nodes.set(c.id, el); }
      fill(el, c);
      const want = prev ? prev.nextElementSibling : host.firstElementChild;
      if (want !== el) host.insertBefore(el, want);
      prev = el;
    }
    if (!items.length) host.innerHTML = '<div class="muted empty">لا توجد حملات حتى الآن.</div>';
  }
  async function loadCampaigns() {
    renderCampaigns((await api("/api/broadcast/campaigns")).campaigns || []);
  }
  $("campaigns").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-action],button[data-tact]");
    if (!b) return;
    const tact = b.dataset.tact;
    if (!tact && b.dataset.action === "cancel" && !(await confirm("سيتم إلغاء الوجهات التي لم تبدأ فقط. الرسائل المرسلة لا يمكن سحبها. متابعة؟"))) return;
    await busy(b, async () => {
      try {
        const base = `/api/broadcast/campaigns/${encodeURIComponent(b.dataset.id)}`;
        await api(tact ? `${base}/targets/${encodeURIComponent(b.dataset.target)}/${tact}` : `${base}/${b.dataset.action}`, { method: "POST" });
        await loadCampaigns();
      } catch (err) { say(err.message, "error"); }
    });
  });

  // ---- polling: paused while hidden, exponential backoff on errors ----
  function schedule() {
    clearTimeout(pollTimer);
    if (!polling || document.hidden) return;
    pollTimer = setTimeout(async () => {
      try { await loadCampaigns(); pollDelay = POLL_MIN; }
      catch (e) { pollDelay = Math.min(POLL_MAX, pollDelay * 2); }
      schedule();
    }, pollDelay);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && polling) { pollDelay = POLL_MIN; loadCampaigns().catch(() => {}); } schedule(); });
  function stopPolling() { polling = false; clearTimeout(pollTimer); }
  async function connect() {
    polling = true; pollDelay = POLL_MIN;
    try {
      limits = await api("/api/broadcast/limits");
      $("limits").textContent = `الحد لكل ملف ${size(limits.maxFileBytes)} · مجموع الملفات ${size(limits.maxTotalBytes)} · أقصى عدد وجهات ${limits.maxTargets}`;
      if (limits.ephemeralStorage) say("تنبيه: التخزين مؤقت وقد تضيع المرفقات عند إعادة النشر.", "error");
      await loadGroups(); await loadCampaigns();
    } catch (e) { say(e.message, "error"); }
    schedule();
  }

  $("refresh").addEventListener("click", (e) => busy(e.currentTarget, async () => { await loadGroups(true); await loadCampaigns().catch((x) => say(x.message, "error")); }));
  $("loadGroups").addEventListener("click", (e) => busy(e.currentTarget, () => loadGroups(true)));
  $("loadCampaigns").addEventListener("click", (e) => busy(e.currentTarget, () => loadCampaigns().catch((x) => say(x.message, "error"))));
  $("selectAll").addEventListener("click", () => { visibleGroups().forEach((g) => selected.add(g.id)); renderGroups(); updatePreview(); });
  $("clearAll").addEventListener("click", () => { visibleGroups().forEach((g) => selected.delete(g.id)); renderGroups(); updatePreview(); });
  $("groupSearch").addEventListener("input", renderGroups);
  $("groups").addEventListener("change", (e) => {
    const id = e.target.dataset && e.target.dataset.id;
    if (!id) return;
    e.target.checked ? selected.add(id) : selected.delete(id);
    countText(); updatePreview();
  });
  $("attachments").addEventListener("change", (e) => {
    const have = new Set(files.map(fileKey));
    for (const f of e.target.files) if (!have.has(fileKey(f))) files.push(f);
    e.target.value = "";
    renderFiles();
  });
  $("message").addEventListener("input", updatePreview);
  $("create").addEventListener("click", (e) => create(e.currentTarget));
  window.SB.gate({ gate: $("pinGate"), app: $("dashboard"), form: $("pinForm"), input: $("pinInput"), error: $("pinError"), logout: $("logout"), onUnlock: connect, onLock: stopPolling });
})();
