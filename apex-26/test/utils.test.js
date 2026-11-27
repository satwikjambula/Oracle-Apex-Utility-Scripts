// Smoke tests: load each script into jsdom with a mocked `apex` namespace.
// Run: cd apex-26/test && npm install && npm test
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { src, makeWindow } = require("./harness");

test("apexUtils loads without the 2.x TDZ crash and exposes the 2.x surface", () => {
  const { w } = makeWindow();
  w.eval(src("apexUtils.js"));
  const { utils, debug } = w.apex.custom.util.publicFunctions;
  assert.equal(typeof utils.escapeHTML, "function");
  assert.equal(typeof debug.info, "function");
  assert.equal(w.apex.custom.util.apexVersion.major, 26);
  assert.equal(utils.isAtLeast(26, 1), true);
  assert.equal(utils.isAtLeast(26, 3), false);
});

test("collision guard still throws on double load", () => {
  const { w } = makeWindow();
  w.eval(src("apexUtils.js"));
  assert.throws(() => w.eval(src("apexUtils.js")), /Collision/);
});

test("the original 2.x files fail to load (documents the bug being fixed)", () => {
  for (const f of ["../apexUtils.js", "../igUtils.js"]) {
    const { w } = makeWindow();
    assert.throws(() => w.eval(src(f)), /before initialization|already been declared/);
  }
});

test("string and number helpers", () => {
  const { w } = makeWindow();
  w.eval(src("apexUtils.js"));
  const u = w.apex.custom.util.publicFunctions.utils;
  assert.equal(u.formatMoney(-1234567.891), "-1,234,567.89");
  assert.equal(u.formatMoney(1000, 0), "1,000");
  assert.equal(u.formatMoney(1234.5, 2, ",", "."), "1.234,50");
  assert.equal(u.cutString("abcdefghij", 6), "abc...");
  assert.equal(u.cutString("abc", 2), "ab");
  assert.equal(u.removeHTML("<b>hi</b><script>x()</script> there"), "hix() there");
  assert.equal(u.unEscapeHTML("&lt;a&gt; &amp; &#x27;"), "<a> & '");
  assert.deepEqual(JSON.parse(JSON.stringify(u.convertJSON2LowerCase({ A: [{ B: 1 }], C: null }))), { a: [{ b: 1 }], c: null });
  assert.equal(u.varType(null), "null");
  assert.equal(u.getStrByteLength("é"), 2);
  assert.equal(u.parseISOTimeString("2026-01-02T03:04:05").toISOString(), "2026-01-02T03:04:05.000Z");
  assert.equal(u.parseISOTimeString("2026-01-02T03:04:05+02:00").toISOString(), "2026-01-02T01:04:05.000Z");
  assert.equal(u.parseISOTimeString("garbage"), null);
});

test("BOOLEAN item helpers handle 26.1 native booleans and legacy Y/N", () => {
  const { w, items } = makeWindow({ items: { P1_NATIVE: true, P1_YN: "N" } });
  w.eval(src("apexUtils.js"));
  const u = w.apex.custom.util.publicFunctions.utils;
  assert.equal(u.getBooleanItem("P1_NATIVE"), true);
  assert.equal(u.getBooleanItem("P1_YN"), false);
  u.setBooleanItem("P1_NATIVE", 0);
  u.setBooleanItem("P1_YN", 1);
  assert.equal(items.P1_NATIVE, false);
  assert.equal(items.P1_YN, "Y");
});

test("refreshRegions uses multipleRefresh on 26.2 and skips missing regions", async () => {
  const regions = { a: { refresh: () => Promise.resolve() }, b: { refresh: () => Promise.resolve() } };
  const { w, calls } = makeWindow({ regions });
  w.eval(src("apexUtils.js"));
  await w.apex.custom.util.publicFunctions.utils.refreshRegions(["a", "missing", "b"]);
  assert.deepEqual([...calls.multipleRefresh[0]], ["a", "b"]);
});

test("refreshRegions falls back to per-region refresh before 26.2", async () => {
  let n = 0;
  const regions = { a: { refresh: () => { n++; return Promise.resolve(); } } };
  const { w } = makeWindow({ version: "24.2.5", regions });
  w.eval(src("apexUtils.js"));
  await w.apex.custom.util.publicFunctions.utils.refreshRegions(["a"]);
  assert.equal(n, 1);
});

test("tooltip renders text safely by default", () => {
  const { w, $ } = makeWindow();
  w.eval(src("apexUtils.js"));
  const u = w.apex.custom.util.publicFunctions.utils;
  u.tooltip.show("<img src=x onerror=alert(1)>");
  assert.equal($("#dynToolTip img").length, 0);
  u.tooltip.hide();
  assert.ok($("#dynToolTip").hasClass("cu-tooltip--hidden"));
});

test("igUtils loads, joins composite keys, and reports non-IG regions clearly", () => {
  const records = [{ id: ["10", "A"] }, { id: ["20", "B"] }];
  const model = { getRecordId: (r) => r.id, getValue: (r, c) => (c === "DEPT" ? { v: r.id[0], d: "x" } : null) };
  const fakeWidget = { length: 1, interactiveGrid() {} };
  const regions = {
    emp: { widget: () => fakeWidget, call: (m) => (m === "getSelectedRecords" ? records : { model }) },
    notIG: { widget: () => null }
  };
  const { w } = makeWindow({ regions });
  w.eval(src("igUtils.js"));
  const ig = w.apex.custom.igUtil;
  assert.equal(ig.getSelectedRecordIdsString("emp"), "10;A:20;B");
  assert.deepEqual([...ig.getSelectedColumnValues("emp", "DEPT")], ["10", "20"]);
  assert.equal(ig.checkRowsAreSelected("emp"), true);
  assert.throws(() => ig.getSelectedRecordIdsArray("notIG"), /not an Interactive Grid/);
  assert.throws(() => ig.getSelectedRecordIdsArray("nope"), /not found/);
});

test("irUtils wraps the 26.1 interactiveReportRegion selection API", () => {
  let selected = ["1", "2"];
  const regions = {
    ir: { getSelectedValues: () => selected, setSelectedValues: (v) => { selected = v; return v.length; }, element: null },
    irNoSel: { getSelectedValues: () => null }
  };
  const { w } = makeWindow({ regions });
  w.eval(src("irUtils.js"));
  const ir = w.apex.custom.irUtil;
  assert.equal(ir.getSelectedValuesString("ir"), "1:2");
  assert.equal(ir.setSelectedValues("ir", [3, 4]), 2);
  assert.deepEqual([...selected], ["3", "4"]);
  assert.throws(() => ir.getSelectedValues("irNoSel"), /row selection is not enabled/);
});
