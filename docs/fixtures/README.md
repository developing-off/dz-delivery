# Shared test fixtures

JSON fixtures in this folder are used by **both** the TypeScript and PHP test suites. They guarantee that both packages map the same native responses to the same unified output (see [`../CONTRACT.md`](../CONTRACT.md)).

## Layout

```
docs/fixtures/
├── <provider>/                 # e.g. zrexpress, yalidine
│   ├── <method>/               # createParcel, track, getFees, getWilayas, getCommunes, cancelParcel
│   │   ├── <case>.input.json   # unified input passed to the SDK method (if any)
│   │   ├── <case>.request.json # expected native HTTP request(s) (method, path, query, body)
│   │   ├── <case>.native.json  # native HTTP response(s) returned by the mock
│   │   └── <case>.expected.json# expected unified output, or expected ShippingError
│   └── statuses.json           # native status → unified status table
└── README.md
```

`<case>` is a short kebab-case name, e.g. `home-delivery`, `stop-desk`, `not-found`, `validation-error`.

## File formats

**`*.native.json`** — one or more mocked HTTP responses, in call order:

```json
[
  { "status": 201, "headers": {}, "body": { "id": "8c1a4c53-..." } },
  { "status": 200, "headers": {}, "body": { "id": "8c1a4c53-...", "trackingNumber": "DZ-AL-..." } }
]
```

**`*.request.json`** — expected requests, same order (headers are checked only if listed):

```json
[
  { "method": "POST", "path": "/api/v1/parcels", "body": { "...": "..." } }
]
```

**`*.expected.json`** — either a unified result:

```json
{ "result": { "id": "8c1a4c53-...", "trackingNumber": "DZ-AL-...", "status": "pending", "provider": "zrexpress" } }
```

or an error:

```json
{ "error": { "code": "VALIDATION_ERROR", "httpStatus": 400 } }
```

`raw` is **not** compared in `expected.json` (it is provider-defined); tests only assert that it is present when `includeRaw` is on.

**`statuses.json`** — flat map used to test status mapping in both languages:

```json
{ "commande_recue": "pending", "OutForDelivery": "in_transit", "SomethingNew": "unknown" }
```

### Matching conventions

- **`*.input.json`** holds the method arguments by name: the `ParcelInput` / `FeeQuery` object for `createParcel` / `getFees`, `{ "trackingNumber": "…" }` for `track`, `{ "wilayaId": … }` for `getCommunes`, `{ "trackingNumberOrId": "…" }` for `cancelParcel`; omitted for `getWilayas`.
- Request `body` and `query` are compared as **subsets**: only listed fields are checked; extra fields sent by the SDK are ignored. Query values are compared as strings.
- The string `"<uuid>"` in a request body matches any UUID (e.g. ZRExpress `customer.customerId`, which is random).
- `"result": null` means the method resolves with no value (`cancelParcel`).
- `error` entries are compared field by field (`code`, `httpStatus`, `message`, `details`); unlisted fields are not checked.
- **`<provider>/config.json`** holds the fake client credentials/options used by the generic TS runner (`packages/ts/test/fixtures.test.ts`), which replays **every** case in this folder.

## Rules

- **Anonymize everything**: no real names, phones, addresses, API keys or tenant IDs. Use fake UUIDs.
- Fixtures come from real responses whenever possible (sandbox), then scrubbed.
- No test may hit the real network; fixtures are served by an HTTP mock.
- Changing a fixture changes the contract for both languages — both test suites must pass in the same PR.
