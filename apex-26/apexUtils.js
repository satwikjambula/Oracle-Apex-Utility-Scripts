/**
 * @fileoverview General page-level utilities for Oracle APEX 26.1 / 26.2.
 * @version 3.0.0
 * @copyright 2024-2026 Satwik
 * @license MIT
 *
 * Load order: after the APEX core JS (any normal page). Pair with apexUtils.css.
 *
 * Changes from 2.x (root folder):
 *  - Fixes a load-time crash: 2.x declared `const apex` after reading `apex`,
 *    which throws a ReferenceError before anything runs.
 *  - Delegates to native APEX APIs where they exist (escapeHTML, showSpinner
 *    with 26.1 ARIA options, debounce, server.chunk, locale) instead of re-implementing them.
 *  - No jQuery UI dependency (deprecated since APEX 20.1). Tooltip positions itself.
 *  - No inline style blobs: visuals live in apexUtils.css, so it works with the
 *    strict Content Security Policy APEX 26.1 now supports.
 *  - Removed server.plugin (it called an undefined `ajaxSimulation`). Use server.process.
 *  - New: version helpers, refreshRegions (26.2 coalesced refresh), BOOLEAN item
 *    helpers (26.1 native booleans), applyNamedTemplate wrapper, Intl formatting.
 *
 * The 2.x surface is kept: apex.custom.util.publicFunctions.{debug, utils}.
 */
(function (apex, $) {
  "use strict";

  if (!apex || !$) {
    throw new Error("apexUtils.js: APEX core JavaScript (apex, apex.jQuery) must load first.");
  }
  apex.custom = apex.custom || {};
  if (apex.custom.util) {
    throw new Error("Collision detected for apex.custom.util");
  }

  const MODULE = "apexUtils.js";
  const logError = (msg, err) => apex.debug.error({ module: MODULE, msg, err });

  // ---------------------------------------------------------------------------
  // Version detection
  // ---------------------------------------------------------------------------
  const detectVersion = () => {
    const raw = (apex.env && apex.env.APEX_VERSION) || window.gApexVersion || "";
    if (!raw) {
      apex.debug.warn(`${MODULE}: could not detect APEX version (apex.env.APEX_VERSION / gApexVersion missing).`);
      return { string: "", array: [], major: NaN, minor: NaN, patchSet: NaN };
    }
    const array = String(raw).split(".");
    const n = (i) => parseInt(array[i], 10);
    return { string: String(raw), array, major: n(0), minor: n(1), patchSet: n(2), other1: n(3), other2: n(4) };
  };

  const apexVersion = detectVersion();

  /** True when the running APEX is >= major.minor (e.g. isAtLeast(26, 1)). */
  const isAtLeast = (major, minor = 0) =>
    apexVersion.major > major || (apexVersion.major === major && apexVersion.minor >= minor);

  // ---------------------------------------------------------------------------
  // Debug (kept from 2.x; logLevel mirrors apex.debug levels)
  // ---------------------------------------------------------------------------
  const debug = {
    logLevel: 0,
    info: (...args) => { if (debug.logLevel > 3) console.info(...args); },
    debug: (...args) => { if (debug.logLevel > 4) console.debug(...args); },
    error: (...args) => console.error(...args),
    warn: (...args) => console.warn(...args)
  };

  const isDefinedAndNotNull = (v) => v !== undefined && v !== null && v !== "";

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  const utils = {
    apexVersion,
    isAtLeast,
    isDefinedAndNotNull,

    // ---- Spinners ----------------------------------------------------------
    /**
     * Shows the native APEX spinner inside obj. Returns the spinner jQuery object.
     * 26.1+ ARIA options (ariaProcessingStarted, ariaStillProcessing, ariaProcessed,
     * suppressAria) are passed straight through; older versions ignore them.
     */
    showSpinner: (obj, options = {}) => apex.util.showSpinner($(obj), options),

    /** Removes any spinner (native or 2.x .ct-loader) inside obj. */
    removeSpinner: (obj) => $(obj).children(".u-Processing, .ct-loader").remove(),

    loader: {
      start: (selector, setMinHeight) => {
        const $el = $(selector);
        if (setMinHeight) $el.addClass("cu-min-h-100");
        return apex.util.showSpinner($el);
      },
      stop: (selector, removeMinHeight) => {
        const $el = $(selector);
        if (removeMinHeight) $el.removeClass("cu-min-h-100");
        $el.children(".u-Processing, .ct-loader").remove();
      }
    },

    // ---- Strings / HTML ----------------------------------------------------
    escapeHTML: (str) => (str === null || str === undefined ? str : apex.util.escapeHTML(String(str))),

    unEscapeHTML: (str) => {
      if (str === null || str === undefined) return str;
      const map = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#x27;": "'", "&#39;": "'", "&#x2F;": "/" };
      return String(str).replace(/&(?:amp|lt|gt|quot|#x27|#39|#x2F);/g, (e) => map[e]);
    },

    /** Text content of an HTML string. Uses DOMParser so scripts/images in the input never execute or load. */
    removeHTML: (html) => {
      if (!isDefinedAndNotNull(html)) return "";
      return new DOMParser().parseFromString(String(html), "text/html").body.textContent || "";
    },

    cutString: (text, maxLength) => {
      if (!text || maxLength < 0) return text;
      if (text.length <= maxLength) return text;
      return maxLength <= 3 ? text.slice(0, maxLength) : `${text.slice(0, maxLength - 3)}...`;
    },

    replaceUndefinedOrNull: (v, replacement) => (v === undefined || v === null ? replacement : v),

    numPad: (num, width = 2) => String(num).padStart(width, "0"),

    getStrByteLength: (str) => (str ? new TextEncoder().encode(str).length : 0),

    isStringJSON: (str) => {
      try { JSON.parse(str); return true; } catch { return false; }
    },

    // ---- Templates (26.1+) ------------------------------------------------
    /**
     * Wrapper for apex.util.applyTemplate. Supports the 26.1 {with/}/{apply/} directives
     * and client-side template-component partials, e.g. "{with/}TYPE:=INITIALS\nINITIALS:=MH\n{apply THEME$AVATAR/}".
     */
    applyTemplate: (template, options) => apex.util.applyTemplate(template, options),

    /** apex.util.applyNamedTemplate (26.1+). Throws on older versions so the failure is obvious. */
    applyNamedTemplate: (name, options) => {
      if (typeof apex.util.applyNamedTemplate !== "function") {
        throw new Error("apex.util.applyNamedTemplate requires APEX 26.1 or later");
      }
      return apex.util.applyNamedTemplate(name, options);
    },

    // ---- Messages ----------------------------------------------------------
    /**
     * status 'E' shows a page error, 'S' a page success message.
     * In 26.1+ prefer the declarative "Show Success Message" / "Show Error Message" /
     * "Clear Errors" dynamic actions when no custom logic is needed.
     */
    alertMessages: (status, message) => {
      if (!status) return;
      try {
        apex.message.clearErrors();
        if (status === "E") {
          apex.message.showErrors([{ type: "error", location: "page", message, unsafe: false }]);
        } else if (status === "S") {
          apex.message.showPageSuccess(message);
        }
      } catch (err) {
        logError("Error in alertMessages", err);
      }
    },

    /** Promise wrapper around apex.message.confirm. */
    confirm: (message) => new Promise((resolve) => apex.message.confirm(message, (ok) => resolve(!!ok))),

    // ---- Types / objects ---------------------------------------------------
    varType: (obj) => {
      if (obj === null) return "null";
      if (Array.isArray(obj)) return "array";
      return typeof obj === "object" ? "json" : typeof obj;
    },

    groupObjectArray: (arr, key) => {
      if (!Array.isArray(arr)) return {};
      return arr.reduce((acc, item) => {
        const k = item && item[key];
        if (isDefinedAndNotNull(k)) {
          const sortKey = `​${k}`; // keeps insertion order for numeric-looking keys
          (acc[sortKey] = acc[sortKey] || []).push(item);
        }
        return acc;
      }, {});
    },

    convertJSON2LowerCase: (obj) => {
      if (Array.isArray(obj)) return obj.map(utils.convertJSON2LowerCase);
      if (!obj || typeof obj !== "object") return obj;
      return Object.fromEntries(
        Object.entries(obj).map(([k, v]) => [k.toLowerCase(), utils.convertJSON2LowerCase(v)])
      );
    },

    /** Shallow copy without undefined values (as in 2.x). Use structuredClone for a deep copy. */
    copyJSONObject: (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== undefined)),

    jsonSafeExtend: (src, target) => {
      try {
        const parsed = typeof target === "string" ? JSON.parse(target) : target;
        return $.extend(true, {}, src, parsed);
      } catch (err) {
        logError("jsonSafeExtend: invalid target, returning copy of source", err);
        return $.extend(true, {}, src);
      }
    },

    removeElementFromArray: (arr, value) => (Array.isArray(arr) ? arr.filter((x) => x !== value) : arr),

    // ---- Timing ------------------------------------------------------------
    debounce: (fn, timeout = 50) => apex.util.debounce(fn, timeout),

    // ---- Numbers / dates ---------------------------------------------------
    isBetween: (value, target, range = 0) => value >= target - range && value <= target + range,

    getRandomNumberInRange: (min, max) => Math.floor(Math.random() * (max - min + 1) + min),

    getDecimalSeparator: () => apex.locale.getDecimalSeparator(),
    getGroupSeparator: () => apex.locale.getGroupSeparator(),

    /** 2.x signature kept. Defaults now come from the APEX session locale, not hard-coded "." / ",". */
    formatMoney: (n, decimals = 2, decSep, groupSep) => {
      const d = decSep ?? apex.locale.getDecimalSeparator();
      const t = groupSep ?? apex.locale.getGroupSeparator();
      const num = Number(n) || 0;
      const [intPart, decPart] = Math.abs(num).toFixed(decimals).split(".");
      const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, t);
      return `${num < 0 ? "-" : ""}${grouped}${decimals ? d + decPart : ""}`;
    },

    /** Locale-aware currency via Intl, using the APEX session language. */
    formatCurrency: (n, currency = "USD", options = {}) =>
      new Intl.NumberFormat(utils.locale.getLanguage(), { style: "currency", currency, ...options }).format(Number(n) || 0),

    /** Parses ISO-8601. A string without an offset is treated as UTC (2.x behaviour). */
    parseISOTimeString: (str) => {
      if (!isDefinedAndNotNull(str)) return null;
      const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(str);
      const d = new Date(hasZone || !/T|\s\d/.test(str) ? str : `${String(str).replace(" ", "T")}Z`);
      return Number.isNaN(d.getTime()) ? null : d;
    },

    getNowUTC: () => new Date().toISOString(),

    // ---- Items (26.1 BOOLEAN session state) --------------------------------
    /**
     * Reads an item as a real boolean. 26.1 BOOLEAN items already return true/false;
     * older Y/N, 1/0, true/false string items are normalised the same way.
     */
    getBooleanItem: (itemName) => {
      const v = apex.item(itemName).getValue();
      if (typeof v === "boolean") return v;
      return ["Y", "YES", "TRUE", "1", "T"].includes(String(v).trim().toUpperCase());
    },

    /** Sets a boolean, writing a native boolean for 26.1 BOOLEAN items and "Y"/"N" otherwise. */
    setBooleanItem: (itemName, value, { yes = "Y", no = "N", native } = {}) => {
      const item = apex.item(itemName);
      const useNative = native ?? typeof item.getValue() === "boolean";
      item.setValue(useNative ? !!value : value ? yes : no);
    },

    // ---- Regions -----------------------------------------------------------
    /**
     * Refreshes several regions. On 26.2+ uses apex.region.multipleRefresh, which sends one
     * AJAX request for Cards, Chart, Interactive Grid and Template Component regions.
     * Missing regions (e.g. hidden by a server-side condition) are skipped instead of throwing.
     */
    refreshRegions: (regionIds, options) => {
      const ids = (regionIds || []).filter((id) => apex.region.isRegion(id));
      if (typeof apex.region.multipleRefresh === "function") {
        return apex.region.multipleRefresh(ids, options);
      }
      return Promise.all(ids.map((id) => apex.region(id).refresh()));
    },

    disableRdsTab: (selector) => $(selector).attr("aria-disabled", "true").addClass("apex_disabled"),
    enableRdsTab: (selector) => $(selector).removeAttr("aria-disabled").removeClass("apex_disabled"),

    // ---- Navigation --------------------------------------------------------
    /** Opens a URL in a target window (2.x behaviour). Use apex.navigation.redirect for same-window APEX URLs. */
    link: (url, target = "_parent") => {
      if (isDefinedAndNotNull(url)) window.open(url, target, "noopener");
    },

    // ---- Server ------------------------------------------------------------
    server: {
      /** Splits a long string for f01-style submission. Delegates to apex.server.chunk. */
      chunk: (str) => (isDefinedAndNotNull(str) ? apex.server.chunk(str) : []),

      /**
       * apex.server.process as a native Promise. Rejects with an Error on transport
       * failure and when the JSON response carries { error: "..." } or { status: "E" }.
       */
      process: (name, data = {}, options = {}) =>
        new Promise((resolve, reject) => {
          apex.server.process(name, data, options)
            .done((res) => {
              const msg = res && (res.error || (res.status === "E" && (res.message || "Process failed")));
              msg ? reject(new Error(msg)) : resolve(res);
            })
            .fail((jqXHR, textStatus, errorThrown) =>
              reject(new Error(errorThrown || textStatus || "AJAX request failed")));
        })
    },

    splitString2Array: (str) => utils.server.chunk(str),

    // ---- DOM messages ------------------------------------------------------
    printDOMMessage: {
      show: (selector, text, icon = "fa-info-circle-o", modifier = "") => {
        const $c = $(selector);
        const large = $c.height() >= 150;
        const $msg = $("<div>", { class: `cu-dom-msg dominfomessagediv ${large ? "cu-dom-msg--lg" : ""} ${modifier}`.trim() });
        $("<span>", { class: `fa ${icon} cu-dom-msg__icon`, "aria-hidden": "true" }).appendTo($msg);
        $("<span>", { class: "cu-dom-msg__text", text }).appendTo($msg);
        $c.append($msg);
      },
      hide: (selector) => $(selector).find(".dominfomessagediv").remove()
    },

    noDataMessage: {
      show: (selector, text) => utils.printDOMMessage.show(selector, text, "fa-search"),
      hide: (selector) => utils.printDOMMessage.hide(selector)
    },

    errorMessage: {
      show: (selector, text) => utils.printDOMMessage.show(selector, text, "fa-exclamation-triangle", "cu-dom-msg--warn"),
      hide: (selector) => utils.printDOMMessage.hide(selector)
    },

    // ---- Tooltip (no jQuery UI) --------------------------------------------
    tooltip: {
      /**
       * content: plain text by default. Pass { html: true } only for trusted markup;
       * it is run through DOMPurify when the page has it loaded.
       */
      show: (content, { html = false, maxWidth } = {}) => {
        let $tip = $("#dynToolTip");
        if (!$tip.length) {
          $tip = $("<div>", { id: "dynToolTip", class: "cu-tooltip", role: "tooltip" }).appendTo("body");
        }
        if (maxWidth) $tip.css("max-width", maxWidth);
        if (html) {
          const safe = window.DOMPurify ? window.DOMPurify.sanitize(content) : content;
          $tip.html(safe);
        } else {
          $tip.text(content);
        }
        $tip.removeClass("cu-tooltip--hidden");
      },

      /** Positions near the pointer and flips to stay inside the viewport. */
      setPosition: (event) => {
        const tip = document.getElementById("dynToolTip");
        if (!tip || !event) return;
        const e = event.originalEvent || event;
        const gap = 8;
        const { offsetWidth: w, offsetHeight: h } = tip;
        let x = e.clientX + gap;
        let y = e.clientY + gap;
        if (x + w > window.innerWidth) x = Math.max(0, e.clientX - w - gap);
        if (y + h > window.innerHeight) y = Math.max(0, e.clientY - h - gap);
        tip.style.left = `${x}px`;
        tip.style.top = `${y}px`;
      },

      hide: () => $("#dynToolTip").addClass("cu-tooltip--hidden"),
      remove: () => $("#dynToolTip").remove()
    },

    // ---- Clipboard / device -------------------------------------------------
    /** Copies a string to the clipboard. Needs HTTPS. Resolves true on success. */
    copyText: async (text) => {
      try {
        await navigator.clipboard.writeText(String(text ?? ""));
        return true;
      } catch (err) {
        logError("Clipboard write failed (requires HTTPS and user permission)", err);
        return false;
      }
    },

    /** Copies an element's value (inputs) or text (anything else). Same signature as 2.x. */
    copy2Clipboard: (element) => {
      const $el = $(element);
      return utils.copyText($el.is("input, textarea, select") ? $el.val() : $el.text());
    },

    isTouchDevice: () => "ontouchstart" in window || navigator.maxTouchPoints > 0,

    // ---- Storage -----------------------------------------------------------
    /** Kept name from 2.x; type "permanent" = localStorage, anything else = sessionStorage. */
    localStorage: {
      check: () => {
        try {
          const k = "__cu_test__";
          window.sessionStorage.setItem(k, k);
          window.sessionStorage.removeItem(k);
          return true;
        } catch {
          return false;
        }
      },
      _store: (type) => (type === "permanent" ? window.localStorage : window.sessionStorage),
      set: (key, value, type = "session") => {
        try { utils.localStorage._store(type).setItem(key, value); return true; } catch (err) { logError("Storage write failed (quota?)", err); return false; }
      },
      get: (key, type = "session") => {
        try { return utils.localStorage._store(type).getItem(key); } catch { return null; }
      },
      remove: (key, type = "session") => {
        try { utils.localStorage._store(type).removeItem(key); } catch { /* storage unavailable */ }
      }
    },

    locale: {
      /** APEX session language first, then the browser's. */
      getLanguage: () =>
        (apex.locale && typeof apex.locale.getLanguage === "function" && apex.locale.getLanguage()) ||
        navigator.language || "en"
    }
  };

  apex.custom.util = {
    apexVersion,
    publicFunctions: { debug, utils }
  };
})(window.apex, window.apex && window.apex.jQuery);
