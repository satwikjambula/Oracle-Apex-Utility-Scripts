# JET helpers for APEX 26.x

APEX charts are Oracle JET charts (APEX 26.2 bundles JET 20.1.4). `apexJetUtils.js` gives you small, composable helpers for the Chart region's **Initialization JavaScript Function**, plus a loader for JET modules.

For standalone JET or Visual Builder apps, see [`/jet`](../../jet/README.md).

## Install

Static Application Files → `#APP_FILES#jet/apexJetUtils#MIN#.js` in the page's JavaScript File URLs.

## Chart Initialization function

Chart region → Attributes → Advanced → Initialization JavaScript Function:

```js
function (options) {
  const c = apex.custom.jet.chart;
  return c.init(
    c.valueFormat({ style: "currency", currency: "USD", notation: "compact" }), // $1.2M on axis + tooltip
    c.colors(["#2a6ebb", "#e07a10", "#5c9e31"]),
    c.referenceLine({ value: 1000000, text: "Budget" }),
    c.legend("bottom"),
    c.zoomAndScroll(),
    c.tooltip((ctx) => `${ctx.series}: ${ctx.value}`)   // text-only; return an Element for markup
  )(options);
}
```

| Helper | Sets |
|---|---|
| `valueFormat(intlOptions, axis)` | `yAxis/y2Axis.tickLabel.converter`, `valueFormats.value/y2.converter` |
| `dateAxisFormat(intlOptions)` | `xAxis.tickLabel.converter`, `valueFormats.group.converter` |
| `colors(palette)` | `styleDefaults.colors` |
| `legend(position \| "none")` | `legend.rendered`, `legend.position` |
| `referenceLine({ value, text, color, axis })` | appends to `<axis>.referenceObjects` |
| `zoomAndScroll(mode)` | `zoomAndScroll`, `dataCursor` |
| `animation(onDisplay, onDataChange)` | `animationOnDisplay`, `animationOnDataChange` |
| `tooltip(fn)` | `tooltip.renderer` (text by default, so values can't inject HTML) |
| `merge(rawJetOptions)` | deep merge, for anything not covered |

Converters are plain `{ format }` objects backed by `Intl`, using the APEX session language. JET charts accept any object with `format()`, so no JET module has to load before the chart renders.

**Prefer declarative settings first.** Format masks, legend position, colours by series, and zoom are all chart attributes in Page Designer. Use these helpers for what Page Designer can't do (compact or currency formats on a dual Y axis, reference lines driven by JS, safe custom tooltips), or for one shared look across many charts.

## Loading JET modules

```js
const [NumberConverter] = await apex.custom.jet.load(["ojs/ojconverter-number"]);
```

This works on pages where APEX has already loaded RequireJS with the JET configuration (any page with a chart or another JET-based component). On other pages, add APEX's JET substitution strings (`#JET_JS#`, and `#JET_CSS_DIRECTORY#` for component CSS) to the page files. These names haven't been verified against the 26.x docs, so confirm them in your version's substitution-string list.

## Not covered

- Runtime changes to a rendered chart's options. 26.2 introduced a documented `chartRegion` JS interface; use it once you've confirmed its methods in the 26.2 JS API reference, rather than poking at the JET element directly.
- Embedding `oj-c-*` Core Pack components in APEX pages. It's possible but needs custom bootstrapping and is fragile across APEX upgrades.
