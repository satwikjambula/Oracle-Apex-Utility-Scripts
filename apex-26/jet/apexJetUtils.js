/**
 * @fileoverview Oracle JET helpers for APEX 26.x pages (APEX 26.2 bundles JET 20.1).
 * @version 1.0.0
 * @copyright 2026 Satwik
 * @license MIT
 *
 * 1. apex.custom.jet.chart — composable helpers for the Chart region's
 *    "Initialization JavaScript Function" (Attributes > Advanced). Each helper is
 *    `options => options`; combine them with chart.init(...). Converters are plain
 *    objects with format(), which JET charts accept, so no JET modules need loading.
 *
 *      // Chart region > Attributes > Initialization JavaScript Function:
 *      function (options) {
 *        const c = apex.custom.jet.chart;
 *        return c.init(
 *          c.valueFormat({ style: "currency", currency: "USD", notation: "compact" }),
 *          c.colors(["#2a6ebb", "#e07a10", "#5c9e31"]),
 *          c.referenceLine({ value: 100000, text: "Target" }),
 *          c.legend("bottom"),
 *          c.zoomAndScroll()
 *        )(options);
 *      }
 *
 * 2. apex.custom.jet.load(modules) — requires JET modules on an APEX page (for
 *    using oj-c-* components or JET converters directly).
 */
(function (apex, $) {
  "use strict";

  if (!apex || !$) throw new Error("apexJetUtils.js: APEX core JavaScript must load first.");
  apex.custom = apex.custom || {};
  if (apex.custom.jet) throw new Error("Collision detected for apex.custom.jet");

  const lang = () =>
    (apex.locale && apex.locale.getLanguage && apex.locale.getLanguage()) || navigator.language || "en";

  /** A JET-compatible converter (anything with format()) backed by Intl.NumberFormat. */
  const numberConverter = (intlOptions = {}) => {
    const fmt = new Intl.NumberFormat(lang(), intlOptions);
    return { format: (v) => (v === null || v === undefined || v === "" ? "" : fmt.format(Number(v))) };
  };

  const dateConverter = (intlOptions = { dateStyle: "medium" }) => {
    const fmt = new Intl.DateTimeFormat(lang(), intlOptions);
    return {
      format: (v) => {
        if (!v) return "";
        const d = v instanceof Date ? v : new Date(v);
        return Number.isNaN(d.getTime()) ? String(v) : fmt.format(d);
      }
    };
  };

  const ensure = (obj, ...path) => path.reduce((node, key) => (node[key] = node[key] || {}), obj);

  const chart = {
    /** Combines helpers into one Initialization function. */
    init: (...fns) => (options) => fns.reduce((opts, fn) => fn(opts) || opts, options || {}),

    numberConverter,
    dateConverter,

    /**
     * Formats the value (Y) axis labels and tooltip values.
     * intlOptions: any Intl.NumberFormat options (style, currency, notation: "compact", maximumFractionDigits...).
     * axis: "yAxis" (default) or "y2Axis" for dual-Y charts.
     */
    valueFormat: (intlOptions = {}, axis = "yAxis") => (options) => {
      const conv = numberConverter(intlOptions);
      ensure(options, axis, "tickLabel").converter = conv;
      ensure(options, "valueFormats", axis === "y2Axis" ? "y2" : "value").converter = conv;
      return options;
    },

    /** Formats a date-based X axis and its tooltip. */
    dateAxisFormat: (intlOptions) => (options) => {
      const conv = dateConverter(intlOptions);
      ensure(options, "xAxis", "tickLabel").converter = conv;
      ensure(options, "valueFormats", "group").converter = conv;
      return options;
    },

    /** Series colour palette, applied in series order. */
    colors: (palette) => (options) => {
      ensure(options, "styleDefaults").colors = palette;
      return options;
    },

    /** "top" | "bottom" | "start" | "end" | "auto" | "none" (hides the legend). */
    legend: (position = "auto") => (options) => {
      const legend = ensure(options, "legend");
      if (position === "none") legend.rendered = "off";
      else { legend.rendered = "on"; legend.position = position; }
      return options;
    },

    /** Horizontal reference line (target, threshold) on the value axis. */
    referenceLine: ({ value, text = "", color = "#c74634", axis = "yAxis", lineStyle = "dashed", displayInLegend = "on" }) =>
      (options) => {
        const axisOpts = ensure(options, axis);
        axisOpts.referenceObjects = (axisOpts.referenceObjects || []).concat({
          type: "line", value, text, color, lineStyle, displayInLegend, location: "front"
        });
        return options;
      },

    /** Live zoom and scroll; pass "delayed" for large data sets. */
    zoomAndScroll: (mode = "live") => (options) => {
      options.zoomAndScroll = mode;
      options.dataCursor = options.dataCursor || "auto";
      return options;
    },

    /** Animate on display and data change. */
    animation: (onDisplay = "auto", onDataChange = "auto") => (options) => {
      options.animationOnDisplay = onDisplay;
      options.animationOnDataChange = onDataChange;
      return options;
    },

    /**
     * Custom tooltip. fn(context) returns a plain string (rendered as text) or an Element.
     * context is the JET tooltip context: series, group, value, label, color, data, ...
     */
    tooltip: (fn) => (options) => {
      options.tooltip = {
        renderer: (context) => {
          const out = fn(context);
          if (out instanceof Element) return { insert: out };
          const div = document.createElement("div");
          div.textContent = out === null || out === undefined ? "" : String(out);
          return { insert: div };
        }
      };
      return options;
    },

    /** Escape hatch: deep-merge raw JET chart options. */
    merge: (jetOptions) => (options) => $.extend(true, options, jetOptions)
  };

  /**
   * Loads JET modules with the page's RequireJS. APEX includes RequireJS and the JET
   * path config when the page has a JET-based component (e.g. a chart). On a page
   * without one, add #JET_JS# to the page's JavaScript File URLs (and #JET_CSS_DIRECTORY#
   * CSS for components) — check the substitution strings for your APEX version.
   *   const [NumberConverter] = await apex.custom.jet.load(["ojs/ojconverter-number"]);
   */
  const load = (modules) =>
    new Promise((resolve, reject) => {
      if (typeof window.require !== "function" || !window.require.config) {
        reject(new Error("apexJetUtils.load: RequireJS/JET not on this page (add a JET-based region or #JET_JS#)"));
        return;
      }
      window.require(modules, (...mods) => resolve(mods), reject);
    });

  apex.custom.jet = { chart, load };
})(window.apex, window.apex && window.apex.jQuery);
