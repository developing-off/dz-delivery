# Contributing to dz-delivery

Thanks for helping make shipping in Algeria easier to integrate! 🇩🇿

## Ground rules

1. **The contract comes first.** [`docs/CONTRACT.md`](./docs/CONTRACT.md) is the source of truth. TypeScript and PHP must expose the same method names, field names and statuses.
2. **No provider-only fields** in the shared models without discussion. Open an issue first. Provider-specific data belongs in `raw`.
3. **Never commit credentials.** Use `.env` (git-ignored) based on `.env.example`. Scrub API keys, phone numbers and names from fixtures.
4. **Keep changes small** and focused. One provider or one feature per pull request.

## Development setup

```bash
git clone <repo-url> dz-delivery
cd dz-delivery
cp .env.example .env   # fill in your sandbox credentials
```

- TypeScript package: `packages/ts` (setup instructions will land in Phase 2)
- PHP package: `packages/php` (setup instructions will land in Phase 3)

## How to add a provider

1. **Open an issue** titled `provider: <name>` with a link to the carrier's API docs and the auth scheme.
2. **Document the mapping** in [`docs/PROVIDERS.md`](./docs/PROVIDERS.md): for each unified method, list the native endpoint, HTTP verb, and how fields/statuses map. Mark unsupported methods explicitly.
3. **Map statuses** from the carrier's native states to the unified set (`pending | created | in_transit | delivered | returned | cancelled | unknown`). Unknown native states must map to `unknown`, never throw.
4. **Add fixtures** under `docs/fixtures/<provider>/` (anonymized native responses + expected unified output). See [`docs/fixtures/README.md`](./docs/fixtures/README.md).
5. **Implement in TypeScript** under `packages/ts/src/providers/<provider>/`.
6. **Implement in PHP** under `packages/php/src/Providers/<Provider>/`.
7. **Write tests** in both packages using the shared fixtures with mocked HTTP (no real API calls in CI).
8. **Update the provider table** in `README.md`.

It is fine to submit only the TS *or* the PHP implementation first — mark the other as `planned`.

If a carrier does not support an operation (e.g. cancellation), throw/return a `ShippingError` with code `NOT_SUPPORTED`.

## Good first issues

Look for the `good first issue` label. Typical starter tasks:

- Add anonymized fixtures for a ZRExpress or Yalidine endpoint
- Complete the Yalidine section of `docs/PROVIDERS.md`
- Add a native → unified status mapping table for a provider
- Improve the quickstart examples in `examples/ts` or `examples/php`
- Write a wilaya reference list (58 wilayas, codes + French/Arabic names) as a fixture
- Research and document a 3rd carrier (Maystro, Ecotrack, …) in `docs/PROVIDERS.md`

## Commit & PR conventions

- Use clear commit messages, e.g. `feat(ts): add yalidine track`, `docs: zrexpress fee mapping`.
- Labels: `provider:<name>`, `lang:ts`, `lang:php`, `docs`, `good first issue`.
- PRs must keep TS and PHP behavior aligned with the contract.
