/**
 * @fileoverview Utility module for Oracle JET apps and Visual Builder (VBCS) apps.
 * @version 1.0.0
 * @copyright 2026 Satwik
 * @license MIT
 *
 * AMD module (RequireJS), so it loads in VBCS and in JET apps:
 *   VBCS:  put it under resources/js/ and declare it in the page/app "imports"
 *          (or define(['resources/js/jetUtils'], ...) in a page module).
 *   JET:   define(['jetUtils'], (jetUtils) => ...)   or import via path mapping.
 *
 * Targets JET 19/20 (Redwood, Core Pack). Uses MutableArrayDataProvider, not the
 * knockout-based ArrayDataProvider, as the JET docs recommend.
 */
define([
  "ojs/ojmutablearraydataprovider",
  "ojs/ojrestdataprovider",
  "ojs/ojconverter-number",
  "ojs/ojconverter-datetime"
], function (MutableArrayDataProvider, RESTDataProviderModule, NumberConverterModule, DateTimeConverterModule) {
  "use strict";

  // These modules export a class directly or as a named member depending on build.
  const RESTDataProvider = RESTDataProviderModule.RESTDataProvider || RESTDataProviderModule;
  const IntlNumberConverter = NumberConverterModule.IntlNumberConverter || NumberConverterModule;
  const IntlDateTimeConverter = DateTimeConverterModule.IntlDateTimeConverter || DateTimeConverterModule;

  const toArray = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

  // ---------------------------------------------------------------------------
  // In-memory data providers (MutableArrayDataProvider)
  // ---------------------------------------------------------------------------
  // MADP doesn't expose its keyAttributes, so remember them for providers made here.
  const keyAttrs = new WeakMap();
  const keyOf = (dp, explicit) => explicit || keyAttrs.get(dp) || "id";

  /** MADP can only change when `data` is replaced, so these helpers build a new array each time. */
  const madp = {
    create: (rows = [], keyAttributes = "id", options = {}) => {
      const dp = new MutableArrayDataProvider(rows.slice(), { keyAttributes, ...options });
      keyAttrs.set(dp, keyAttributes);
      return dp;
    },

    /** Insert or replace rows by key. */
    upsert: (dp, rows, keyAttribute) => {
      const key = keyOf(dp, keyAttribute);
      const incoming = new Map(toArray(rows).map((r) => [r[key], r]));
      const next = dp.data.map((r) => (incoming.has(r[key]) ? incoming.get(r[key]) : r));
      const existing = new Set(dp.data.map((r) => r[key]));
      incoming.forEach((r, k) => { if (!existing.has(k)) next.push(r); });
      dp.data = next;
      return dp;
    },

    /** Remove rows whose key is in keys. */
    remove: (dp, keys, keyAttribute) => {
      const key = keyOf(dp, keyAttribute);
      const drop = new Set(toArray(keys));
      dp.data = dp.data.filter((r) => !drop.has(r[key]));
      return dp;
    },

    clear: (dp) => { dp.data = []; return dp; }
  };

  // ---------------------------------------------------------------------------
  // Read every row from any DataProvider
  // ---------------------------------------------------------------------------
  /** Walks fetchFirst() to the end. maxRows guards against unbounded server reads. */
  const fetchAll = async (dataProvider, { size = 500, maxRows = 10000, ...params } = {}) => {
    const iterator = dataProvider.fetchFirst({ size, ...params })[Symbol.asyncIterator]();
    const rows = [];
    for (;;) {
      const result = await iterator.next();
      if (result.value && result.value.data) rows.push(...result.value.data);
      if (result.done || rows.length >= maxRows) break;
    }
    return rows.slice(0, maxRows);
  };

  // ---------------------------------------------------------------------------
  // Filter / sort translation: JET criteria -> Fusion REST and ORDS REST
  // ---------------------------------------------------------------------------
  const quoteFusion = (v) => (typeof v === "number" || typeof v === "boolean" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  const FUSION_OPS = { $eq: "=", $ne: "<>", $lt: "<", $le: "<=", $gt: ">", $ge: ">=" };

  /**
   * JET FilterCriterion -> Fusion REST `q` (e.g. "(Status = 'OPEN' and Amount > 100)").
   * Expression syntax of REST framework version 2+ (send REST-Framework-Version >= 2;
   * version 1 uses query-by-example syntax and `*` wildcards, which this does not produce).
   * Supports $eq $ne $lt $le $gt $ge $co $sw $ew and $and / $or nesting.
   * options.caseInsensitive wraps text matches in UPPER().
   */
  const toFusionQ = (fc, { caseInsensitive = false } = {}) => {
    if (!fc) return "";
    if (fc.op === "$and" || fc.op === "$or") {
      const parts = (fc.criteria || []).map((c) => toFusionQ(c, { caseInsensitive })).filter(Boolean);
      return parts.length > 1 ? `(${parts.join(fc.op === "$and" ? " and " : " or ")})` : parts[0] || "";
    }
    const { op, attribute, value } = fc;
    if (!/^[A-Za-z_][\w.]*$/.test(attribute || "")) throw new Error(`jetUtils.toFusionQ: invalid attribute "${attribute}"`);
    if (FUSION_OPS[op]) return `${attribute} ${FUSION_OPS[op]} ${quoteFusion(value)}`;
    const v = String(value).replace(/'/g, "''").replace(/[%_\\]/g, (c) => `\\${c}`);
    const pattern = op === "$co" ? `%${v}%` : op === "$sw" ? `${v}%` : op === "$ew" ? `%${v}` : null;
    if (pattern === null) throw new Error(`jetUtils.toFusionQ: unsupported operator ${op}`);
    return caseInsensitive ? `UPPER(${attribute}) LIKE UPPER('${pattern}')` : `${attribute} LIKE '${pattern}'`;
  };

  /** JET SortCriterion[] -> Fusion `orderBy` ("Name:asc,Amount:desc"). */
  const toFusionOrderBy = (sortCriteria) =>
    toArray(sortCriteria).map((s) => `${s.attribute}:${s.direction === "descending" ? "desc" : "asc"}`).join(",");

  /**
   * JET FilterCriterion -> ORDS filter object for `q=` (ORDS uses $-operators natively).
   * $co/$sw/$ew -> $instr / $like.
   */
  const toOrdsQ = (fc, sortCriteria) => {
    const map = (c) => {
      if (!c) return {};
      if (c.op === "$and" || c.op === "$or") return { [c.op]: (c.criteria || []).map(map) };
      const v = c.value;
      switch (c.op) {
        case "$co": return { [c.attribute]: { $instr: v } };
        case "$sw": return { [c.attribute]: { $like: `${v}%` } };
        case "$ew": return { [c.attribute]: { $like: `%${v}` } };
        default: return { [c.attribute]: { [c.op]: v } };
      }
    };
    const q = map(fc);
    const sort = toArray(sortCriteria);
    if (sort.length) {
      q.$orderby = Object.fromEntries(sort.map((s) => [s.attribute, s.direction === "descending" ? "desc" : "asc"]));
    }
    return q;
  };

  // ---------------------------------------------------------------------------
  // REST data providers for Fusion Applications and ORDS
  // ---------------------------------------------------------------------------
  const restCapabilities = {
    sort: { attributes: "multiple" },
    filter: { operators: ["$eq", "$ne", "$lt", "$le", "$gt", "$ge", "$co", "$sw", "$ew", "$and", "$or"] }
  };

  /**
   * RESTDataProvider for an Oracle Fusion Applications REST resource
   * (limit/offset/totalResults/q/orderBy; response { items, hasMore, totalResults }).
   *   fusionRestDataProvider({ url: ".../invoices", keyAttributes: "InvoiceId",
   *                            fields: "InvoiceId,InvoiceNumber,InvoiceAmount", finder: "PrimaryKey;..." })
   * In VBCS, point url at the service connection proxy path, not the Fusion host directly.
   */
  const fusionRestDataProvider = ({ url, keyAttributes, fields, finder, onlyData = true, frameworkVersion = "2", caseInsensitive = false, headers = {}, ...rest }) =>
    new RESTDataProvider({
      url,
      keyAttributes,
      capabilities: restCapabilities,
      ...rest,
      transforms: {
        fetchFirst: {
          request: async (options) => {
            const u = new URL(options.url, window.location.href);
            const { size, offset, filterCriterion, sortCriteria } = options.fetchParameters;
            u.searchParams.set("limit", String(size));
            u.searchParams.set("offset", String(offset || 0));
            u.searchParams.set("totalResults", "true");
            if (onlyData) u.searchParams.set("onlyData", "true");
            if (fields) u.searchParams.set("fields", fields);
            if (finder) u.searchParams.set("finder", finder);
            const q = toFusionQ(filterCriterion, { caseInsensitive });
            if (q) u.searchParams.set("q", q);
            const orderBy = toFusionOrderBy(sortCriteria);
            if (orderBy) u.searchParams.set("orderBy", orderBy);
            return new Request(u.href, {
              headers: { Accept: "application/json", "REST-Framework-Version": String(frameworkVersion), ...headers }
            });
          },
          response: async ({ body }) => ({
            data: body.items || [],
            hasMore: !!body.hasMore,
            totalSize: body.totalResults
          })
        }
      }
    });

  /** RESTDataProvider for an ORDS (AutoREST or handler) collection: { items, hasMore }. */
  const ordsRestDataProvider = ({ url, keyAttributes, headers = {}, ...rest }) =>
    new RESTDataProvider({
      url,
      keyAttributes,
      capabilities: restCapabilities,
      ...rest,
      transforms: {
        fetchFirst: {
          request: async (options) => {
            const u = new URL(options.url, window.location.href);
            const { size, offset, filterCriterion, sortCriteria } = options.fetchParameters;
            u.searchParams.set("limit", String(size));
            u.searchParams.set("offset", String(offset || 0));
            const q = toOrdsQ(filterCriterion, sortCriteria);
            if (Object.keys(q).length) u.searchParams.set("q", JSON.stringify(q));
            return new Request(u.href, { headers: { Accept: "application/json", ...headers } });
          },
          response: async ({ body }) => ({ data: body.items || [], hasMore: !!body.hasMore })
        }
      }
    });

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------
  /**
   * fetch + JSON with a timeout and readable errors. Fusion error bodies (title/detail,
   * or o:errorDetails) are surfaced in error.message. error.status / error.body are set.
   */
  const fetchJson = async (url, { timeout = 30000, method = "GET", body, headers = {}, ...init } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
        body: body === undefined || typeof body === "string" ? body : JSON.stringify(body),
        signal: controller.signal,
        ...init
      });
      const text = await res.text();
      let parsed = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      if (!res.ok) {
        const detail = parsed && typeof parsed === "object"
          ? parsed.detail || parsed.title || (parsed["o:errorDetails"] && parsed["o:errorDetails"].map((d) => d.detail).join("; ")) || parsed.message
          : parsed;
        const err = new Error(`${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`);
        err.status = res.status;
        err.body = parsed;
        throw err;
      }
      return parsed;
    } catch (err) {
      if (err.name === "AbortError") {
        const e = new Error(`Request timed out after ${timeout} ms: ${url}`);
        e.status = 0;
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  // ---------------------------------------------------------------------------
  // Converters / formatting (JET Intl converters, session locale from JET config)
  // ---------------------------------------------------------------------------
  const converters = {
    number: (options = {}) => new IntlNumberConverter(options),
    currency: (currency = "USD", options = {}) => new IntlNumberConverter({ style: "currency", currency, ...options }),
    percent: (options = {}) => new IntlNumberConverter({ style: "percent", ...options }),
    date: (options = { formatType: "date", dateFormat: "medium" }) => new IntlDateTimeConverter(options),
    dateTime: (options = { formatType: "datetime", dateFormat: "medium", timeFormat: "short" }) => new IntlDateTimeConverter(options)
  };

  const cache = new Map();
  const cached = (kind, options) => {
    const k = kind + JSON.stringify(options || {});
    if (!cache.has(k)) cache.set(k, converters[kind](options));
    return cache.get(k);
  };

  /** Formats a number with a cached JET converter (or a converter you pass). */
  const formatNumber = (value, optionsOrConverter = {}) => {
    if (value === null || value === undefined || value === "") return "";
    const conv = typeof optionsOrConverter.format === "function" ? optionsOrConverter : cached("number", optionsOrConverter);
    return conv.format(Number(value));
  };

  /** JET datetime converters take ISO strings. Accepts Date or ISO string. */
  const formatDate = (value, optionsOrConverter) => {
    if (!value) return "";
    const conv = optionsOrConverter && typeof optionsOrConverter.format === "function" ? optionsOrConverter : cached("date", optionsOrConverter);
    return conv.format(value instanceof Date ? value.toISOString() : value);
  };

  // ---------------------------------------------------------------------------
  // Messages (oj-c-message-banner / oj-c-message-toast / oj-messages)
  // ---------------------------------------------------------------------------
  /**
   * A message list backed by MutableArrayDataProvider. Bind `messages.dataProvider`
   * to the component's data attribute; call messages.remove(key) from its onOjClose.
   * severity: "error" | "warning" | "confirmation" | "info"
   */
  const createMessages = () => {
    let seq = 0;
    const dataProvider = new MutableArrayDataProvider([], { keyAttributes: "id" });
    const timers = new Map();
    const remove = (id) => {
      clearTimeout(timers.get(id));
      timers.delete(id);
      madp.remove(dataProvider, id, "id");
    };
    const add = (severity, summary, detail = "", { autoTimeout } = {}) => {
      const id = `msg-${++seq}`;
      dataProvider.data = dataProvider.data.concat({ id, severity, summary, detail, timestamp: new Date().toISOString() });
      const timeout = autoTimeout ?? (severity === "confirmation" || severity === "info" ? 5000 : 0);
      if (timeout > 0) timers.set(id, setTimeout(() => remove(id), timeout));
      return id;
    };
    return {
      dataProvider,
      add,
      error: (s, d, o) => add("error", s, d, o),
      warning: (s, d, o) => add("warning", s, d, o),
      info: (s, d, o) => add("info", s, d, o),
      confirmation: (s, d, o) => add("confirmation", s, d, o),
      /** Adds an error message from a fetchJson / callRest error. */
      fromError: (err, summary = "Request failed") => add("error", summary, (err && err.message) || String(err)),
      remove,
      clear: () => { timers.forEach(clearTimeout); timers.clear(); madp.clear(dataProvider); }
    };
  };

  // ---------------------------------------------------------------------------
  // Misc
  // ---------------------------------------------------------------------------
  const debounce = (fn, wait = 300) => {
    let t;
    return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), wait); };
  };

  /** Fusion REST "self" link -> resource id, e.g. for composite keys VBCS hides from you. */
  const getSelfLinkId = (row) => {
    const link = row && Array.isArray(row.links) && row.links.find((l) => l.rel === "self");
    return link ? decodeURIComponent(link.href.split("/").pop()) : null;
  };

  return {
    madp,
    fetchAll,
    toFusionQ,
    toFusionOrderBy,
    toOrdsQ,
    fusionRestDataProvider,
    ordsRestDataProvider,
    fetchJson,
    converters,
    formatNumber,
    formatDate,
    createMessages,
    debounce,
    getSelfLinkId
  };
});
