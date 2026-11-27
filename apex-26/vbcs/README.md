# VBCS-style utilities for Oracle APEX 26.x

`vbUtils.js` gives an APEX page the programming model of **Visual Builder JavaScript action chains**: `$page` / `$application` variables, registered chains, event listeners, and an `Actions` object whose methods follow VB's built-in actions. `vb_compat_pkg.sql` is the server side for REST calls and navigation.

Use it to:

- port VBCS action-chain logic to APEX with small edits, by hand or from a converter;
- give developers who know VBCS a familiar API while they learn APEX.

## Use declarative APEX first

This layer is a **landing zone**, not the target architecture. VBCS keeps state in the browser and calls REST from the client. APEX is strongest when state is session state and logic runs on the server. When converting, prefer, in order:

1. Declarative APEX: items, Dynamic Actions (26.1 adds Show Success/Error Message), page processes, validations, REST Data Sources behind regions.
2. `vbUtils.js`, for chains that are really client-side orchestration and don't map cleanly.

A converted app built entirely on this layer will run, but APEX developers will find it hard to maintain.

## Files

| File | Purpose |
|---|---|
| `vbUtils.js` | Client API: `apex.custom.vb` |
| `vb_compat_pkg.sql` | `VB_REST_ENDPOINTS` allowlist table + `VB_COMPAT_PKG` (AJAX callbacks) |

## Setup

1. Run `vb_compat_pkg.sql` in the parsing schema.
2. Create Web Credentials for the services you call, and add ACL / workspace ACL entries for their hosts.
3. Insert one `VB_REST_ENDPOINTS` row per VB service endpoint you use (the key can match the VB endpoint id, e.g. `fusion/getInvoices`).
4. Add two **AJAX Callback** processes (Page 0 or application level):
   - `VB_REST_PROXY` → `vb_compat_pkg.ajax_rest_proxy;`
   - `VB_GET_URL` → `vb_compat_pkg.ajax_get_url;`
5. Load `#APP_FILES#vbcs/vbUtils#MIN#.js` (after `apexUtils.js` if you use both).

## Example: a VBCS chain and its APEX version

VBCS:

```js
class saveInvoiceChain extends ActionChain {
  async run(context, { invoiceId }) {
    const { $page, $variables } = context;
    const res = await Actions.callRest(context, {
      endpoint: 'fusion/updateInvoice',
      uriParams: { InvoiceId: invoiceId },
      body: $variables.invoice,
    });
    if (!res.ok) {
      await Actions.fireNotificationEvent(context, { summary: 'Save failed', type: 'error' });
      return;
    }
    await Actions.fireNotificationEvent(context, { summary: 'Saved', type: 'confirmation', displayMode: 'transient' });
    await Actions.navigateToPage(context, { page: 'invoice-list' });
  }
}
```

APEX with `vbUtils.js`:

```js
const vb = apex.custom.vb;
const { Actions } = vb;

vb.definePageVariables({
  invoiceId: { type: "number", item: "P20_INVOICE_ID" },   // two-way bound to an APEX item
  invoice:   { type: "object", defaultValue: {} }
});

vb.defineChain("saveInvoiceChain", async (context, { invoiceId }) => {
  const { $variables } = context;
  const res = await Actions.callRest(context, {
    endpoint: "fusion/updateInvoice",
    uriParams: { InvoiceId: invoiceId },
    body: $variables.invoice
  });
  if (!res.ok) {
    await Actions.fireNotificationEvent(context, { summary: "Save failed", type: "error" });
    return;
  }
  await Actions.fireNotificationEvent(context, { summary: "Saved", type: "confirmation", displayMode: "transient" });
  await Actions.navigateToPage(context, { page: 10 });            // VB page id -> APEX page number
});

// VB event listener -> DOM / page events
vb.bind("#SAVE", "click", "saveInvoiceChain");                     // params.event / params.value
vb.onPageEnter("loadInvoiceChain");                                 // vbEnter
vb.warnOnDirtyExit();                                               // vbBeforeExit dirty check
```

The chain body is unchanged apart from the page reference.

## Mapping reference

| VBCS | APEX (`apex.custom.vb`) | Notes |
|---|---|---|
| `$page.variables`, `$variables` | `context.$page.variables`, `context.$variables` | Top-level assignment is tracked. Nested mutation (`x.y = 1`) is **not**; use `assignVariable` with a path. |
| `$application.variables` | `context.$application.variables` | `persisted: "session" \| "local"` supported. |
| `$flow` | – | No flows in APEX. Use `$page` or `$application`. |
| Variable bound to a component | `item: "P10_X"` in the definition | Two-way sync with the APEX item, so it is submitted and visible to PL/SQL. |
| `Actions.assignVariable` | same | Path syntax `$page.variables.emp.name`. |
| `Actions.resetVariables` | same | Resets to `defaultValue`. |
| `Actions.callChain` | same | Chains are functions or objects with `run()`. |
| `Actions.callRest` | same | Returns `{ ok, status, headers, body }`. Goes through `VB_REST_PROXY` and the allowlist. |
| `Actions.fireNotificationEvent` | same | error/warning → page error, info/confirmation → page success. |
| `Actions.navigateToPage` | same | `page` = APEX page number. The URL is built server-side so checksums stay valid. |
| `Actions.navigateBack` / `openUrl` | same | |
| `Actions.fireEvent` + event listener | `Actions.fireEvent` + `vb.on(event, chain)` | Also raises an APEX custom event, so Dynamic Actions can listen. |
| `Actions.fireDataProviderEvent` | same, `target` = region DOM id | Refresh, or IG re-fetch of updated keys. |
| `Actions.callComponent` | same | `regionId` + method → `apex.region().call()`, or `item` + method. |
| `Actions.runInParallel` | same | Array of functions → `Promise.all`. |
| `Actions.getDirtyDataStatus` / `resetDirtyDataStatus` | same | Combines tracked variables with `apex.page.isChanged()`. |
| `Actions.getLocation` / `share` | same | Browser APIs. |
| Service Data Provider / Business Objects | – | Use a REST Data Source + IG / Cards / IR region. Don't emulate SDPs in JS. |
| `$translations` | – | APEX Text Messages + `apex.lang.getMessage`. |
| JET components (`oj-*`, `oj-c-*`) | – | Native APEX components first; JET only where APEX has no equivalent. |

Action names and option shapes follow VB's built-in JavaScript actions as documented in the Visual Builder Page Model Reference. Options that have no APEX meaning are ignored.

## Security notes

- **No URLs from the client.** `callRest` sends an endpoint key. The server checks `VB_REST_ENDPOINTS` (enabled flag and an optional APEX authorization scheme), builds the URL, and calls it with a Web Credential. This prevents SSRF and keeps tokens out of the browser.
- **Headers are allowlisted** per endpoint. `Authorization` comes only from the credential.
- **`Set-Cookie` is stripped** from responses passed back to the browser.
- **Item names** in `navigateToPage` params are checked against `^[A-Za-z0-9_$]+$`. Session State Protection still applies, because the URL comes from `apex_page.get_url`.
- Not included: rate limiting, and response-size limits for very large payloads. Add these if the endpoints are expensive.

## Testing status

- `vbUtils.js`: 9 jsdom smoke tests in `../test/vb.test.js` against a mocked `apex`.
- `vb_compat_pkg.sql`: **not yet compiled or run against a database.** Run it in a dev schema first.
