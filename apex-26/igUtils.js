/**
 * @fileoverview Interactive Grid utilities for Oracle APEX 26.1 / 26.2.
 * @version 3.0.0
 * @copyright 2025-2026 Satwik
 * @license MIT
 *
 * Changes from 2.x (root folder):
 *  - Fixes a load-time crash: `const apex = apex || {}` throws a ReferenceError.
 *  - Works against the *current* view's model and documented
 *    interactiveGrid#getSelectedRecords, instead of assuming the grid view is active.
 *  - Clear errors when the region is missing or is not an Interactive Grid.
 *  - New: setSelectedRecordIds, getSelectedColumnValues, getSelectedRanges /
 *    setSelectedRanges (26.1 multi-range cell selection), onSelectionChange.
 *
 * Every 2.x function name and signature is kept.
 */
(function (apex, $) {
  "use strict";

  if (!apex || !$) {
    throw new Error("igUtils.js: APEX core JavaScript (apex, apex.jQuery) must load first.");
  }
  apex.custom = apex.custom || {};
  if (apex.custom.igUtil) {
    throw new Error("Collision detected for apex.custom.igUtil");
  }

  const igUtil = {};

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------
  /** Returns the region interface, or throws a readable error. */
  const getIG = (igId) => {
    if (!apex.region.isRegion(igId)) {
      throw new Error(`igUtils: region "${igId}" not found (check its HTML DOM id / server-side condition)`);
    }
    const region = apex.region(igId);
    const widget$ = region.widget && region.widget();
    if (!widget$ || !widget$.length || typeof widget$.interactiveGrid !== "function") {
      throw new Error(`igUtils: region "${igId}" is not an Interactive Grid`);
    }
    return region;
  };

  const currentModel = (region) => region.call("getCurrentView").model;

  /** Grid view widget (needed for cell-range APIs). */
  const gridView$ = (region) => {
    const view = region.call("getViews", "grid");
    if (!view || !view.view$) throw new Error("igUtils: the grid view is not available for this region");
    return view.view$;
  };

  /** Composite keys come back as arrays; join them like 2.x did. */
  const joinIds = (ids, recordSeparator, componentSeparator) =>
    ids.map((id) => (Array.isArray(id) ? id.join(componentSeparator) : id)).join(recordSeparator);

  /** LOV-backed columns store { v, d } objects; return the return value. */
  const plainValue = (v) => (v && typeof v === "object" && "v" in v ? v.v : v);

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------
  /** @returns {string[]} record ids of the selected rows in the current view */
  igUtil.getSelectedRecordIdsArray = (igId) => {
    const region = getIG(igId);
    const model = currentModel(region);
    return (region.call("getSelectedRecords") || []).map((rec) => model.getRecordId(rec));
  };

  igUtil.getSelectedRecordIdsString = (igId, recordSeparator = ":", componentSeparator = ";") =>
    joinIds(igUtil.getSelectedRecordIdsArray(igId), recordSeparator, componentSeparator);

  /** @returns {boolean} */
  igUtil.checkRowsAreSelected = (igId) => (getIG(igId).call("getSelectedRecords") || []).length > 0;

  /**
   * Selects rows by record id. Ids must be in the model (loaded).
   * @param {string[]} ids  empty array clears the selection
   */
  igUtil.setSelectedRecordIds = (igId, ids, focus = false, noNotify = false) =>
    getIG(igId).call("setSelectedRecords", ids || [], focus, noNotify);

  /**
   * Values of one column for every selected row.
   * @param {string} column column name (as defined in the IG)
   */
  igUtil.getSelectedColumnValues = (igId, column) => {
    const region = getIG(igId);
    const model = currentModel(region);
    return (region.call("getSelectedRecords") || []).map((rec) => plainValue(model.getValue(rec, column)));
  };

  /** Runs callback(selectedRecords, data) whenever the IG selection changes. Returns an unbind function. */
  igUtil.onSelectionChange = (igId, callback) => {
    const region = getIG(igId);
    const handler = (event, data) => callback((data && data.selectedRecords) || [], data);
    const widget$ = region.widget();
    widget$.on("interactivegridselectionchange", handler);
    return () => widget$.off("interactivegridselectionchange", handler);
  };

  // ---------------------------------------------------------------------------
  // Cell ranges (APEX 26.1+: grid#getSelectedRanges / setSelectedRanges)
  // ---------------------------------------------------------------------------
  /**
   * Returns the selected cell ranges. Falls back to the deprecated getSelectedRange
   * (wrapped in an array) on releases before 26.1.
   */
  igUtil.getSelectedRanges = (igId) => {
    const view$ = gridView$(getIG(igId));
    const grid = view$.grid("instance");
    if (grid && typeof grid.getSelectedRanges === "function") return view$.grid("getSelectedRanges");
    const single = view$.grid("getSelectedRange");
    return single ? [single] : [];
  };

  /** 26.1+ only. ranges: array of grid Range objects (see JS API reference, grid widget). */
  igUtil.setSelectedRanges = (igId, ranges, ...rest) => {
    const view$ = gridView$(getIG(igId));
    const grid = view$.grid("instance");
    if (!grid || typeof grid.setSelectedRanges !== "function") {
      throw new Error("igUtils.setSelectedRanges requires APEX 26.1 or later");
    }
    return view$.grid("setSelectedRanges", ranges, ...rest);
  };

  // ---------------------------------------------------------------------------
  // Page / all records
  // ---------------------------------------------------------------------------
  /** Record ids of rows currently rendered in the grid view (current page / visible window). */
  igUtil.getCurrentPageRecordIdsArray = (igId) => {
    const region = getIG(igId);
    return region.widget()
      .find(".a-GV-w-scroll tr.a-GV-row[data-id]")
      .map((_, row) => row.getAttribute("data-id")) // attr, not .data(): avoids "007" -> 7 coercion
      .get();
  };

  igUtil.getCurrentPageRecordIdsString = (igId, recordSeparator = ":", componentSeparator = ";") =>
    joinIds(igUtil.getCurrentPageRecordIdsArray(igId), recordSeparator, componentSeparator);

  /**
   * Fetches every record from the server into the model, then returns all record ids.
   * Large data sets are loaded fully into the browser — use with care.
   * @returns {Promise<string[]>}
   */
  igUtil.getAllRecordIdsArray = (igId) => {
    const model = currentModel(getIG(igId));
    return new Promise((resolve) => {
      model.fetchAll((status) => {
        if (!status.done) return;
        const ids = [];
        model.forEach((rec) => ids.push(model.getRecordId(rec)));
        resolve(ids);
      });
    });
  };

  igUtil.getAllRecordIdsString = (igId, recordSeparator = ":", componentSeparator = ";") =>
    igUtil.getAllRecordIdsArray(igId).then((ids) => joinIds(ids, recordSeparator, componentSeparator));

  // ---------------------------------------------------------------------------
  // Refresh
  // ---------------------------------------------------------------------------
  /** Re-fetches only rows with pending changes (updated rows; inserted/deleted rows are skipped). */
  igUtil.refreshChangedRecords = (igId) => {
    const model = currentModel(getIG(igId));
    const records = (model.getChanges() || [])
      .filter((meta) => meta.updated && !meta.inserted && !meta.deleted)
      .map((meta) => meta.record);
    if (records.length) model.fetchRecords(records);
  };

  igUtil.refreshSelectedRecords = (igId) => {
    const region = getIG(igId);
    const records = region.call("getSelectedRecords") || [];
    if (records.length) currentModel(region).fetchRecords(records);
  };

  // ---------------------------------------------------------------------------
  // Filters
  // ---------------------------------------------------------------------------
  /**
   * Sets "equals" column filters. An empty value removes that column's filter.
   *
   * WARNING: addFilter/updateFilter/deleteFilter/getFilters and the _getColumnByName /
   * _setReportSettings calls are NOT part of the documented JS API (as of 26.2).
   * They work today but can break on any upgrade — retest after each APEX patch.
   * For new work prefer a page item in the IG's SQL WHERE clause + "Page Items to Submit".
   */
  igUtil.setIGFilters = (regionId, columns, values) => {
    const region = getIG(regionId);
    const inst = region.call("instance");
    const filters = region.call("getFilters") || [];
    const options = { save: false };
    let changed = false;

    const idToName = {};
    columns.forEach((name) => {
      const col = inst._getColumnByName(name);
      if (col) idToName[col.id] = name;
    });

    const existing = {};
    filters.forEach((f) => {
      if (f.type === "column" && f.operator === "EQ" && idToName[f.columnId]) {
        existing[idToName[f.columnId]] = { id: f.id, val: f.value };
      }
    });

    columns.forEach((name, i) => {
      const val = values[i];
      const cur = existing[name];
      if (val !== "" && val !== null && val !== undefined) {
        const filter = { type: "column", columnType: "column", operator: "EQ", value: val, isCaseSensitive: false };
        if (cur) {
          if (val !== cur.val) { region.call("updateFilter", cur.id, filter, options); changed = true; }
        } else {
          region.call("addFilter", { ...filter, columnName: name }, options);
          changed = true;
        }
      } else if (cur) {
        region.call("deleteFilter", cur.id, options);
        changed = true;
      }
    });

    if (changed) inst._setReportSettings({});
  };

  // ---------------------------------------------------------------------------
  // Columns
  // ---------------------------------------------------------------------------
  /** Changes a column heading at runtime (grid view). Returns true if the column was found. */
  igUtil.changeColumnName = (igId, columnName, newHeading) => {
    const view$ = gridView$(getIG(igId));
    const column = view$.grid("getColumns").find((c) => c.property === columnName);
    if (!column) return false;
    column.heading = newHeading;
    view$.grid("refreshColumns").grid("refresh");
    return true;
  };

  apex.custom.igUtil = igUtil;
})(window.apex, window.apex && window.apex.jQuery);
