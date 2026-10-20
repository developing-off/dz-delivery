# dz-delivery — Découpage des tâches

> SDK unifié (TypeScript **et** PHP) pour les APIs de livraison : ZRExpress, Yalidine, et autres.
> Objectif : **une interface commune simple**, pas une copie 1:1 de tous les endpoints dès le jour 1.

---

## Décision d’architecture

| Choix | Décision |
|-------|----------|
| Langages | **TypeScript (npm)** + **PHP (Composer)** en parallèle |
| Repo | Monorepo `packages/ts` + `packages/php` |
| Contrat commun | Même modèle mental : `createParcel`, `track`, `getFees`, `getLocations`, `cancel` |
| Auth | Par provider (`apiKey`, `token`, `tenant`, etc.) via config |
| MVP providers | 1) ZRExpress 2) Yalidine 3) stub pour un 3e |

**Oui, on peut faire les deux en même temps** : même spec (types / interfaces), deux implémentations. On fige d’abord le contrat commun, puis on code TS et PHP en parallèle.

---

## Phase 0 — Fondations repo

- [x] **T0.1** Initialiser git + `.gitignore` (node_modules, vendor, .env, dist)
- [x] **T0.2** Créer la structure monorepo :
  ```
  /
  ├── docs/
  ├── packages/
  │   ├── ts/          # npm: @dz-delivery/core
  │   └── php/         # composer: dz-delivery/sdk
  ├── examples/
  ├── TASKS.md
  └── README.md
  ```
- [x] **T0.3** README : vision, providers supportés, quickstart TS + PHP
- [x] **T0.4** Licence MIT + CONTRIBUTING.md (good first issues)
- [x] **T0.5** Fichiers `.env.example` (clés API, tenant) — jamais committer les vraies clés

---

## Phase 1 — Contrat commun (spec partagée)

> Source de vérité avant le code. Évite que TS et PHP divergent.

- [x] **T1.1** Documenter le modèle commun dans `docs/CONTRACT.md` :
  - `ParcelInput` (destinataire, téléphone, adresse, wilaya, commune, produit, COD, poids…)
  - `Parcel` (id, tracking, status, raw?)
  - `TrackingEvent`
  - `FeeQuote`
  - `Location` (wilaya / commune)
  - `ShippingError` (codes normalisés)
- [x] **T1.2** Définir l’interface `ShippingProvider` (5 méthodes MVP) :
  1. `createParcel`
  2. `track`
  3. `getFees`
  4. `getWilayas` / `getCommunes`
  5. `cancelParcel` (si dispo chez le carrier)
- [x] **T1.3** Mapping status unifié : `pending | created | in_transit | delivered | returned | cancelled | unknown`
- [x] **T1.4** Décider : exposer `raw` (réponse API native) en option pour power users

---

## Phase 2 — Package TypeScript (`packages/ts`)

- [x] **T2.1** Init npm : `package.json`, TypeScript, `tsup` ou `unbuild`, exports ESM/CJS
- [x] **T2.2** Types + interface `ShippingProvider` / `createClient(provider, config)`
- [x] **T2.3** Client HTTP de base (fetch) + gestion erreurs HTTP
- [x] **T2.4** Provider **ZRExpress** :
  - auth : `X-Api-Key` + `X-Tenant` ([docs create product](https://docs.zrexpress.app/reference/createproductendpoint))
  - endpoints MVP : create parcel / track / fees / locations (selon docs)
  - mapping → contrat commun
- [x] **T2.5** Provider **Yalidine** (mêmes 5 méthodes) — best-effort, à confirmer avec de vraies réponses
- [x] **T2.6** Tests unitaires (mock HTTP) pour ZRExpress + Yalidine (vitest + fixtures partagées `docs/fixtures/`)
- [x] **T2.7** Exemple `examples/ts/quickstart.ts`
- [x] **T2.8** Publier en local (`npm pack`) — publication npm plus tard

---

## Phase 3 — Package PHP (`packages/php`)

- [x] **T3.1** Init Composer : `composer.json`, PSR-4, PHPUnit
- [x] **T3.2** Interface `ShippingProviderInterface` + factory `ClientFactory`
- [x] **T3.3** Client HTTP (PSR-18 ou Guzzle) — Guzzle 7
- [x] **T3.4** Provider **ZRExpress** (même mapping que TS)
- [x] **T3.5** Provider **Yalidine** (best-effort, à confirmer avec de vraies réponses sandbox)
- [x] **T3.6** Tests PHPUnit avec mocks (Guzzle `MockHandler` + fixtures `docs/fixtures/`)
- [x] **T3.7** Exemple `examples/php/quickstart.php`
- [ ] **T3.8** Prêt pour Packagist (plus tard)

---

## Phase 4 — Alignement TS ↔ PHP

- [ ] **T4.1** Checklist : mêmes noms de méthodes / champs / status
- [ ] **T4.2** Table de mapping dans `docs/PROVIDERS.md` (endpoint natif → méthode unifiée)
- [ ] **T4.3** Fixtures de test partagées (`docs/fixtures/` JSON) utilisées par TS et PHP
- [ ] **T4.4** Script CI basique (GitHub Actions) : test TS + test PHP

---

## Phase 5 — Docs & communauté open source

- [ ] **T5.1** Guide “Ajouter un provider” (template)
- [ ] **T5.2** Tableau des providers : supporté / partiel / prévu
- [ ] **T5.3** Labels GitHub : `good first issue`, `provider:zrexpress`, `docs`
- [ ] **T5.4** 3 issues starter pour contributeurs
- [ ] **T5.5** Changelog (Keep a Changelog)

---

## Phase 6 — Extensions (après MVP)

- [x] **T6.1** 3e provider : **Maystro Delivery** (TS + PHP, fixtures partagées ; `track` / `cancelParcel` → `NOT_SUPPORTED`, suivi par webhooks uniquement)
- [x] **T6.1b** 4e provider : **Ecotrack** (un seul provider pour DHD, Conexlog, MSM Go, Packers, World Express… ; option `courier` ou `baseUrl`, `autoValidate`)
- [ ] **T6.2** Endpoints “catalogue” ZRExpress (ex. create product) en module optionnel
- [ ] **T6.3** Webhooks / statut push si dispo
- [ ] **T6.4** CLI (`dz-delivery track <id>`)
- [ ] **T6.5** Plugins PrestaShop / WooCommerce (consomment le package PHP)

---

## Ordre de travail recommandé (parallèle TS + PHP)

```
Semaine 1:  T0.* + T1.*          ← spec commune (obligatoire avant split)
Semaine 2:  T2.1–T2.4 || T3.1–T3.4   ← ZRExpress en TS et PHP en parallèle
Semaine 3:  T2.5–T2.7 || T3.5–T3.7   ← Yalidine + exemples
Semaine 4:  T4.* + T5.*              ← alignement + open source
```

**Règle d’or** : si un champ n’est pas dans le contrat commun (`docs/CONTRACT.md`), on ne l’ajoute pas “juste pour un provider” sans discussion.

---

## Hors scope MVP (volontairement)

- Wrapper de **tous** les endpoints de chaque société
- Dashboard UI complet
- Hébergement SaaS / multi-tenant cloud
- Stockage des clés API utilisateurs

---

## Prochaines actions immédiates

1. Valider le nom du package (`dz-delivery` ?)
2. Valider les 2 premiers providers : **ZRExpress + Yalidine**
3. Exécuter **Phase 0 + Phase 1**
4. Brancher ZRExpress (TS puis PHP, ou les deux en parallèle)

---

## Suivi

| Phase | Status |
|-------|--------|
| 0 Fondations | ✅ done |
| 1 Contrat | ✅ done (v0.1 — mapping statuts ZRExpress à confirmer via fixtures) |
| 2 TypeScript | ✅ done (Yalidine à valider avec des réponses réelles) |
| 3 PHP | ✅ done (T3.8 Packagist plus tard ; mappings à confirmer via fixtures réelles) |
| 4 Alignement | ⬜ todo |
| 5 Communauté | ⬜ todo |
| 6 Extensions | 🟡 T6.1 done (Maystro, Ecotrack), reste backlog |
