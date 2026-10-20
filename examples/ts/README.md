# TypeScript examples

## `quickstart.ts`

Lists wilayas and communes, quotes a delivery fee, and optionally tracks or creates a parcel.

```bash
cp .env.example .env            # at the repo root, then fill in your keys
cd packages/ts && npm install && cd ../..

# ZRExpress (default)
npx --prefix packages/ts tsx --env-file=.env examples/ts/quickstart.ts

# Yalidine
DZ_PROVIDER=yalidine YALIDINE_FROM_WILAYA_ID=16 \
  npx --prefix packages/ts tsx --env-file=.env examples/ts/quickstart.ts
```

Optional variables:

| Variable | Effect |
|----------|--------|
| `DZ_TRACKING` | Track this tracking number and print its history. |
| `DZ_CREATE_PARCEL=1` | **Creates a real parcel** on your account, then cancels it. |
