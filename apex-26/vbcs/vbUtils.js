/**
 * @fileoverview VBCS-style action chain API for Oracle APEX 26.x.
 * @version 1.0.0
 * @copyright 2026 Satwik
 * @license MIT
 *
 * Gives APEX pages the programming model of Visual Builder JavaScript action chains:
 * scoped variables ($page / $application), registered chains, event listeners and an
 * `Actions` object whose method names and option shapes follow VB's built-in actions.
 * Code ported from VBCS (by hand or by a converter) can then run with small edits.
 *
 * Security model (differs from VBCS on purpose):
 *  - The browser never sends URLs or credentials. callRest sends an *endpoint key*;
 *    the server (vb_compat_pkg) looks it up in an allowlist and calls the
 *    service with an APEX Web Credential.
 *  - navigateToPage asks the server for the URL (apex_page.get_url), so Session
 *    State Protection checksums stay valid. Building f?p URLs in JS would break them.
 *
 * Not covered: $flow scope (APEX has no flows; use $page or $application),
 * Service Data Providers / business objects (use REST Data Sources + regions),
 * VB translations ($translations; use APEX Text Messages + apex.lang).
 */
(function (apex, $) {
  "use strict";

  if (!apex || !$) throw new Error("vbUtils.js: APEX core JavaScript must load first.");
  apex.custom = apex.custom || {};
  if (apex.custom.vb) throw new Error("Collision detected for apex.custom.vb");

  const MODULE = "vbUtils.js";
  const config = {
    restProcess: "VB_REST_PROXY",   // AJAX Callback name -> vb_compat_pkg.ajax_rest_proxy
    urlProcess: "VB_GET_URL",       // AJAX Callback name -> vb_compat_pkg.ajax_get_url
    storagePrefix: "vb:"
  };

  // ---------------------------------------------------------------------------
  // Variables
  // ---------------------------------------------------------------------------
  const clone = (v) => (v === undefined ? v : typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

  const coerce = (type, v) => {
    if (v === null || v === undefined) return null;
    if (v === "") return type === "string" || type === "any" ? "" : null;
    switch (type) {
      case "number": { const n = Number(v); return Number.isNaN(n) ? null : n; }
      case "boolean": return typeof v === "boolean" ? v : ["Y", "TRUE", "1", "YES"].includes(String(v).toUpperCase());
      case "string": return String(v);
      case "object": case "array": return typeof v === "string" ? JSON.parse(v) : v;
      default: return v;
    }
  };

  /** One scope ($page or $application): definitions, values, listeners, dirty tracking. */
  const createScope = (name) => {
    const defs = {};
    const values = {};
    const listeners = new Set();
    const dirty = new Set();
    let syncingItem = false;

    const storageFor = (def) =>
      def.persisted === "local" ? window.localStorage : def.persisted === "session" ? window.sessionStorage : null;

    const write = (key, raw, { fromItem = false, markDirty = true } = {}) => {
      const def = defs[key];
      if (!def) throw new Error(`${MODULE}: ${name}.variables.${key} is not defined`);
      const oldValue = values[key];
      const value = coerce(def.type, raw);
      values[key] = value;

      if (def.item && !fromItem) {
        syncingItem = true;
        try {
          const itemVal = typeof value === "object" && value !== null ? JSON.stringify(value) : value;
          apex.item(def.item).setValue(itemVal ?? "", null, true); // suppress change event
        } finally { syncingItem = false; }
      }
      const store = storageFor(def);
      if (store) {
        try { store.setItem(config.storagePrefix + name + "." + key, JSON.stringify(value)); } catch { /* quota */ }
      }
      if (markDirty && def.trackDirty !== false && JSON.stringify(oldValue) !== JSON.stringify(value)) dirty.add(key);
      listeners.forEach((fn) => {
        try { fn({ name: key, oldValue, value, scope: name }); } catch (err) { apex.debug.error(MODULE, err); }
      });
    };

    const define = (definitions) => {
      Object.entries(definitions).forEach(([key, def]) => {
        defs[key] = { type: "any", defaultValue: null, ...def };
        // Precedence: persisted value > current item value (server session state) > defaultValue
        let initial = clone(defs[key].defaultValue);
        let fromItem = false;
        const store = storageFor(defs[key]);
        const saved = store && store.getItem(config.storagePrefix + name + "." + key);
        if (saved !== null && saved !== undefined) {
          try { initial = JSON.parse(saved); } catch { /* ignore bad value */ }
        } else if (def.item) {
          const itemVal = apex.item(def.item).getValue();
          if (itemVal !== "" && itemVal !== null && itemVal !== undefined) { initial = itemVal; fromItem = true; }
        }
        write(key, initial, { markDirty: false, fromItem });
        if (def.item) {
          $(`#${$.escapeSelector(def.item)}`).on("change", () => {
            if (!syncingItem) write(key, apex.item(def.item).getValue(), { fromItem: true });
          });
        }
      });
    };

    // `$page.variables.x = 1` routes through write(); nested mutation (x.y = 1) is NOT tracked.
    const proxy = new Proxy(values, {
      set: (_, key, v) => { write(key, v); return true; },
      deleteProperty: () => false
    });

    return {
      name,
      define,
      variables: proxy,
      get: (key) => values[key],
      set: (key, v) => write(key, v),
      reset: (keys = Object.keys(defs)) => keys.forEach((k) => {
        write(k, clone(defs[k].defaultValue), { markDirty: false });
        dirty.delete(k);
      }),
      onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      isDirty: () => dirty.size > 0,
      resetDirty: () => dirty.clear(),
      has: (key) => key in defs
    };
  };

  const scopes = { $page: createScope("$page"), $application: createScope("$application") };

  /** "$page.variables.emp.name" -> { scope, key: "emp", path: ["name"] } */
  const parsePath = (path) => {
    const m = /^(\$page|\$application|\$variables)\.(?:variables\.)?([^.[\]]+)(.*)$/.exec(String(path).trim());
    if (!m) throw new Error(`${MODULE}: bad variable path "${path}" (expected $page.variables.x or $application.variables.x)`);
    const scope = scopes[m[1] === "$variables" ? "$page" : m[1]];
    const rest = m[3].replace(/\[(\w+)\]/g, ".$1").split(".").filter(Boolean);
    return { scope, key: m[2], path: rest };
  };

  // ---------------------------------------------------------------------------
  // Chains, events, context
  // ---------------------------------------------------------------------------
  const chains = new Map();
  const eventListeners = new Map(); // eventName -> [{ chain, filter }]

  const buildContext = (chainName, params) => ({
    $page: scopes.$page,
    $application: scopes.$application,
    $variables: scopes.$page.variables, // VB page-chain shorthand
    $chain: { name: chainName, params: params || {} },
    $apex: apex
  });

  const runChain = async (chainName, params) => {
    const fn = chains.get(chainName);
    if (!fn) throw new Error(`${MODULE}: action chain "${chainName}" is not defined`);
    apex.debug.info(`${MODULE}: run chain ${chainName}`, params);
    return fn(buildContext(chainName, params), params || {});
  };

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------
  const notify = ({ summary = "", message = "", type = "error", displayMode = "persist" } = {}) => {
    const text = summary && message ? `${summary}: ${message}` : summary || message;
    if (type === "error" || type === "warning") {
      apex.message.showErrors([{ type: "error", location: "page", message: type === "warning" ? `Warning - ${text}` : text, unsafe: false }]);
    } else {
      apex.message.showPageSuccess(text);
      if (displayMode === "transient") setTimeout(() => apex.message.hidePageSuccess(), 5000);
    }
  };

  // ---------------------------------------------------------------------------
  // Actions (names follow VB built-in JavaScript actions)
  // ---------------------------------------------------------------------------
  const Actions = {
    /** { variable: "$page.variables.x" | "$page.variables.emp.name", value } */
    assignVariable: async (context, { variable, value }) => {
      const { scope, key, path } = parsePath(variable);
      if (!path.length) { scope.set(key, clone(value)); return; }
      const copy = clone(scope.get(key)) ?? {};
      let node = copy;
      path.slice(0, -1).forEach((p) => { node[p] = node[p] ?? {}; node = node[p]; });
      node[path[path.length - 1]] = clone(value);
      scope.set(key, copy);
    },

    /** { variables: ["$page.variables.x", "$application.variables.y"] } — omit to reset all page variables. */
    resetVariables: async (context, { variables } = {}) => {
      if (!variables) { scopes.$page.reset(); return; }
      variables.forEach((v) => { const { scope, key } = parsePath(v); scope.reset([key]); });
    },

    callChain: async (context, { chain, params }) => runChain(chain, params),

    /** Runs functions concurrently, like VB "Run In Parallel". Returns results by index. */
    runInParallel: async (context, blocks) => Promise.all(blocks.map((b) => b())),

    /**
     * { endpoint: "hr/getEmployee", uriParams: { id: 7 }, body, headers }
     * Resolves { ok, status, headers, body } like VB. Pass failOnError: true to reject on !ok.
     */
    callRest: async (context, { endpoint, uriParams = {}, body = null, headers = {}, failOnError = false }) => {
      if (!endpoint) throw new Error(`${MODULE}: callRest needs an endpoint key`);
      let res;
      try {
        res = await apex.server.process(config.restProcess, {
          x01: endpoint,
          x02: JSON.stringify(uriParams),
          x03: body === null ? "" : JSON.stringify(body),
          x04: JSON.stringify(headers)
        }, { dataType: "json" });
      } catch (jqXHR) {
        res = { ok: false, status: (jqXHR && jqXHR.status) || 0, body: null, error: "AJAX call to proxy failed" };
      }
      let parsed = res.body;
      if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { /* keep text */ } }
      const result = { ok: !!res.ok, status: res.status, headers: res.headers || {}, body: parsed, message: res.error };
      if (!result.ok && failOnError) {
        const err = new Error(res.error || `REST call ${endpoint} failed with status ${res.status}`);
        err.result = result;
        throw err;
      }
      return result;
    },

    /** { summary, message, type: "error"|"warning"|"info"|"confirmation", displayMode: "persist"|"transient" } */
    fireNotificationEvent: async (context, opts) => notify(opts),

    /**
     * { page: 10, params: { P10_EMP_ID: 7 }, history: "push"|"replace" } — URL comes from the server.
     * Or { url } to skip the server round trip for a URL you already have.
     */
    navigateToPage: async (context, { page, params = {}, history = "push", url, clearCache } = {}) => {
      let target = url;
      if (!target) {
        const res = await apex.server.process(config.urlProcess, {
          x01: String(page),
          x02: JSON.stringify(params),
          x03: clearCache === undefined ? "" : String(clearCache)
        }, { dataType: "json" });
        if (!res || !res.url) throw new Error(`${MODULE}: could not build URL for page ${page}: ${res && res.error}`);
        target = res.url;
      }
      if (history === "replace") window.location.replace(target);
      else apex.navigation.redirect(target);
    },

    navigateBack: async () => window.history.back(),

    /** { url, windowName } — windowName "_self" (default) redirects, anything else opens a window. */
    openUrl: async (context, { url, windowName = "_self" }) => {
      if (windowName === "_self") apex.navigation.redirect(url);
      else window.open(url, windowName, "noopener");
    },

    /**
     * Fires a custom event. Listeners registered with vb.on() run, and an APEX
     * custom event of the same name fires on document, so Dynamic Actions
     * (When: Custom Event, Selection: JavaScript Expression `document`) can react too.
     */
    fireEvent: async (context, { event, payload }) => {
      const listeners = eventListeners.get(event) || [];
      const results = await Promise.all(listeners.map((l) => runChain(l.chain, { event: payload })));
      apex.event.trigger(document, event, payload);
      return results;
    },

    /**
     * Map of VB "Fire Data Provider Event" to an APEX region.
     * { target: "regionDomId", refresh: null } -> region refresh
     * { target, mutate: { update: { keys: [...] } } } -> IG: re-fetch those records; others: refresh
     * Assumes the server-side change already happened (as in VB); nothing is marked dirty.
     */
    fireDataProviderEvent: async (context, { target, refresh, mutate, add, update, remove }) => {
      const region = apex.region(target);
      if (!region) throw new Error(`${MODULE}: region "${target}" not found`);
      const updateKeys = ((mutate && mutate.update) || update || {}).keys;
      const isIG = region.widget && region.widget() && typeof region.widget().interactiveGrid === "function";
      if (isIG && updateKeys && !refresh && !(mutate && (mutate.add || mutate.remove)) && !add && !remove) {
        const model = region.call("getCurrentView").model;
        const records = updateKeys.map((k) => model.getRecord(k)).filter(Boolean);
        if (records.length) { model.fetchRecords(records); return; }
      }
      return region.refresh();
    },

    /** { regionId | item, method, params: [] } -> apex.region(id).call(method, ...params) or apex.item(item)[method](...) */
    callComponent: async (context, { regionId, item, method, params = [] }) => {
      if (item) return apex.item(item)[method](...params);
      return apex.region(regionId).call(method, ...params);
    },

    /** "dirty" | "notDirty" — combines tracked VB variables with APEX page item changes. */
    getDirtyDataStatus: async () =>
      ({ status: scopes.$page.isDirty() || apex.page.isChanged() ? "dirty" : "notDirty" }),

    resetDirtyDataStatus: async () => { scopes.$page.resetDirty(); },

    getLocation: async (context, { maximumAge = 0, timeout = 10000, enableHighAccuracy = false } = {}) =>
      new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { maximumAge, timeout, enableHighAccuracy })),

    share: async (context, { title, text, url }) => {
      if (!navigator.share) throw new Error(`${MODULE}: Web Share API not supported in this browser`);
      return navigator.share({ title, text, url });
    }
  };

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  apex.custom.vb = {
    Actions,
    config,

    /** Page variables. def: { type, defaultValue, item: "P10_X", trackDirty } */
    definePageVariables: (defs) => scopes.$page.define(defs),
    /** Application variables. def adds persisted: "session" | "local" */
    defineApplicationVariables: (defs) => scopes.$application.define(defs),

    $page: scopes.$page,
    $application: scopes.$application,

    /** Registers a chain: async (context, params) => {...}  (VB: class with run(context, params)) */
    defineChain: (name, fn) => {
      const impl = typeof fn === "function" ? fn : fn && typeof fn.run === "function" ? fn.run.bind(fn) : null;
      if (!impl) throw new Error(`${MODULE}: chain "${name}" must be a function or have run()`);
      chains.set(name, impl);
    },

    callChain: runChain,

    /** Event listener: vb.on("employeeSaved", "refreshEmployees") */
    on: (eventName, chainName) => {
      const list = eventListeners.get(eventName) || [];
      list.push({ chain: chainName });
      eventListeners.set(eventName, list);
    },

    /**
     * Binds a chain to a DOM event, like a VB component event listener.
     * vb.bind("#SAVE", "click", "saveEmployee") — params get { event, value }.
     */
    bind: (selector, domEvent, chainName) =>
      $(document).on(domEvent, selector, (event) => {
        runChain(chainName, { event, value: event.target && event.target.value })
          .catch((err) => notify({ summary: "Unexpected error", message: err.message }));
      }),

    /** vbEnter equivalent: runs once the page is ready. */
    onPageEnter: (chainName, params) => $(() => runChain(chainName, params)
      .catch((err) => notify({ summary: "Page load failed", message: err.message }))),

    /** vbBeforeExit equivalent: warns when tracked variables are dirty. */
    warnOnDirtyExit: () => window.addEventListener("beforeunload", (e) => {
      if (scopes.$page.isDirty()) { e.preventDefault(); e.returnValue = ""; }
    })
  };
})(window.apex, window.apex && window.apex.jQuery);
