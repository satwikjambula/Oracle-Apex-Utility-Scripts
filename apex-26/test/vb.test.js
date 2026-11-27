// Smoke tests for vbcs/vbUtils.js against a mocked apex namespace.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { src, makeWindow } = require("./harness");

function setup(opts = {}) {
  const env = makeWindow(opts);
  const { w } = env;
  const log = { process: [], errors: [], success: [], redirect: [], events: [] };
  w.apex.server.process = (name, data) => {
    log.process.push({ name, data });
    const reply = (opts.replies || {})[name];
    return Promise.resolve(typeof reply === "function" ? reply(data) : reply);
  };
  w.apex.message = {
    showErrors: (e) => log.errors.push(e[0].message),
    showPageSuccess: (m) => log.success.push(m),
    hidePageSuccess() {}
  };
  w.apex.navigation = { redirect: (u) => log.redirect.push(u) };
  w.apex.event = { trigger: (el, name, data) => log.events.push({ name, data }) };
  w.apex.page = { isChanged: () => false };
  w.eval(src("vbcs/vbUtils.js"));
  return { ...env, vb: w.apex.custom.vb, log };
}

test("page variables: defaults, item binding, proxy assignment, dirty tracking, reset", async () => {
  const items = { P10_EMP_ID: "7" };
  const { vb, w } = setup({ items });
  w.document.body.insertAdjacentHTML("beforeend", "<input id='P10_EMP_ID'>");
  vb.definePageVariables({
    empId: { type: "number", item: "P10_EMP_ID" },
    filter: { type: "object", defaultValue: { dept: null } },
    count: { type: "number", defaultValue: 0 }
  });
  assert.equal(vb.$page.get("empId"), 7);            // read from item, coerced
  assert.equal(vb.$page.isDirty(), false);

  vb.$page.variables.empId = 42;                     // VB-style direct assignment
  assert.equal(items.P10_EMP_ID, 42);                // pushed to the item
  assert.equal(vb.$page.isDirty(), true);

  items.P10_EMP_ID = "99";                           // user edits the item
  w.jQuery("#P10_EMP_ID").trigger("change");
  assert.equal(vb.$page.get("empId"), 99);           // variable follows the item

  await vb.Actions.assignVariable({}, { variable: "$page.variables.filter.dept", value: 10 });
  assert.equal(vb.$page.get("filter").dept, 10);

  await vb.Actions.resetVariables({}, { variables: ["$page.variables.filter"] });
  assert.equal(vb.$page.get("filter").dept, null);

  assert.throws(() => { vb.$page.variables.nope = 1; }, /not defined/);
});

test("application variables persist to sessionStorage", () => {
  const { vb, w } = setup();
  vb.defineApplicationVariables({ theme: { type: "string", defaultValue: "light", persisted: "session" } });
  vb.$application.variables.theme = "dark";
  assert.equal(w.sessionStorage.getItem("vb:$application.theme"), "\"dark\"");
});

test("callChain passes a VB-shaped context and returns the chain result", async () => {
  const { vb } = setup();
  vb.definePageVariables({ total: { type: "number", defaultValue: 0 } });
  vb.defineChain("add", async (context, { a, b }) => {
    context.$variables.total = a + b;
    return context.$page.get("total");
  });
  vb.defineChain("classStyle", { run: async () => "ok" });   // VB class-style chain
  assert.equal(await vb.callChain("add", { a: 2, b: 3 }), 5);
  assert.equal(await vb.Actions.callChain({}, { chain: "classStyle" }), "ok");
  await assert.rejects(vb.callChain("missing"), /not defined/);
});

test("callRest sends only an endpoint key and parses the proxy response", async () => {
  const { vb, log } = setup({
    replies: { VB_REST_PROXY: { ok: true, status: 200, headers: { etag: "x" }, body: "{\"items\":[1,2]}" } }
  });
  const res = await vb.Actions.callRest({}, { endpoint: "hr/getEmployees", uriParams: { dept: 10 } });
  assert.equal(res.ok, true);
  assert.deepEqual([...res.body.items], [1, 2]);
  const sent = log.process[0];
  assert.equal(sent.name, "VB_REST_PROXY");
  assert.equal(sent.data.x01, "hr/getEmployees");
  assert.equal(sent.data.x02, "{\"dept\":10}");
  assert.ok(!JSON.stringify(sent.data).includes("http"), "no URL leaves the browser");
});

test("callRest: !ok resolves by default, rejects with failOnError", async () => {
  const { vb } = setup({ replies: { VB_REST_PROXY: { ok: false, status: 404, error: "Unknown endpoint" } } });
  const res = await vb.Actions.callRest({}, { endpoint: "x" });
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
  await assert.rejects(vb.Actions.callRest({}, { endpoint: "x", failOnError: true }), /Unknown endpoint/);
});

test("navigateToPage gets a checksummed URL from the server", async () => {
  const { vb, log } = setup({ replies: { VB_GET_URL: { url: "/ords/r/app/emp?p10_id=7&cs=abc" } } });
  await vb.Actions.navigateToPage({}, { page: 10, params: { P10_ID: 7 } });
  assert.equal(log.process[0].data.x01, "10");
  assert.deepEqual(log.redirect, ["/ords/r/app/emp?p10_id=7&cs=abc"]);
});

test("fireNotificationEvent maps VB types to APEX messages", async () => {
  const { vb, log } = setup();
  await vb.Actions.fireNotificationEvent({}, { summary: "Saved", message: "Invoice 12", type: "confirmation" });
  await vb.Actions.fireNotificationEvent({}, { summary: "Failed", type: "error" });
  await vb.Actions.fireNotificationEvent({}, { summary: "Check totals", type: "warning" });
  assert.deepEqual(log.success, ["Saved: Invoice 12"]);
  assert.deepEqual(log.errors, ["Failed", "Warning - Check totals"]);
});

test("fireEvent runs registered listeners and raises an APEX custom event", async () => {
  const { vb, log } = setup();
  let got;
  vb.defineChain("onSaved", async (ctx, { event }) => { got = event; });
  vb.on("employeeSaved", "onSaved");
  await vb.Actions.fireEvent({}, { event: "employeeSaved", payload: { id: 9 } });
  assert.equal(got.id, 9);
  assert.equal(log.events[0].name, "employeeSaved");
});

test("fireDataProviderEvent refreshes a region", async () => {
  let refreshed = 0;
  const regions = { empReport: { widget: () => null, refresh: () => { refreshed++; } } };
  const { vb } = setup({ regions });
  await vb.Actions.fireDataProviderEvent({}, { target: "empReport", refresh: null });
  assert.equal(refreshed, 1);
});
