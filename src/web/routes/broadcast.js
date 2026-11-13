import { AppError } from "../../infra/errors.js";
import { ok, readJsonOptional, readForm } from "../http.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const needId = (id) => {
  if (!UUID.test(id)) throw new AppError("not_found", "الحملة غير موجودة");
  return id;
};

export function registerBroadcastRoutes(router, { broadcast }) {
  const read = { rate: "bc_read" };
  const write = { rate: "bc_write" };

  router.get("/api/broadcast/limits", async () => { await broadcast.init(); return ok(broadcast.limits()); }, read);
  router.get("/api/broadcast/groups", async ({ url }) => ok({ groups: await broadcast.listGroups({ force: url.searchParams.get("refresh") === "1" }) }), read);
  router.get("/api/broadcast/campaigns", async () => ok({ campaigns: await broadcast.list() }), read);
  router.get("/api/broadcast/campaigns/:id", async ({ params }) => {
    const campaign = await broadcast.get(needId(params.id));
    if (!campaign) throw new AppError("not_found", "الحملة غير موجودة");
    return ok({ campaign });
  }, read);

  router.post("/api/broadcast", async ({ req }) => {
    const lim = broadcast.limits();
    const form = await readForm(req, lim.maxTotalBytes + 1024 * 1024);
    let targetIds;
    try { targetIds = JSON.parse(String(form.get("targetIds") || "[]")); } catch { throw new AppError("bad_request", "قائمة المجموعات غير صالحة"); }
    const files = form.getAll("files").filter((v) => v && typeof v.arrayBuffer === "function" && typeof v.name === "string" && v.name);
    const { campaign, replay } = await broadcast.create({
      text: String(form.get("text") || ""),
      targetIds,
      files,
      idempotencyKey: req.headers.get("idempotency-key") ?? undefined,
    });
    return ok({ campaign, replay }, { status: replay ? 200 : 201 });
  }, write);

  router.post("/api/broadcast/campaigns/:id/targets/:threadID/:action", async ({ params }) =>
    ok({ campaign: await broadcast.controlTarget(needId(params.id), params.threadID, params.action) }), write);
  router.post("/api/broadcast/campaigns/:id/:action", async ({ params, req }) => {
    await readJsonOptional(req, 4096);
    return ok({ campaign: await broadcast.control(needId(params.id), params.action) });
  }, write);
}
