<?php

declare(strict_types=1);

namespace DzDelivery\Providers;

use DzDelivery\Contracts\ShippingProviderInterface;
use DzDelivery\Errors\ShippingError;
use DzDelivery\Http\HttpClient;
use DzDelivery\Models\ClientOptions;
use DzDelivery\Models\FeeQuery;
use DzDelivery\Models\FeeQuote;
use DzDelivery\Models\HealthCheckResult;
use DzDelivery\Models\Location;
use DzDelivery\Models\Parcel;
use DzDelivery\Models\ParcelInput;
use DzDelivery\Models\ParcelListPage;
use DzDelivery\Models\ParcelListQuery;
use DzDelivery\Models\ParcelStatus;
use DzDelivery\Models\StopDesk;
use DzDelivery\Models\StopDeskQuery;
use DzDelivery\Models\TrackingEvent;
use DzDelivery\Models\TrackResult;
use DzDelivery\Support\Dates;
use DzDelivery\Support\Health;
use DzDelivery\Support\Phone;
use DzDelivery\Support\StatusMapper;
use DzDelivery\Support\Text;

/**
 * E-com Delivery — ecom-dz.com/api_v2. Mapping and assumptions: docs/PROVIDERS.md#ecom.
 *
 * Options: 'apiKey' (KEY, sent as X-API-Key), 'apiToken' (Token, sent as X-API-Token) and
 * 'autoValidate' (default false: parcels stay pending, "En Préparation", until confirmed).
 *
 * Global errors share one shape: { error: { code, message, details? } }. Creation is
 * best-effort per line: HTTP 201 with resultats[i].ok === false.
 */
final class EcomProvider implements ShippingProviderInterface
{
    public const NAME = 'ecom';
    public const DEFAULT_BASE_URL = 'https://ecom-dz.com/api_v2';

    private const TIMEZONE = 'Africa/Algiers';
    private const LIST_MAX_PAGE_SIZE = 100;
    private const LIST_MAX_PAGES = 100;

    /** E-com field (validation `champ`) → ParcelInput field. Same table as the TS provider. */
    private const FIELDS = [
        'nom_complet' => 'recipientName',
        'mobile_1' => 'phone',
        'mobile_2' => 'phone2',
        'adresse' => 'address',
        'id_wilaya' => 'wilayaId',
        'commune' => 'communeId',
        'code_stopdesk' => 'stopDeskId',
        'article' => 'productName',
        'ref_article' => 'productList',
        'quantite' => 'productList',
        'total' => 'price',
        'note_fournisseur' => 'remark',
        'id_externe' => 'orderId',
    ];

    /** Per-line creation error code → ParcelInput field. */
    private const LINE_CODE_FIELDS = [
        'total_insuffisant' => 'price',
    ];

    private const FINAL = [ParcelStatus::DELIVERED, ParcelStatus::RETURNED, ParcelStatus::CANCELLED];

    /** History lines that are notes, not states: they keep the previous status in track(). */
    private const NOTE_LABELS = ['', 'encours', 'biz', 'suiviparecom', 'information', 'typedecolis', 'typedelivraison'];

    private HttpClient $http;
    private bool $includeRaw;
    private bool $autoValidate;

    /** @var Location[]|null */
    private ?array $wilayas = null;

    /** @var array<string, list<array{location: Location, deliverable: bool}>> keyed by wilaya code */
    private array $communes = [];

    public function __construct(ClientOptions $options, ?HttpClient $http = null)
    {
        $apiKey = trim((string) $options->get('apiKey', ''));
        $apiToken = trim((string) $options->get('apiToken', ''));
        if ($apiKey === '' || $apiToken === '') {
            throw new ShippingError(ShippingError::AUTH_FAILED, 'E-com requires "apiKey" and "apiToken"', null, null, null, self::NAME);
        }

        $this->includeRaw = $options->includeRaw;
        $this->autoValidate = (bool) $options->get('autoValidate', false);
        $this->http = $http ?? new HttpClient(
            baseUrl: Dates::requireHttps(trim((string) ($options->baseUrl ?? '')) ?: self::DEFAULT_BASE_URL, self::NAME),
            provider: self::NAME,
            headers: ['X-API-Key' => $apiKey, 'X-API-Token' => $apiToken],
            timeoutMs: $options->timeoutMs,
            includeRaw: $options->includeRaw,
            handler: is_callable($options->handler) ? $options->handler : null,
            errorParser: [self::class, 'parseError'],
        );
    }

    public function getName(): string
    {
        return self::NAME;
    }

    /**
     * POST /colis with a one-item array. Home delivery: the commune is resolved through
     * GET /communes (id, postal code, name, then spelling-tolerant name). Stop desk: only
     * code_stopdesk is read by E-com. With autoValidate, the parcel is created confirmed
     * (confirmee = 1, "En Traitement").
     */
    public function createParcel(ParcelInput|array $input): Parcel
    {
        $input = ParcelInput::from($input, self::NAME);
        $phone = Phone::toLocal($input->phone, self::NAME, 'phone');
        $phone2 = $input->phone2 !== null ? Phone::toLocal($input->phone2, self::NAME, 'phone2') : null;
        $wilayaCode = $this->resolveWilayaCode($input->wilayaId ?? $input->wilayaName);

        $colis = [
            'nom_complet' => trim($input->recipientName),
            'mobile_1' => $phone,
            'id_wilaya' => (int) $wilayaCode,
            'total' => (int) round($input->price),
            'stopdesk' => $input->isStopDesk ? 1 : 0,
        ];
        if ($input->isStopDesk) {
            $colis['code_stopdesk'] = trim((string) $input->stopDeskId);
        } else {
            $colis['commune'] = $this->resolveCommune($wilayaCode, $input->communeId ?? $input->communeName, true)->name;
        }
        // One product line → its name and quantity (and ref_article from its sku, for stock
        // accounts); several → a description, quantity 1.
        $single = $input->productList !== null && count($input->productList) === 1 ? $input->productList[0] : null;
        $colis['article'] = $single !== null ? trim($single->name) : trim($input->productDescription());
        $colis['quantite'] = $single !== null ? $single->quantity : 1;
        if ($single !== null && $single->sku !== null && trim($single->sku) !== '') {
            $colis['ref_article'] = trim($single->sku);
        }
        if ($phone2 !== null) {
            $colis['mobile_2'] = $phone2;
        }
        if (trim($input->address) !== '') {
            $colis['adresse'] = trim($input->address);
        }
        if ($input->remark !== null && trim($input->remark) !== '') {
            $colis['note_fournisseur'] = trim($input->remark);
        }
        if ($input->orderId !== null && trim($input->orderId) !== '') {
            $colis['id_externe'] = trim($input->orderId);
        }
        if ($this->autoValidate) {
            $colis['confirmee'] = 1;
        }

        $body = $this->http->request('POST', 'colis', [], [$colis]);
        $line = null;
        foreach (is_array($body) && is_array($body['resultats'] ?? null) ? $body['resultats'] : [] as $row) {
            if (is_array($row)) {
                $line = $row;
                break;
            }
        }
        if ($line === null) {
            throw ShippingError::providerError('Unexpected E-com creation response', self::NAME, $this->raw($body));
        }
        if (($line['ok'] ?? null) !== true) {
            $code = self::text($line['code'] ?? null);
            $message = self::text($line['erreur'] ?? null) ?? 'E-com rejected the parcel';
            $detail = ['message' => $message];
            if ($code !== null) {
                $detail['code'] = $code;
            }
            // By code, else "stopdesk introuvable (...)" (code validation, seen live).
            $field = self::LINE_CODE_FIELDS[$code ?? ''] ?? (preg_match('/stop\s*desk/i', $message) === 1 ? 'stopDeskId' : null);
            if ($field !== null) {
                $detail['field'] = $field;
            }
            throw new ShippingError(ShippingError::VALIDATION_ERROR, $message, 201, [$detail], $this->raw($body), self::NAME);
        }
        $tracking = self::text($line['tracking'] ?? null);
        if ($tracking === null) {
            throw ShippingError::providerError('E-com did not return a tracking number', self::NAME, $this->raw($body));
        }

        return new Parcel(
            $tracking,
            $tracking,
            $this->autoValidate ? ParcelStatus::CREATED : ParcelStatus::PENDING,
            self::NAME,
            $this->raw($body),
        );
    }

    /**
     * GET /colis/{tracking}: current situation + etat_logistique, and the historique steps
     * (oldest first). Unknown tracking → HTTP 404 colis_introuvable → NOT_FOUND.
     */
    public function track(string $trackingNumber): TrackResult
    {
        $tracking = trim($trackingNumber);
        if ($tracking === '') {
            throw ShippingError::validation('trackingNumber is required', self::NAME, 'trackingNumber');
        }

        $body = $this->http->request('GET', 'colis/' . rawurlencode($tracking));
        if (!is_array($body) || array_is_list($body)) {
            throw ShippingError::providerError('Unexpected E-com parcel response', self::NAME, $this->raw($body));
        }
        $rows = [];
        foreach (is_array($body['historique'] ?? null) ? $body['historique'] : [] as $i => $step) {
            if (is_array($step)) {
                $rows[] = ['step' => $step, 'i' => $i, 'at' => Dates::toIso(self::text($step['date'] ?? null) ?? '', self::TIMEZONE)];
            }
        }
        usort($rows, static fn (array $x, array $y) => Dates::compare($x['at'], $y['at']) ?: $x['i'] <=> $y['i']);

        // Notes (Information, Type de Livraison, BIZ, no situation, ...) keep the previous status;
        // any other unmapped label is reported as unknown.
        $current = ParcelStatus::PENDING;
        $events = [];
        foreach ($rows as ['step' => $step, 'at' => $at]) {
            $situation = self::text($step['situation'] ?? null) ?? '';
            $comment = self::text($step['commentaire'] ?? null);
            $label = $situation !== '' && $comment !== null ? "$situation ($comment)" : ($situation !== '' ? $situation : ($comment ?? ''));
            $mapped = StatusMapper::ecom($situation);
            if ($mapped !== ParcelStatus::UNKNOWN) {
                $current = $mapped;
            }
            $status = $mapped === ParcelStatus::UNKNOWN && !in_array(Text::key($situation), self::NOTE_LABELS, true)
                ? ParcelStatus::UNKNOWN
                : $current;
            $events[] = new TrackingEvent(status: $status, label: $label, at: $at, raw: $this->raw($step));
        }

        return new TrackResult($this->toParcel($body, $tracking), $events);
    }

    /**
     * GET /tarifs: per-wilaya domicile / stopdesk rates and the annuler (cancellation) fee.
     * The account-wide service and emballage fees are billed on top and only in raw.
     */
    public function getFees(FeeQuery|array $query): FeeQuote
    {
        $query = FeeQuery::from($query, self::NAME);
        $code = (int) $this->resolveWilayaCode($query->toWilayaId);

        $body = $this->http->request('GET', 'tarifs');
        if (!is_array($body) || !is_array($body['wilayas'] ?? null)) {
            throw ShippingError::providerError('Unexpected E-com fees response', self::NAME, $this->raw($body));
        }
        $row = null;
        foreach ($body['wilayas'] as $r) {
            if (is_array($r) && is_numeric($r['wilaya'] ?? null) && (int) $r['wilaya'] === $code) {
                $row = $r;
                break;
            }
        }
        $home = self::number($row['domicile'] ?? null);
        $desk = self::number($row['stopdesk'] ?? null);
        $fee = $query->isStopDesk ? $desk : $home;
        if ($fee === null) {
            throw new ShippingError(
                ShippingError::NOT_FOUND,
                'No E-com ' . ($query->isStopDesk ? 'stop-desk' : 'home') . " rate for wilaya $code",
                null,
                null,
                $this->raw($body),
                self::NAME,
            );
        }

        return new FeeQuote(deliveryFee: $fee, returnFee: self::number($row['annuler'] ?? null), stopDeskFee: $desk, raw: $this->raw($body));
    }

    /** GET /wilayas: wilayas served at home or in a stop desk. */
    public function getWilayas(): array
    {
        if ($this->wilayas === null) {
            $body = $this->http->request('GET', 'wilayas');
            if (!is_array($body) || !array_is_list($body)) {
                throw ShippingError::providerError('Unexpected E-com wilayas response', self::NAME, $this->raw($body));
            }
            $wilayas = [];
            foreach ($body as $w) {
                if (!is_array($w) || !is_numeric($w['id'] ?? null)) {
                    continue;
                }
                if (($w['domicile'] ?? null) === false && ($w['stopdesk'] ?? null) === false) {
                    continue;
                }
                $id = (string) (int) $w['id'];
                $wilayas[] = new Location(id: $id, name: trim((string) ($w['libelle'] ?? '')), parentId: null, code: $id, raw: $this->raw($w));
            }
            $this->wilayas = $wilayas;
        }

        return $this->wilayas;
    }

    /** GET /communes?id_wilaya=: deliverable communes only (livrable = true). */
    public function getCommunes(string|int $wilayaId): array
    {
        $rows = array_filter($this->communesOf($this->resolveWilayaCode($wilayaId)), static fn (array $c) => $c['deliverable']);

        return array_values(array_column($rows, 'location'));
    }

    /**
     * GET /stopdesks?id_wilaya=. The desk id is code_stopdesk (→ ParcelInput stopDeskId).
     * With communeId, only desks whose commune is that commune are kept.
     */
    public function getStopDesks(StopDeskQuery|array $query): array
    {
        $query = StopDeskQuery::from($query, self::NAME);
        $code = $this->resolveWilayaCode($query->wilayaId);
        $body = $this->http->request('GET', 'stopdesks', ['id_wilaya' => $code]);
        if (!is_array($body) || !array_is_list($body)) {
            throw ShippingError::providerError('Unexpected E-com stop desks response', self::NAME, $this->raw($body));
        }
        $rows = array_filter($body, static fn ($d) => is_array($d) && self::hasValue($d['code_stopdesk'] ?? null));
        if ($query->communeId !== null) {
            $commune = $this->resolveCommune($code, $query->communeId, false)->name;
            $rows = array_filter($rows, static function (array $d) use ($commune): bool {
                $name = (string) ($d['commune'] ?? '');

                return Text::key($name) === Text::key($commune) || Text::looseKey($name) === Text::looseKey($commune);
            });
        }

        $desks = [];
        foreach ($rows as $d) {
            $phone = null;
            foreach (preg_split('#[,;/]#', (string) ($d['tel_contact'] ?? '')) ?: [] as $p) {
                if (trim($p) !== '') {
                    $phone = trim($p);
                    break;
                }
            }
            $desks[] = new StopDesk(
                id: trim((string) $d['code_stopdesk']),
                name: self::text($d['nom_bureau'] ?? null) ?? trim((string) $d['code_stopdesk']),
                address: self::text($d['adresse'] ?? null),
                wilayaId: $code,
                phone: $phone,
                raw: $this->raw($d),
            );
        }

        return $desks;
    }

    /**
     * GET /colis (newest first, ≤ 100 per page). keyword filters by tracking number(s),
     * updatedSince uses type_date=action from that day (Algeria time): the last logistic move,
     * so parcels not handled yet (no action) are left out. orderId and status
     * filter the fetched page client-side. E-com only reports total on page 1: further
     * pages report a lower bound.
     */
    public function listParcels(ParcelListQuery|array|null $query = null): ParcelListPage
    {
        $query = ParcelListQuery::from($query, self::NAME);
        $pageSize = min(max($query->pageSize, 1), self::LIST_MAX_PAGE_SIZE);
        $keep = static fn (array $parcels) => $query->status === null
            ? $parcels
            : array_values(array_filter($parcels, static fn (Parcel $p) => $p->status === $query->status));

        if ($query->allPages) {
            $all = [];
            $totalCount = 0;
            $lastRaw = null;
            $hasNext = true;
            for ($n = 1; $hasNext && $n <= self::LIST_MAX_PAGES; $n++) {
                [$parcels, $count, $hasNext, $lastRaw] = $this->listPage($query, $n, $pageSize);
                array_push($all, ...$parcels);
                if ($n === 1) {
                    $totalCount = $count;
                }
            }

            // hasNext stays true when the page cap cut the walk short.
            return new ParcelListPage($keep($all), 1, $pageSize, $totalCount, $hasNext, $this->raw($lastRaw));
        }

        [$parcels, $totalCount, $hasNext, $raw] = $this->listPage($query, $query->page, $pageSize);

        return new ParcelListPage($keep($parcels), $query->page, $pageSize, $totalCount, $hasNext, $this->raw($raw));
    }

    /**
     * DELETE /colis/{tracking} (soft delete). Only parcels still "En Préparation":
     * HTTP 409 → VALIDATION_ERROR; unknown tracking (404) → NOT_FOUND.
     */
    public function cancelParcel(string $trackingNumberOrId): void
    {
        $tracking = trim($trackingNumberOrId);
        if ($tracking === '') {
            throw ShippingError::validation('trackingNumberOrId is required', self::NAME, 'trackingNumberOrId');
        }

        try {
            $body = $this->http->request('DELETE', 'colis/' . rawurlencode($tracking));
        } catch (ShippingError $e) {
            if ($e->httpStatus === 409) {
                throw new ShippingError(
                    ShippingError::VALIDATION_ERROR,
                    "E-com parcel $tracking cannot be cancelled: it has already left preparation (only parcels \"En Préparation\" can be deleted)",
                    409,
                    $e->details,
                    $e->raw,
                    self::NAME,
                    $e,
                );
            }
            throw $e;
        }
        if (is_array($body) && ($body['ok'] ?? null) === false) {
            throw new ShippingError(
                ShippingError::VALIDATION_ERROR,
                self::text($body['erreur'] ?? null) ?? "E-com refused to delete parcel $tracking",
                null,
                null,
                $this->raw($body),
                self::NAME,
            );
        }
    }

    /** Probes `GET wilayas` (bypasses cache). */
    public function healthCheck(): HealthCheckResult
    {
        return Health::probeWilayas(
            self::NAME,
            function (): void {
                $this->wilayas = null;
            },
            fn () => $this->getWilayas(),
        );
    }

    /**
     * `{ error: { code, message, details? } }` (or nested under `detail`) → [message, details].
     * Validation details (`[{ champ, raison }]`) become field details; otherwise the error code
     * is kept as `details[0].code`.
     *
     * @return array{0: ?string, 1: ?array}
     */
    public static function parseError(int $status, mixed $body): array
    {
        $error = null;
        if (is_array($body)) {
            $error = is_array($body['error'] ?? null) ? $body['error'] : (is_array($body['detail']['error'] ?? null) ? $body['detail']['error'] : null);
        }
        if ($error === null) {
            return HttpClient::defaultErrorParser($status, $body);
        }
        $code = self::text($error['code'] ?? null);
        $message = self::text($error['message'] ?? null) ?? $code;
        $details = [];
        if (is_array($error['details'] ?? null) && array_is_list($error['details'])) {
            foreach ($error['details'] as $d) {
                if (is_array($d) && self::text($d['raison'] ?? null) !== null) {
                    $details[] = ['field' => self::fieldOf((string) ($d['champ'] ?? '')), 'message' => self::text($d['raison'])];
                }
            }
        } elseif ($code !== null) {
            $detail = ['message' => $message ?? $code, 'code' => $code];
            if (isset(self::LINE_CODE_FIELDS[$code])) {
                $detail['field'] = self::LINE_CODE_FIELDS[$code];
            }
            $details[] = $detail;
        }

        return [$message, $details === [] ? null : $details];
    }

    // --- internals ---------------------------------------------------------------

    /**
     * A parcel's status from its two labels: a final situation (delivered, returned,
     * cancelled) wins, then the physical etat_logistique, then any other situation.
     */
    private static function parcelStatus(mixed $situation, mixed $etat): string
    {
        $fromSituation = StatusMapper::ecom(self::text($situation));
        if (in_array($fromSituation, self::FINAL, true)) {
            return $fromSituation;
        }
        $fromEtat = StatusMapper::ecom(self::text($etat));

        return $fromEtat !== ParcelStatus::UNKNOWN ? $fromEtat : $fromSituation;
    }

    /** @param array<string, mixed> $row */
    private function toParcel(array $row, string $fallbackTracking): Parcel
    {
        $tracking = self::text($row['tracking'] ?? null) ?? $fallbackTracking;

        return new Parcel(
            $tracking,
            $tracking,
            self::parcelStatus($row['situation'] ?? null, $row['etat_logistique'] ?? null),
            self::NAME,
            $this->raw($row),
        );
    }

    /** @return array{0: list<Parcel>, 1: int, 2: bool, 3: mixed} */
    private function listPage(ParcelListQuery $query, int $page, int $pageSize): array
    {
        $params = ['page' => $page, 'limit' => $pageSize];
        if ($query->keyword !== null && trim($query->keyword) !== '') {
            $params['tracking'] = trim($query->keyword);
        }
        if ($query->updatedSince !== null) {
            try {
                $since = new \DateTimeImmutable($query->updatedSince);
            } catch (\Exception) {
                throw ShippingError::validation('updatedSince must be an ISO 8601 date', self::NAME, 'updatedSince');
            }
            $params['type_date'] = 'action';
            $params['date_debut'] = $since->setTimezone(new \DateTimeZone(self::TIMEZONE))->format('Y-m-d');
        }

        $body = $this->http->request('GET', 'colis', $params);
        if (!is_array($body) || !is_array($body['items'] ?? null)) {
            throw ShippingError::providerError('Unexpected E-com parcel list response', self::NAME, $this->raw($body));
        }
        $items = array_values(array_filter($body['items'], 'is_array'));
        $orderId = $query->orderId !== null ? trim($query->orderId) : null;
        $parcels = [];
        foreach ($items as $item) {
            if ($orderId === null || self::text($item['id_externe'] ?? null) === $orderId) {
                $parcels[] = $this->toParcel($item, '');
            }
        }
        $total = self::number($body['total'] ?? null);
        $totalPages = self::number($body['total_pages'] ?? null);

        return [
            $parcels,
            $total !== null ? (int) $total : ($page - 1) * $pageSize + count($items),
            $totalPages !== null ? $page < $totalPages : count($items) === $pageSize,
            $body,
        ];
    }

    /** @return list<array{location: Location, deliverable: bool}> */
    private function communesOf(string $wilayaCode): array
    {
        if (!isset($this->communes[$wilayaCode])) {
            $body = $this->http->request('GET', 'communes', ['id_wilaya' => $wilayaCode]);
            if (!is_array($body) || !array_is_list($body)) {
                throw ShippingError::providerError('Unexpected E-com communes response', self::NAME, $this->raw($body));
            }
            $communes = [];
            foreach ($body as $c) {
                if (!is_array($c) || !self::hasValue($c['commune'] ?? null) || !self::hasValue($c['id'] ?? null)) {
                    continue;
                }
                if (self::hasValue($c['id_wilaya'] ?? null) && (int) $c['id_wilaya'] !== (int) $wilayaCode) {
                    continue;
                }
                $communes[] = [
                    'location' => new Location(
                        id: (string) $c['id'],
                        name: trim((string) $c['commune']),
                        parentId: $wilayaCode,
                        code: self::text($c['code_postal'] ?? null),
                        raw: $this->raw($c),
                    ),
                    'deliverable' => ($c['livrable'] ?? null) !== false,
                ];
            }
            $this->communes[$wilayaCode] = $communes;
        }

        return $this->communes[$wilayaCode];
    }

    /** Official code 1–58 as-is (E-com ids are the codes); names via wilayas. */
    private function resolveWilayaCode(string|int|null $ref): string
    {
        $value = trim((string) $ref);
        if (preg_match('/^\d{1,2}$/', $value) === 1 && (int) $value >= 1 && (int) $value <= 58) {
            return (string) (int) $value;
        }
        if (!ctype_digit($value)) {
            foreach ($this->getWilayas() as $w) {
                if (Text::key($w->name) === Text::key($value)) {
                    return $w->id;
                }
            }
        }

        throw ShippingError::notFound('Unknown wilaya: ' . $value, self::NAME);
    }

    /**
     * By id, postal code, exact name, then spelling-tolerant name (unambiguous only).
     * With $deliverableOnly, a commune E-com does not serve is a VALIDATION_ERROR.
     */
    private function resolveCommune(string $wilayaCode, string|int|null $ref, bool $deliverableOnly): Location
    {
        $value = trim((string) $ref);
        $rows = $this->communesOf($wilayaCode);
        $found = null;
        foreach ($rows as $row) {
            if ($row['location']->id === $value || $row['location']->code === $value) {
                $found = $row;
                break;
            }
        }
        if ($found === null) {
            foreach ($rows as $row) {
                if (Text::key($row['location']->name) === Text::key($value)) {
                    $found = $row;
                    break;
                }
            }
        }
        $found ??= Text::findLoosely($rows, $value, static fn (array $row) => $row['location']->name);
        if ($found === null) {
            throw ShippingError::notFound("Unknown commune: $value in wilaya $wilayaCode", self::NAME);
        }
        if ($deliverableOnly && !$found['deliverable']) {
            $name = $found['location']->name;
            throw new ShippingError(
                ShippingError::VALIDATION_ERROR,
                "E-com does not deliver to $name (wilaya $wilayaCode)",
                null,
                [['field' => 'communeId', 'message' => "E-com does not deliver to $name"]],
                null,
                self::NAME,
            );
        }

        return $found['location'];
    }

    /** `0.nom_complet` → `recipientName`. */
    private static function fieldOf(string $champ): string
    {
        $name = (string) preg_replace('/^(body\.)?\d+\./', '', $champ);

        return self::FIELDS[$name] ?? $name;
    }

    private static function hasValue(mixed $value): bool
    {
        return is_scalar($value) && trim((string) $value) !== '';
    }

    private static function text(mixed $value): ?string
    {
        return self::hasValue($value) ? trim((string) $value) : null;
    }

    private static function number(mixed $value): int|float|null
    {
        return is_numeric($value) ? $value + 0 : null;
    }

    private function raw(mixed $value): mixed
    {
        return $this->includeRaw ? $value : null;
    }
}
