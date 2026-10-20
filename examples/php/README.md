# PHP examples

## `quickstart.php`

Lists wilayas and communes and quotes a fee with a real carrier account. It only **reads**
data unless you set `DZ_CREATE=1`, which creates a real parcel, tracks it and cancels it.

```bash
cd packages/php && composer install
cd ../..

# ZRExpress (default provider)
ZREXPRESS_API_KEY=... ZREXPRESS_TENANT=... php examples/php/quickstart.php

# Yalidine
DZ_PROVIDER=yalidine YALIDINE_API_ID=... YALIDINE_API_TOKEN=... YALIDINE_FROM_WILAYA_ID=16   php examples/php/quickstart.php

# Maystro
DZ_PROVIDER=maystro MAYSTRO_API_TOKEN=... php examples/php/quickstart.php

# Also create, track and cancel a test parcel (real API call!)
DZ_CREATE=1 DZ_PROVIDER=yalidine ... php examples/php/quickstart.php
```

| Variable | Meaning |
|----------|---------|
| `DZ_PROVIDER` | `zrexpress` (default), `yalidine`, `maystro` or `ecotrack`. |
| `ZREXPRESS_API_KEY`, `ZREXPRESS_TENANT` | ZRExpress credentials. |
| `YALIDINE_API_ID`, `YALIDINE_API_TOKEN` | Yalidine credentials. |
| `YALIDINE_FROM_WILAYA_ID` | Your origin wilaya code (default `16`). |
| `MAYSTRO_API_TOKEN` | Maystro store token. |
| `ECOTRACK_TOKEN` + `ECOTRACK_COURIER` or `ECOTRACK_BASE_URL` | Ecotrack token and tenant (`dhd`, `conexlog`, … or the tenant URL). |
| `DZ_CREATE` | `1` to create / track / cancel a parcel (Maystro: create only, it has no tracking / cancellation API). |

The variable names match [`.env.example`](../../.env.example). The script reads real environment
variables only (it does not load `.env` itself): export them in your shell, or use a tool such
as `dotenv` / `direnv`. On Windows PowerShell, set them with `$env:YALIDINE_API_ID = '...'`.

Never commit real credentials. On errors the script prints `[CODE] message (HTTP status)` and
exits with status 1.

For a complete integration guide see [`docs/guide-php.md`](../../docs/guide-php.md).
