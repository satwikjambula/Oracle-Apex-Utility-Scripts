/**
 * @fileoverview Interactive Report utilities for Oracle APEX 26.1+.
 * @version 1.0.0
 * @copyright 2026 Satwik
 * @license MIT
 *
 * APEX 26.1 added declarative row selection for Interactive Reports and the
 * interactiveReportRegion JS interface. These helpers wrap that interface with the
 * same string/array conventions as igUtils.js, so IG and IR code read the same.
 *
 * Requirements: APEX 26.1+, and Row Selection enabled on the report
 * (Page Designer > report > Row Selector). Without it the native methods return
 * null / -1 and these helpers throw a readable error instead.
 */
(function (apex, $) {
  "use strict";

  if (!apex || !$) {
    throw new Error("irUtils.js: APEX core JavaScript (apex, apex.jQuery) must load first.");
  }
  apex.custom = apex.custom || {};
  if (apex.custom.irUtil) {
    throw new Error("Collision detected for apex.custom.irUtil");
  }

  const irUtil = {};

  const getIR = (irId) => {
    if (!apex.region.isRegion(irId)) {
      throw new Error(`irUtils: region "${irId}" not found`);
    }
    const region = apex.region(irId);
    if (typeof region.getSelectedValues !== "function") {
      throw new Error(`irUtils: "${irId}" is not an Interactive Report, or APEX is older than 26.1`);
    }
    return region;
  };

  const requireSelection = (result, irId) => {
    if (result === null || result === -1) {
      throw new Error(`irUtils: row selection is not enabled on "${irId}"`);
    }
    return result;
  };

  /** Primary-key values of every selected row (not limited to rows in the DOM). */
  irUtil.getSelectedValues = (irId) => requireSelection(getIR(irId).getSelectedValues(), irId);

  irUtil.getSelectedValuesString = (irId, separator = ":") => irUtil.getSelectedValues(irId).join(separator);

  irUtil.checkRowsAreSelected = (irId) => irUtil.getSelectedValues(irId).length > 0;

  /**
   * Selects rows by value. Rows must be rendered (current page).
   * @returns {number} rows actually selected
   */
  irUtil.setSelectedValues = (irId, values, focus = false, noNotify = false) =>
    requireSelection(getIR(irId).setSelectedValues((values || []).map(String), focus, noNotify), irId);

  irUtil.selectAll = (irId, focus, noNotify = false) => getIR(irId).selectAll(focus, noNotify);

  /** Clears the selection. */
  irUtil.clearSelection = (irId, noNotify = false) => getIR(irId).setSelection($(), false, noNotify);

  irUtil.getCurrentRowValue = (irId) => getIR(irId).getCurrentRowValue();

  /** REPORT | CHART | DETAIL | GROUP_BY | ICON | PIVOT */
  irUtil.getViewName = (irId) => getIR(irId).getViewName();

  /** Refresh, keeping pagination by default. */
  irUtil.refresh = (irId, keepPagination = true) => getIR(irId).refresh(keepPagination);

  /** callback(selectedValues, event) on every selection change. Returns an unbind function. */
  irUtil.onSelectionChange = (irId, callback) => {
    const region = getIR(irId);
    const handler = (event) => callback(region.getSelectedValues() || [], event);
    region.element.on("apexselectionchange", handler);
    return () => region.element.off("apexselectionchange", handler);
  };

  apex.custom.irUtil = irUtil;
})(window.apex, window.apex && window.apex.jQuery);
