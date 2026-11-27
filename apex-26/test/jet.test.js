// Smoke tests for jet/jetUtils.js (standalone AMD module) and apex-26/jet/apexJetUtils.js.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { src, makeWindow } = require("./harness");

// ---- standalone module: load with a stub AMD define and fake JET classes ----------
function loadJetUtils() {
  class FakeMADP { constructor(data, opts) { this.data = data; this.opts = opts; } }
  class FakeREST { constructor(opts) { this.opts = opts; } }
  class FakeNum { constructor(o) { this.o = o; } format(v) { return `N(${v})`; } }
  class FakeDate { constructor(o) { this.o = o; } format(v) { return `D(${v})`; } }
  let exported;
  const sandbox = {
    define: (deps, factory) => {
      exported = factory(FakeMADP, { RESTDataProvider: FakeREST }, { IntlNumberConverter: FakeNum }, { IntlDateTimeConverter: FakeDate });
    },
    URL, Request: class { constructor(url, init) { this.url = url; this.headers = init && init.headers; } },
    window: { location: { href: "https://app.example.test/" } },
    setTimeout, clearTimeout, AbortController
  };
  vm.runInNewContext(src("../jet/jetUtils.js"), sandbox);
  return exported;
}

test("madp upsert/remove keep the provider's key attribute", () => {
  const j = loadJetUtils();
  const dp = j.madp.create([{ InvoiceId: 1, amt: 10 }], "InvoiceId");
  j.madp.upsert(dp, [{ InvoiceId: 1, amt: 99 }, { InvoiceId: 2, amt: 5 }]);
  assert.deepEqual([...dp.data.map((r) => r.amt)], [99, 5]);
  j.madp.remove(dp, 1);
  assert.deepEqual([...dp.data.map((r) => r.InvoiceId)], [2]);
});

test("toFusionQ builds v2 expression syntax with escaping", () => {
  const j = loadJetUtils();
  const q = j.toFusionQ({
    op: "$and",
    criteria: [
      { op: "$eq", attribute: "Status", value: "O'PEN" },
      { op: "$gt", attribute: "Amount", value: 100 },
      { op: "$or", criteria: [{ op: "$co", attribute: "Supplier", value: "50%" }, { op: "$ne", attribute: "Type", value: "X" }] }
    ]
  });
  assert.equal(q, "(Status = 'O''PEN' and Amount > 100 and (Supplier LIKE '%50\\%%' or Type <> 'X'))");
  assert.equal(j.toFusionQ({ op: "$sw", attribute: "Name", value: "ab" }, { caseInsensitive: true }), "UPPER(Name) LIKE UPPER('ab%')");
  assert.throws(() => j.toFusionQ({ op: "$eq", attribute: "1=1 or X", value: 1 }), /invalid attribute/);
  assert.equal(j.toFusionOrderBy([{ attribute: "A", direction: "descending" }, { attribute: "B" }]), "A:desc,B:asc");
});

test("toOrdsQ maps JET criteria to an ORDS filter object", () => {
  const j = loadJetUtils();
  const q = j.toOrdsQ({ op: "$and", criteria: [{ op: "$eq", attribute: "deptno", value: 10 }, { op: "$sw", attribute: "ename", value: "K" }] },
    [{ attribute: "sal", direction: "descending" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(q)), {
    $and: [{ deptno: { $eq: 10 } }, { ename: { $like: "K%" } }],
    $orderby: { sal: "desc" }
  });
});

test("fusionRestDataProvider request/response transforms", async () => {
  const j = loadJetUtils();
  const dp = j.fusionRestDataProvider({ url: "https://fa.test/fscmRestApi/resources/11.13.18.05/invoices", keyAttributes: "InvoiceId", fields: "InvoiceId,InvoiceAmount" });
  const t = dp.opts.transforms.fetchFirst;
  const req = await t.request({
    url: dp.opts.url,
    fetchParameters: { size: 25, offset: 50, filterCriterion: { op: "$eq", attribute: "Status", value: "OPEN" }, sortCriteria: [{ attribute: "InvoiceDate", direction: "descending" }] }
  });
  const u = new URL(req.url);
  assert.equal(u.searchParams.get("limit"), "25");
  assert.equal(u.searchParams.get("offset"), "50");
  assert.equal(u.searchParams.get("q"), "Status = 'OPEN'");
  assert.equal(u.searchParams.get("orderBy"), "InvoiceDate:desc");
  assert.equal(u.searchParams.get("onlyData"), "true");
  assert.equal(req.headers["REST-Framework-Version"], "2");
  const out = await t.response({ body: { items: [{ InvoiceId: 1 }], hasMore: true, totalResults: 300 } });
  assert.equal(out.data.length, 1);
  assert.equal(out.hasMore, true);
  assert.equal(out.totalSize, 300);
});

test("fetchAll walks an async iterator and respects maxRows", async () => {
  const j = loadJetUtils();
  const pages = [[1, 2], [3, 4], [5]];
  const dp = {
    fetchFirst: () => ({
      [Symbol.asyncIterator]: () => {
        let i = 0;
        return { next: async () => ({ value: { data: pages[i] }, done: ++i >= pages.length }) };
      }
    })
  };
  assert.deepEqual([...(await j.fetchAll(dp))], [1, 2, 3, 4, 5]);
  assert.deepEqual([...(await j.fetchAll(dp, { maxRows: 3 }))], [1, 2, 3]);
});

test("messages: add, auto-timeout for confirmations, remove", async () => {
  const j = loadJetUtils();
  const m = j.createMessages();
  const errId = m.error("Save failed", "500");
  m.confirmation("Saved", "", { autoTimeout: 10 });
  assert.equal(m.dataProvider.data.length, 2);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual([...m.dataProvider.data.map((x) => x.id)], [errId]);   // confirmation timed out, error stays
  m.remove(errId);
  assert.equal(m.dataProvider.data.length, 0);
});

test("getSelfLinkId reads the Fusion self link", () => {
  const j = loadJetUtils();
  assert.equal(j.getSelfLinkId({ links: [{ rel: "self", href: "https://fa/x/invoices/300100%3A1" }] }), "300100:1");
});

// ---- APEX chart helpers -----------------------------------------------------------
test("apexJetUtils chart.init composes options for a JET chart", () => {
  const { w } = makeWindow();
  w.eval(src("jet/apexJetUtils.js"));
  const c = w.apex.custom.jet.chart;
  const opts = c.init(
    c.valueFormat({ style: "currency", currency: "USD", maximumFractionDigits: 0 }),
    c.colors(["#111", "#222"]),
    c.referenceLine({ value: 100, text: "Target" }),
    c.legend("none"),
    c.tooltip((ctx) => `<b>${ctx.value}</b>`)
  )({ yAxis: { title: "Revenue" } });

  assert.equal(opts.yAxis.title, "Revenue");                       // existing options kept
  assert.equal(opts.yAxis.tickLabel.converter.format(1234), "$1,234");
  assert.equal(opts.valueFormats.value.converter.format(5), "$5");
  assert.deepEqual([...opts.styleDefaults.colors], ["#111", "#222"]);
  assert.equal(opts.yAxis.referenceObjects[0].value, 100);
  assert.equal(opts.legend.rendered, "off");
  const tip = opts.tooltip.renderer({ value: 7 }).insert;
  assert.equal(tip.textContent, "<b>7</b>");                       // rendered as text, not HTML
});

test("apexJetUtils.load rejects clearly when RequireJS is absent", async () => {
  const { w } = makeWindow();
  w.eval(src("jet/apexJetUtils.js"));
  await assert.rejects(w.apex.custom.jet.load(["ojs/ojconverter-number"]), /RequireJS\/JET not on this page/);
});
