import { ok, fail, readJson, readJsonOptional } from "../http.js";

export function registerRequestRoutes(router, { requests }) {
  const read = { rate: "req_read" };
  const write = { rate: "req_write" };

  router.get("/api/requests", async ({ url }) => {
    const q = url.searchParams;
    return ok(await requests.listRequests({
      kind: q.get("kind") ?? undefined,
      folder: q.get("folder") ?? undefined,
      limit: q.get("limit") ?? undefined,
      cursor: q.get("cursor") ?? undefined,
    }));
  }, read);

  router.post("/api/requests/refresh/friends", async () => ok({ fetchedAt: new Date().toISOString(), friends: await requests.listFriends() }), write);
  router.post("/api/requests/refresh/messages", async ({ req }) => {
    const b = await readJsonOptional(req);
    return ok({ fetchedAt: new Date().toISOString(), messages: await requests.listMessages(b) });
  }, write);

  router.post("/api/requests/bulk", async ({ req }) => {
    const r = await requests.bulk(await readJson(req));
    if (r.ok) return ok(r.data);
    return fail("upstream", "فشلت جميع العمليات", { status: 502, data: r.data });
  }, write);

  router.post("/api/requests/messages/:id/:action", async ({ params }) => ok(await requests.handleMessage(params.id, params.action)), write);
  // Friend actions stay disabled until a verified pending-request adapter exists.
  router.post("/api/requests/friends/:id/:action", async () => fail("not_implemented", "قبول/رفض الصداقة معطّل", { status: 501 }), write);
}
