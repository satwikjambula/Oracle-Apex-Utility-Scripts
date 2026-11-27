// Shared jsdom + mocked `apex` namespace for the smoke tests.
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const src = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const jquerySrc = fs.readFileSync(require.resolve("jquery/dist/jquery.js"), "utf8");

function makeWindow({ version = "26.2.0", items = {}, regions = {} } = {}) {
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only", url: "https://example.test/" });
  const w = dom.window;
  w.TextEncoder = TextEncoder; // present in every browser, missing from jsdom
  w.eval(jquerySrc);
  const $ = w.jQuery;
  const calls = { multipleRefresh: [], refresh: [] };
  w.apex = {
    jQuery: $,
    env: { APEX_VERSION: version },
    debug: { error() {}, warn() {}, info() {} },
    util: {
      escapeHTML: (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;"),
      debounce: (fn) => fn,
      showSpinner: (c) => $("<span class='u-Processing'>").appendTo(c),
      applyTemplate: (t) => t
    },
    locale: { getDecimalSeparator: () => ".", getGroupSeparator: () => ",", getLanguage: () => "en-US" },
    server: { chunk: (s) => [s] },
    message: {},
    item: (name) => ({
      getValue: () => items[name],
      setValue: (v) => { items[name] = v; }
    }),
    region: Object.assign((id) => regions[id], {
      isRegion: (id) => id in regions,
      ...(version.startsWith("26.2") ? { multipleRefresh: (ids) => { calls.multipleRefresh.push(ids); return Promise.resolve(); } } : {})
    })
  };
  return { w, $, items, calls };
}

module.exports = { src, makeWindow };
