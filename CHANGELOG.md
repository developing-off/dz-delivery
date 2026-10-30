# Changelog

All notable changes to `@dz-delivery/core` (npm) and `dz-delivery/sdk` (Composer).
The project follows [Semantic Versioning](https://semver.org/); while in `0.x`, minor versions may change the API.

## [Unreleased]

### Added
- NoEST provider (`noest`) in TypeScript and PHP: create (optional `autoValidate`), track, fees, wilayas, communes, stop desks (stations), cancel (orders not validated yet) and health check. `listParcels` throws `NOT_SUPPORTED`. Built from the NOEST Public API docs v2.3 and checked against live responses. See [`docs/PROVIDERS.md`](./docs/PROVIDERS.md#noest).
- Spelling-tolerant commune matching for NoEST (`Bab Ezzouar` → NOEST's `Bab Azzouar`): exported helpers `looseNameKey` / `findLocationLoosely` (TS) and `Text::looseKey` / `Text::findLoosely` (PHP). Only used after the exact id / name lookup fails, and only for an unambiguous match.

### Changed
- Composer metadata: `authors` filled in.

## [0.1.8] — 2026-10-24

### Changed
- npm / Composer metadata: richer description and keywords (French + English), homepage now points to the docs site.
- READMEs: badges, install for both languages, FAQ; removed outdated "not published yet" notes (the packages are on npm and Packagist).

### Added
- Docs site: one guide per carrier (Yalidine / GuepEx, ZRExpress, Maystro, Ecotrack), FAQ, `sitemap.xml`, Open Graph image and structured data.
- CI workflow running the TypeScript (Node 18 / 20 / 22) and PHP (8.2 / 8.3 / 8.4) test suites.

### Fixed
- ZRExpress webhook test fixture no longer stores a `whsec_`-prefixed fake key, which secret scanners flagged as a leaked Stripe secret.

## [0.1.7] — 2026-10-21

### Added
- ZRExpress extras: signed webhook verification (`verifyZRExpressWebhook` / `Webhook::verify`), PDF labels (`generateLabels`), bulk create / delete (`createParcelsBulk`, `deleteParcelsBulk`), `createZRExpress()` typed factory. See [`docs/ZREXPRESS.md`](./docs/ZREXPRESS.md).

## [0.1.6] — 2026-10-21

### Added
- `listParcels(query?)` on the contract for account-wide status sync (ZRExpress via `parcels/search`; other carriers `NOT_SUPPORTED` for now).

## [0.1.5] — 2026-10-21

### Changed
- ZRExpress: better stop desk lookup (hubs search) and `stockType` support on parcels and products.

## [0.1.4] — 2026-10-20

### Changed
- Carrier fixes aligned with production integrations: Maystro live fees host with orders-management fallback, Ecotrack tenant hosts.
- GuepEx support through the Yalidine provider (`GUEPEX_DEFAULT_BASE_URL`).

## [0.1.2] — 2026-10-20

### Added
- `healthCheck()` on every provider (TS + PHP): authenticated connectivity probe.

## [0.1.1] — 2026-10-20

### Added
- First public release: unified `createParcel`, `track`, `getFees`, `getWilayas`, `getCommunes`, `getStopDesks`, `cancelParcel` for ZRExpress, Yalidine, Maystro and Ecotrack, in TypeScript and PHP.

[0.1.8]: https://github.com/developing-off/dz-delivery/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/developing-off/dz-delivery/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/developing-off/dz-delivery/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/developing-off/dz-delivery/compare/v0.1.3...v0.1.5
[0.1.2]: https://github.com/developing-off/dz-delivery/releases/tag/v0.1.2
[0.1.1]: https://github.com/developing-off/dz-delivery/releases/tag/v0.1.1
