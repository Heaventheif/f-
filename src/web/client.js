// Shared dashboard client: api(), esc(), notice(), busy(), confirm dialog, login gate.
(() => {
  if (typeof window === "undefined") return; // browser-only script (importable under Bun for smoke checks)
  const SB = (window.SB = {});
  const $ = (id) => document.getElementById(id);
  SB.$ = $;
  SB.esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  SB.size = (n) => (n < 1048576 ? (n / 1024).toFixed(0) + " KB" : (n / 1048576).toFixed(1) + " MB");

  class ApiError extends Error {
    constructor(message, status, code, data) { super(message); this.status = status; this.code = code; this.data = data; }
  }
  SB.ApiError = ApiError;
  let lockHandler = () => {};
  const parse = (status, text) => {
    let d = null;
    try { d = JSON.parse(text); } catch {}
    if (d && d.ok) return d.data;
    const e = (d && d.error) || {};
    if (status === 401) lockHandler();
    throw new ApiError(e.message || (d ? "خطأ غير متوقع" : "استجابة غير صالحة من الخادم") + ` (HTTP ${status})`, status, e.code || "unknown", d && d.data);
  };
  SB.api = async (url, opts = {}) => {
    let r;
    try { r = await fetch(url, { credentials: "same-origin", ...opts }); }
    catch { throw new ApiError("تعذر الاتصال بالخادم", 0, "network"); }
    return parse(r.status, await r.text());
  };
  // XHR variant with upload progress; resolves with the envelope data.
  SB.upload = (url, formData, headers, onProgress) =>
    new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("POST", url);
      x.withCredentials = true;
      for (const [k, v] of Object.entries(headers || {})) x.setRequestHeader(k, v);
      x.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
      x.onload = () => { try { resolve(parse(x.status, x.responseText)); } catch (e) { reject(e); } };
      x.onerror = () => reject(new ApiError("تعذر الاتصال بالخادم", 0, "network"));
      x.send(formData);
    });

  SB.notice = (el, text, type = "ok") => {
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.textContent = text;
    el.className = (el.dataset.base || "") + " " + (type === "error" ? "bad error show" : "ok show");
    el.hidden = !text;
  };
  // Run fn with the button disabled for the duration.
  SB.busy = async (btn, fn) => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    try { return await fn(); } finally { btn.disabled = false; btn.removeAttribute("aria-busy"); }
  };
  SB.confirm = (message, okText = "تأكيد") =>
    new Promise((resolve) => {
      const d = document.createElement("dialog");
      d.innerHTML = `<form method="dialog"><p></p><div class="row"><button value="ok" class="primary"></button><button value="no">إلغاء</button></div></form>`;
      d.querySelector("p").textContent = message;
      d.querySelector("button[value=ok]").textContent = okText;
      d.addEventListener("close", () => { resolve(d.returnValue === "ok"); d.remove(); });
      document.body.appendChild(d);
      d.showModal();
    });

  // Login gate. opts: gate, app, form, input, error, logout, onUnlock, onLock
  SB.gate = (o) => {
    const lock = () => { o.onLock && o.onLock(); o.app.classList.add("hidden"); o.gate.classList.remove("hidden"); };
    const unlock = () => { o.gate.classList.add("hidden"); o.app.classList.remove("hidden"); o.onUnlock(); };
    lockHandler = lock;
    o.form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = o.form.querySelector("button[type=submit]");
      o.error.textContent = "";
      await SB.busy(btn, async () => {
        try {
          await SB.api("/api/dashboard/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: o.input.value }) });
          o.input.value = "";
          unlock();
        } catch (err) { o.error.textContent = err.message; o.input.select(); }
      });
    });
    o.logout.addEventListener("click", () => SB.busy(o.logout, async () => {
      try { await SB.api("/api/dashboard/logout", { method: "POST" }); } catch {}
      lock();
    }));
    SB.api("/api/dashboard/session").then((s) => (s.authenticated ? unlock() : lock()), (err) => { lock(); o.error.textContent = err.message; });
  };
})();
