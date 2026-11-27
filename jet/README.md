# JET utilities (standalone JET and Visual Builder apps)

`jetUtils.js` is an AMD module for **Oracle JET 19/20** apps and **Visual Builder (VBCS)** apps.

For JET charts *inside APEX*, see [`apex-26/jet/`](../apex-26/jet/README.md) instead.

| Area | Functions |
|---|---|
| In-memory data | `madp.create / upsert / remove / clear` (MutableArrayDataProvider, no knockout) |
| Any DataProvider | `fetchAll(dp, { size, maxRows })` |
| Fusion Apps REST | `fusionRestDataProvider({ url, keyAttributes, fields, finder, frameworkVersion, caseInsensitive })`, `toFusionQ`, `toFusionOrderBy`, `getSelfLinkId` |
| ORDS REST | `ordsRestDataProvider({ url, keyAttributes })`, `toOrdsQ` |
| HTTP | `fetchJson(url, { method, body, timeout })`: timeout, Fusion error detail in `err.message` |
| Formatting | `converters.number / currency / percent / date / dateTime`, `formatNumber`, `formatDate` (cached) |
| Messages | `createMessages()` → `{ dataProvider, error, warning, info, confirmation, fromError, remove, clear }` |
| Misc | `debounce` |

## Load it

**VBCS:** copy to `resources/js/jetUtils.js` and import it in the page module:

```js
define(['resources/js/jetUtils'], (jetUtils) => {
  class PageModule {
    constructor() { this.jet = jetUtils; }
  }
  return PageModule;
});
```

**JET (RequireJS):** add to `src/js/` and `define(['jetUtils'], ...)`. For VDOM / TypeScript apps, wrap the factory or port it to an ES module.

## Examples

Fusion table with server-side paging, filter and sort:

```js
this.invoicesDP = jetUtils.fusionRestDataProvider({
  url: '/fscmRestApi/resources/11.13.18.05/invoices',   // in VBCS: the service connection proxy URL
  keyAttributes: 'InvoiceId',
  fields: 'InvoiceId,InvoiceNum,InvoiceAmount,InvoiceDate',
  caseInsensitive: true
});
// <oj-c-table data="[[invoicesDP]]"> — sort headers and filter criteria are translated to orderBy / q
```

Messages:

```js
this.messages = jetUtils.createMessages();
// <oj-c-message-banner data="[[messages.dataProvider]]" on-oj-close="[[e => messages.remove(e.detail.key)]]">
try {
  await jetUtils.fetchJson(url, { method: 'PATCH', body: changes });
  this.messages.confirmation('Saved');          // auto-dismisses after 5 s
} catch (e) {
  this.messages.fromError(e, 'Save failed');    // stays until closed
}
```

## Things to know

- **Fusion `q` syntax.** `toFusionQ` produces REST framework version 2+ expression syntax with `%` wildcards. Version 1 uses query-by-example and `*`, so the provider sends `REST-Framework-Version: 2` by default. Set `frameworkVersion` to match what your resources expect. Higher versions change some response shapes.
- **Not every Fusion resource supports every operator or attribute in `q`.** Check the resource's describe output (`/describe`) for queryable attributes.
- **VBCS already has Service Data Providers and business object support.** Use `fusionRestDataProvider` where an SDP doesn't fit, such as a custom page module or a shared component.
- `madp.upsert/remove` create a new array each time, because that is the only way MutableArrayDataProvider sees changes. That's fine for hundreds of rows; for tens of thousands, use a server-backed provider.
- `fetchAll` stops at `maxRows` (default 10,000) to protect the browser.
- The `capabilities` block (sort: multiple, filter operators) is what lets components push sort and filter to the server. Override it if a resource can't sort or filter.

## Tests

Tests live with the APEX suite in `apex-26/test/jet.test.js` and run against stubbed JET classes (no real JET runtime):

```
cd apex-26/test && npm install && npm test
```
