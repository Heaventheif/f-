"use strict";
// fcaCompat — طبقة توافق موحّدة بين محرّكات FCA (fca-nx الحالي) وأي forks أخرى.
// fca-nx لا يعرّض api.ctx/api.defaultFuncs (تفاصيل داخلية)، لذا تبقى الأسماء المستعارة
// آمنة: تُرجع undefined بدل الانهيار، والمكوّنات تعتمد على الواجهات الرسمية:
// api.httpGet / api.isMqttConnected / api.refreshFb_dtsg.
function defineAlias(api, alias, getter) {
  if (!api || Object.prototype.hasOwnProperty.call(api, alias)) return;
  try {
    Object.defineProperty(api, alias, { get: getter, enumerable: false, configurable: true });
  } catch (_) {}
}
export function adaptApi(api) {
  if (!api || api.__fcaCompatApplied) return api;
  // أسماء مستعارة داخلية (تتوفر فقط في المحرّكات التي تعرّضها)
  defineAlias(api, "_ctx", () => api.ctx);
  defineAlias(api, "_defaultFuncs", () => api.defaultFuncs);
  // fca-nx يوفّر refreshFb_dtsg — نوحّد الاسم لصالح بقية الكود
  if (typeof api.refreshFbDtsg !== "function" && typeof api.refreshFb_dtsg === "function") {
    api.refreshFbDtsg = (...args) => api.refreshFb_dtsg(...args);
  }
  // فحص حالة MQTT بشكل موحّد عبر المحرّكات (fca-nx: api.isMqttConnected())
  if (typeof api.isMqttConnected !== "function") {
    api.isMqttConnected = () => {
      const client = api._mqttClient ?? api._ctx?.mqttClient ?? api._ctx?.mqtt ?? api._mqtt;
      return !!(client && client.connected === true && client.disconnecting !== true && client.closed !== true);
    };
  }
  // موحّد فحص صحة الجلسة عبر HTTP (يستخدم كوكيز الجلسة الحالية داخلياً)
  if (typeof api.httpGet !== "function" && typeof api._defaultFuncs?.get === "function" && api._ctx?.jar) {
    api.httpGet = (url, form, cb) => {
      const p = api._defaultFuncs.get(url, api._ctx.jar, form || {}, api._ctx, {});
      if (typeof cb === "function") p.then(d => cb(null, d)).catch(e => cb(e, null));
      return p;
    };
  }
  if (typeof api.unsendMessage === "function") {
    const original = api.unsendMessage.bind(api);
    api.unsendMessage = (messageID, second, third) => {
      const cb = typeof second === "function" ? second : typeof third === "function" ? third : void 0;
      const result = cb ? original(messageID, cb) : original(messageID);
      if (cb && result && typeof result.catch === "function") result.catch(() => {});
      return result;
    };
  }
  api.__fcaCompatApplied = true;
  return api;
}
