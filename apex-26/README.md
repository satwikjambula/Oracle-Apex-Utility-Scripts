# APEX 26.x Utility Scripts

Updated versions of the utility scripts for **Oracle APEX 26.1 and 26.2** (26.2 GA: October 2026). The scripts in the repository root (2.x) are left unchanged for reference.

| File | Version | What it covers |
|---|---|---|
| `apexUtils.js` | 3.0.0 | Page-level helpers: messages, spinners, formatting, storage, tooltip, clipboard, region refresh, BOOLEAN items |
| `apexUtils.css` | 3.0.0 | Styles for the tooltip and in-region messages (Universal Theme CSS variables) |
| `igUtils.js` | 3.0.0 | Interactive Grid: selection, cell ranges, record ids, refresh, filters, headings |
| `irUtils.js` | 1.0.0 | **New.** Interactive Report row selection (26.1 `interactiveReportRegion` API) |
| `vbcs/` | 1.0.0 | **New.** Visual Builder-style action chain API for APEX + PL/SQL proxy. See [vbcs/README.md](vbcs/README.md) |

## Why a new version

**The 2.x files don't load.** `apexUtils.js` reads `apex` on line 27 and declares `const apex` on line 32. `igUtils.js` runs `const apex = apex || {}`. Both throw a `ReferenceError` (temporal dead zone) before any function is defined. The test suite includes a case that shows this. 3.x fixes it by taking the real `window.apex` as a parameter.

Other fixes:

- `server.plugin` called an undefined function (`ajaxSimulation`). It is replaced by `server.process`, which returns a native Promise.
- `server.chunk` used a `.` regex, which silently dropped newlines. It now delegates to `apex.server.chunk`.
- The tooltip used jQuery UI `.position()`. jQuery UI has been deprecated since APEX 20.1, so the tooltip now positions itself. It also renders **text** by default; HTML is opt-in and goes through DOMPurify when the page loads it.
- `getCurrentPageRecordIdsArray` used `.data('id')`, which turned `"007"` into `7`. It now reads the attribute.
- `refreshChangedRecords` tried to re-fetch inserted and deleted rows. It now re-fetches updated rows only.
- IG helpers assumed the grid view was active and failed with `undefined` errors on missing regions. They now use the current view and throw a readable message.

## What's new for 26.x

| Feature | Helper | Needs |
|---|---|---|
| Coalesced region refresh (one AJAX call for Cards / Chart / IG / Template Component regions) | `utils.refreshRegions(ids)` | 26.2 (falls back to per-region refresh) |
| Native `BOOLEAN` session state for items | `utils.getBooleanItem` / `setBooleanItem` | 26.1 (also handles legacy Y/N) |
| Spinner ARIA options (`ariaProcessingStarted`, `suppressAria`, …) | `utils.showSpinner(el, options)` | 26.1 |
| Named / client-side template partials | `utils.applyNamedTemplate`, `utils.applyTemplate` | 26.1 |
| IG multi-range cell selection | `igUtil.getSelectedRanges` / `setSelectedRanges` | 26.1 (get falls back to the deprecated `getSelectedRange`) |
| IR declarative row selection | `apex.custom.irUtil.*` | 26.1 + Row Selection enabled on the report |
| Version gating | `utils.isAtLeast(26, 1)` | any |

Also consider the declarative options added in 26.1 before writing JavaScript:

- **Show Success Message / Show Error Message / Clear Errors** dynamic actions replace most uses of `alertMessages`.
- **IR Row Selector** replaces hand-built checkbox columns.

## Install

1. Upload the files to **Static Application Files** (or Workspace / Object Storage).
2. Page or app **JavaScript File URLs**:
   ```
   #APP_FILES#apexUtils#MIN#.js
   #APP_FILES#igUtils#MIN#.js
   #APP_FILES#irUtils#MIN#.js
   ```
3. **CSS File URLs**: `#APP_FILES#apexUtils#MIN#.css`

Each file is standalone; load only what you use.

## Usage

```js
const { utils } = apex.custom.util.publicFunctions;   // same entry point as 2.x
const ig = apex.custom.igUtil;
const ir = apex.custom.irUtil;

// Refresh three regions (one request on 26.2 where possible)
utils.refreshRegions(["deptChart", "empGrid", "summaryCards"]).then(() => utils.alertMessages("S", "Refreshed"));

// Call an AJAX Callback process
try {
  const res = await utils.server.process("SAVE_ROWS", { x01: ig.getSelectedRecordIdsString("empGrid") });
  utils.alertMessages("S", res.message);
} catch (e) {
  utils.alertMessages("E", e.message);
}

// IR selection (26.1)
const ids = ir.getSelectedValues("ordersIR");
const stop = ir.onSelectionChange("ordersIR", (values) => $s("P10_SELECTED", values.join(":")));

// BOOLEAN items
if (utils.getBooleanItem("P10_IS_ACTIVE")) { /* ... */ }
```

## Breaking changes vs 2.x

| 2.x | 3.x |
|---|---|
| `server.plugin`, `server.pluginUrl` | Removed (were broken). Use `server.process` or `apex.server.plugin`. |
| `tooltip.show(html, bg, maxWidth)` | `tooltip.show(content, { html, maxWidth })`. Text by default; colours come from CSS. |
| `printDOMMessage.show(id, text, icon, color)` | 4th argument is now a CSS modifier class. Colours come from CSS. |
| `copy2Clipboard` | Returns a Promise of `true`/`false`. Add `copyText(str)` for plain strings. |
| `formatMoney` default separators `.` / `,` | Defaults now come from the APEX session locale. Pass them explicitly to keep the old output. |
| `disableRdsTab` set `readonly` | Sets `aria-disabled="true"` (`readonly` does nothing on tabs). |
| `igUtil.changeColumnName` | Returns `true`/`false`. |

## Caveats

- `igUtil.setIGFilters` relies on **undocumented** IG methods (`addFilter`, `getFilters`, `_getColumnByName`, `_setReportSettings`). They still work, but retest after every APEX upgrade.
- `getAllRecordIdsArray` loads every row into the browser. Avoid it on large grids.
- Clipboard APIs require HTTPS.
- APEX 24.1 support ends December 2026. The 3.x helpers detect features at runtime, so most also work on 24.2, but they are only targeted and tested (against mocks) for 26.x.

## Tests

```
cd apex-26/test
npm install
npm test
```

These are smoke tests against a mocked `apex` namespace in jsdom. They check loading, the pure helpers, and how each helper calls the APEX APIs. They don't replace a check in a real 26.2 app.
