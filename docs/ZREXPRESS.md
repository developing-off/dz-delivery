# ZRExpress — couverture SDK

Matrice **endpoint natif → SDK** pour le transporteur `zrexpress`.  
Le contrat unifié (`ShippingProvider`) reste inchangé : bulk, labels et webhooks receive sont des **extras** sur `ZRExpressProvider` (et helpers), pas sur l’interface commune.

Docs officielles : [API reference](https://docs.zrexpress.app/reference) · [Guides](https://docs.zrexpress.app/docs) · [Webhooks](https://docs.zrexpress.app/docs/webhooks).

## Accès DX

```ts
import { createZRExpress, verifyZRExpressWebhook } from '@dz-delivery/core';

const zr = createZRExpress({ apiKey, tenant }); // → ZRExpressProvider (pas seulement ShippingProvider)
await zr.createParcelsBulk([...]);
await zr.generateLabels(['16-ABC123-ZR']);
```

```php
use DzDelivery\Providers\ZRExpressProvider;
use DzDelivery\Providers\ZRExpress\Webhook;

$zr = new ZRExpressProvider(['apiKey' => ..., 'tenant' => ...]);
$zr->createParcelsBulk([...]);
$event = Webhook::verify($rawBody, $headers, $signingSecret);
```

`createClient('zrexpress', …)` / `ClientFactory::create('zrexpress', …)` continuent de renvoyer l’interface unifiée (pas de breaking change).

## Matrice

| Domaine | Natif | SDK | Notes |
|---------|-------|-----|-------|
| create / track / fees / wilayas / communes / stop desks / list / cancel / health | oui | **contrat** | Voir [`PROVIDERS.md`](./PROVIDERS.md#zrexpress) |
| `listParcels` | `POST …/parcels/search` | **contrat** | Pull ; préférer webhooks en live |
| Webhooks receive (verify + parse) | Svix / Standard Webhooks | **extras** helpers | `verifyZRExpressWebhook` / `Webhook::verify` — **raw body obligatoire** |
| Webhooks manage endpoints | CRUD `…/webhooks/endpoints` | non (doc URLs) | Configurer via le portail Svix ou l’API native |
| Labels (multiple) | `POST …/parcels/labels/multiple` | **extras** `generateLabels` | Max 250 ; `X-Api-Key` + `X-Tenant` (comme le reste du SDK) |
| Labels (individual) | `POST …/parcels/labels/individual` | **extras** `generateLabels({ mode: 'individual' })` | Max 100 |
| Bulk create | `POST …/parcels/bulk` | **extras** `createParcelsBulk` | Max 100 ; `orderId` (`externalId`) **requis** par item |
| Bulk delete (UUID) | `DELETE …/parcels/bulk` | **extras** `deleteParcelsBulk` | Max 200 |
| Bulk delete (tracking) | `DELETE …/parcels/bulk/by-tracking-number` | **extras** `deleteParcelsBulk` | Détection UUID vs tracking |
| Update parcel / exchanges / refunds | oui natif | **backlog** | Prochain lot |
| Pickup bags | oui natif | **backlog** | |
| Catalog / claims / treasury / reports | oui natif | **backlog** | |

Légende : **contrat** = `ShippingProvider` · **extras** = méthodes / helpers ZR-only · **backlog** = hors scope 0.1.7.

## Webhooks (receive)

ZRExpress pousse des événements signés (Svix). Le SDK **ne dépend pas** du package `svix` : vérification HMAC-SHA256 (Standard Webhooks) avec `crypto` (Node) / `hash_hmac` (PHP).

1. Lire le **corps brut** de la requête (avant `JSON.parse` / middleware qui re-sérialise).
2. Passer les headers `svix-id` / `svix-timestamp` / `svix-signature` (aliases `webhook-*` acceptés).
3. Utiliser le **Signing Secret** du portail (souvent `whsec_…`).

```ts
import { verifyZRExpressWebhook } from '@dz-delivery/core';

app.post('/webhooks/zrexpress', express.raw({ type: '*/*' }), (req, res) => {
  const event = verifyZRExpressWebhook(req.body, req.headers, process.env.ZREXPRESS_WEBHOOK_SECRET!);
  // event.type, event.parcelId, event.trackingNumber, event.status (unifié), event.raw
  res.sendStatus(200);
});
```

```php
$raw = file_get_contents('php://input'); // pas Request::json()
$event = Webhook::verify($raw, getallheaders(), getenv('ZREXPRESS_WEBHOOK_SECRET'));
```

Fenêtre d’horloge ~5 minutes. Signature invalide / timestamp trop vieux → `ShippingError` (`AUTH_FAILED` / `VALIDATION_ERROR`).

Gestion des endpoints (CRUD) : [Create](https://docs.zrexpress.app/reference/createendpointendpoint) · [List](https://docs.zrexpress.app/reference/listendpointsendpoint) — non wrappés dans le SDK pour l’instant.

## Labels

```ts
const multi = await zr.generateLabels(['16-AAA111-ZR', '16-BBB222-ZR']);
// { fileUrl, failedTrackingNumbers, raw }

const oneByOne = await zr.generateLabels(['16-AAA111-ZR'], { mode: 'individual' });
// { labels: [{ trackingNumber, fileUrl }], failedTrackingNumbers, raw }
```

Auth : mêmes headers que le reste du SDK (`X-Api-Key` + `X-Tenant`). La doc OpenAPI cite parfois `Authorization: Bearer` pour les labels ; si un compte renvoie `401`, ouvrir un ticket côté ZR / adapter avec un bearer optionnel dans un lot ultérieur.

## Bulk create / delete

```ts
const created = await zr.createParcelsBulk([
  { ...parcelInput, orderId: 'ORD-1' }, // orderId obligatoire en bulk
  { ...parcelInput, orderId: 'ORD-2' },
]);
// { successes: Parcel[], failures: [{ index, orderId?, error }], raw }
// HTTP 200 / 207 / 400 (tout en échec) → résultat structuré, pas d’exception si le corps est un rapport bulk

const deleted = await zr.deleteParcelsBulk([
  '8c1a4c53-0000-4000-8000-000000000001', // UUID → DELETE …/parcels/bulk
  '16-AAA111-ZR',                           // tracking → …/bulk/by-tracking-number
]);
```

Réponses partielles (`207`) et échecs totaux (`400` avec `successes`/`failures`) sont mappés en `BulkCreateResult` / `BulkDeleteResult` sans faire planter l’appelant.

## Hors scope (prochain lot)

Update parcel (adresse, montant, produits), pickup bags, catalog, exchanges/refunds, claims, treasury.
