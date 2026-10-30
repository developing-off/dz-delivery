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
 * NOEST — app.noest-dz.com/api/public. Mapping and assumptions: docs/PROVIDERS.md#noest.
 *
 * Options: 'apiToken' (sent as Authorization: Bearer), 'userGuid' (partner GUID, sent in
 * every POST body) and 'autoValidate' (default false: orders stay pending, still
 * editable, until validated).
 *
 * Business failures come back as HTTP 422 { success: false, errors: { <code>: "<message>" } }
 * (e.g. account_suspended) or HTTP 200 { success: false, message }; an unknown user_guid
 * is HTTP 404 { success: false, message: "Partenaire introuvable" }.
 */
final class NoestProvider implements ShippingProviderInterface
{
    public const NAME = 'noest';
    public const DEFAULT_BASE_URL = 'https://app.noest-dz.com';

    private const API_PREFIX = '/api/public';
    private const TIMEZONE = 'Africa/Algiers';
    private const ORDER_TYPE_DELIVERY = 1;

    /** Events that annotate an order (edits, surcharges) without changing where it is. */
    private const REMARK_EVENTS = ['editedinformations', 'editprice', 'editwilaya', 'extrafee'];

    /** Business error codes from the documentation → unified code. Same table as the TS provider. */
    private const BUSINESS_ERRORS = [
        'account_suspended' => ShippingError::AUTH_FAILED,
        'duplicate_order' => ShippingError::VALIDATION_ERROR,
        'inactive_commune' => ShippingError::VALIDATION_ERROR,
        'zip_code' => ShippingError::VALIDATION_ERROR,
        'max_amount_exceeded' => ShippingError::VALIDATION_ERROR,
        'stopdesk_disabled' => ShippingError::VALIDATION_ERROR,
        'station_expedition' => ShippingError::VALIDATION_ERROR,
        'station_code' => ShippingError::VALIDATION_ERROR,
        'disabled_module' => ShippingError::VALIDATION_ERROR,
        'wrong_quantities' => ShippingError::VALIDATION_ERROR,
        'invalid_product' => ShippingError::VALIDATION_ERROR,
        'out_of_stock' => ShippingError::VALIDATION_ERROR,
        'already_validated' => ShippingError::VALIDATION_ERROR,
    ];

    /** NOEST field → ParcelInput field, for 422 details. */
    private const FIELDS = [
        'client' => 'recipientName',
        'phone' => 'phone',
        'phone_2' => 'phone2',
        'adresse' => 'address',
        'wilaya_id' => 'wilayaId',
        'commune' => 'communeId',
        'montant' => 'price',
        'produit' => 'productName',
        'poids' => 'weight',
        'station_code' => 'stopDeskId',
        'remarque' => 'remark',
        'reference' => 'orderId',
    ];

    private HttpClient $http;
    private string $userGuid;
    private bool $includeRaw;
    private bool $autoValidate;

    /** @var Location[]|null */
    private ?array $wilayas = null;

    /** @var list<array{desk: StopDesk, commune: string}>|null */
    private ?array $desks = null;

    /** @var array<string, list<Location>> keyed by wilaya code */
    private array $communes = [];

    public function __construct(ClientOptions $options, ?HttpClient $http = null)
    {
        $token = (string) preg_replace('/^bearer\s+/i', '', trim((string) $options->get('apiToken', '')));
        $userGuid = trim((string) $options->get('userGuid', ''));
        if ($token === '' || $userGuid === '') {
            throw new ShippingError(ShippingError::AUTH_FAILED, 'NOEST requires "apiToken" and "userGuid"', null, null, null, self::NAME);
        }
        $base = trim((string) ($options->baseUrl ?? '')) ?: self::DEFAULT_BASE_URL;
        $base = (string) preg_replace('#/api/public$#i', '', rtrim($base, '/'));

        $this->userGuid = $userGuid;
        $this->includeRaw = $options->includeRaw;
        $this->autoValidate = (bool) $options->get('autoValidate', false);
        $this->http = $http ?? new HttpClient(
            baseUrl: $base . self::API_PREFIX,
            provider: self::NAME,
            headers: ['Authorization' => 'Bearer ' . $token],
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
     * POST /create/order. The commune is resolved to NOEST's spelling through
     * get/communes/{wilaya}. With autoValidate, POST /valid/order follows.
     */
    public function createParcel(ParcelInput|array $input): Parcel
    {
        $input = ParcelInput::from($input, self::NAME);
        $phone = Phone::toLocal($input->phone, self::NAME, 'phone');
        $phone2 = $input->phone2 !== null ? Phone::toLocal($input->phone2, self::NAME, 'phone2') : null;

        $wilayaCode = $this->resolveWilayaCode($input->wilayaId ?? $input->wilayaName);
        $commune = $this->resolveCommune($wilayaCode, $input->communeId ?? $input->communeName);

        $order = [
            'user_guid' => $this->userGuid,
            'client' => trim($input->recipientName),
            'phone' => $phone,
            'adresse' => trim($input->address),
            'wilaya_id' => (int) $wilayaCode,
            'commune' => $commune->name,
            // montant includes the delivery fee: it is exactly what the recipient pays.
            'montant' => (int) round($input->price),
            'produit' => trim($input->productDescription()),
            'type_id' => self::ORDER_TYPE_DELIVERY,
            'stop_desk' => $input->isStopDesk ? 1 : 0,
        ];
        if ($phone2 !== null) {
            $order['phone_2'] = $phone2;
        }
        if ($input->isStopDesk) {
            $order['station_code'] = trim((string) $input->stopDeskId);
        }
        if ($input->weight !== null) {
            $order['poids'] = $input->weight;
        }
        if ($input->remark !== null && trim($input->remark) !== '') {
            $order['remarque'] = trim($input->remark);
        }
        if ($input->orderId !== null && trim($input->orderId) !== '') {
            $order['reference'] = trim($input->orderId);
        }

        $body = $this->send('POST', 'create/order', $order);
        if (is_array($body) && ($body['success'] ?? null) === false) {
            throw $this->businessError($body, 200, 'NOEST rejected the order');
        }
        $tracking = is_array($body) && self::hasValue($body['tracking'] ?? null) ? trim((string) $body['tracking']) : null;
        if ($tracking === null) {
            throw ShippingError::providerError('NOEST did not return a tracking number', self::NAME, $this->raw($body));
        }
        $status = ParcelStatus::PENDING;
        if ($this->autoValidate) {
            $this->validateOrder($tracking);
            $status = ParcelStatus::CREATED;
        }

        return new Parcel($tracking, $tracking, $status, self::NAME, $this->raw($body));
    }

    /**
     * POST /get/trackings/info for one tracking number. Status comes from each
     * activity[].event_key (or the English event label); remark events keep the previous
     * status. No activity yet means the order is not validated (pending).
     */
    public function track(string $trackingNumber): TrackResult
    {
        $tracking = trim($trackingNumber);
        if ($tracking === '') {
            throw ShippingError::validation('trackingNumber is required', self::NAME, 'trackingNumber');
        }

        $notFound = fn (mixed $raw, ?int $status = null) => new ShippingError(
            ShippingError::NOT_FOUND,
            "Unknown NOEST tracking number: $tracking",
            $status,
            null,
            $this->raw($raw),
            self::NAME,
        );
        try {
            $body = $this->send('POST', 'get/trackings/info', ['user_guid' => $this->userGuid, 'trackings' => [$tracking]]);
        } catch (ShippingError $e) {
            // Unknown trackings: HTTP 404 { message: "Trackings non trouvés" }.
            if ($e->code === ShippingError::NOT_FOUND) {
                throw $notFound($e->raw, 404);
            }
            throw $e;
        }
        $info = is_array($body) ? ($body[$tracking] ?? null) : null;
        if (!is_array($info) || array_is_list($info)) {
            throw $notFound($body);
        }

        $rows = [];
        foreach (self::entries($info['activity'] ?? null) as $i => $a) {
            if (is_array($a) && !array_is_list($a)) {
                $rows[] = ['a' => $a, 'i' => $i, 'at' => Dates::toIso(self::text($a['date'] ?? null) ?? '', self::TIMEZONE)];
            }
        }
        usort($rows, static fn (array $x, array $y) => strcmp($x['at'], $y['at']) ?: $x['i'] <=> $y['i']);

        $current = ParcelStatus::PENDING;
        $events = [];
        foreach ($rows as ['a' => $a, 'at' => $at]) {
            $key = self::text($a['event_key'] ?? null) ?? '';
            $label = self::text($a['event'] ?? null) ?? $key;
            if (!in_array(Text::key($key), self::REMARK_EVENTS, true)) {
                $current = StatusMapper::noest($key !== '' ? $key : $label);
            }
            $events[] = new TrackingEvent(status: $current, label: $label, at: $at, raw: $this->raw($a));
        }

        return new TrackResult(new Parcel($tracking, $tracking, $current, self::NAME, $this->raw($info)), $events);
    }

    /**
     * GET /fees: the partner's grid, tarifs.delivery (home tarif, tarif_stopdesk) and
     * tarifs.return, keyed by wilaya. Wilayas without a row are not served.
     */
    public function getFees(FeeQuery|array $query): FeeQuote
    {
        $query = FeeQuery::from($query, self::NAME);
        $code = (int) $this->resolveWilayaCode($query->toWilayaId);

        $body = $this->send('GET', 'fees');
        $tarifs = is_array($body) && is_array($body['tarifs'] ?? null) ? $body['tarifs'] : null;
        if ($tarifs === null || !array_key_exists('delivery', $tarifs)) {
            throw ShippingError::providerError('Unexpected NOEST fees response', self::NAME, $this->raw($body));
        }
        $rowOf = static function (mixed $list) use ($code): ?array {
            foreach (self::entries($list) as $row) {
                if (is_array($row) && is_numeric($row['wilaya_id'] ?? null) && (int) $row['wilaya_id'] === $code) {
                    return $row;
                }
            }

            return null;
        };
        $positive = static function (mixed $value): int|float|null {
            $n = self::number($value);

            return $n !== null && $n > 0 ? $n : null;
        };

        $delivery = $rowOf($tarifs['delivery']);
        $home = $positive($delivery['tarif'] ?? null);
        $desk = $positive($delivery['tarif_stopdesk'] ?? null);
        $fee = $query->isStopDesk ? $desk : $home;
        if ($fee === null) {
            throw new ShippingError(
                ShippingError::NOT_FOUND,
                'No NOEST ' . ($query->isStopDesk ? 'stop-desk' : 'home') . " rate for wilaya $code",
                null,
                null,
                $this->raw($body),
                self::NAME,
            );
        }

        $returns = $rowOf($tarifs['return'] ?? null);
        $returnFee = self::number($query->isStopDesk ? ($returns['tarif_stopdesk'] ?? null) : ($returns['tarif'] ?? null));

        return new FeeQuote(deliveryFee: $fee, returnFee: $returnFee, stopDeskFee: $desk, raw: $this->raw($body));
    }

    /** GET /get/wilayas: active wilayas only (is_active = 1). */
    public function getWilayas(): array
    {
        if ($this->wilayas === null) {
            $body = $this->send('GET', 'get/wilayas');
            if (!is_array($body)) {
                throw ShippingError::providerError('Unexpected NOEST wilayas response', self::NAME, $this->raw($body));
            }
            $wilayas = [];
            foreach ($body as $w) {
                if (!is_array($w) || !is_numeric($w['code'] ?? null) || !self::isActive($w)) {
                    continue;
                }
                $id = (string) (int) $w['code'];
                $wilayas[] = new Location(id: $id, name: trim((string) ($w['nom'] ?? '')), parentId: null, code: $id, raw: $this->raw($w));
            }
            $this->wilayas = $wilayas;
        }

        return $this->wilayas;
    }

    /** GET /get/communes/{wilaya_id}: active communes, id = code = postal code. */
    public function getCommunes(string|int $wilayaId): array
    {
        return $this->communesOf($this->resolveWilayaCode($wilayaId));
    }

    /**
     * GET /desks (all NOEST stations, keyed "16B"), filtered by wilaya. The desk id is the
     * station code, sent back as station_code by createParcel(). With communeId, only
     * desks whose commune is that commune are kept (same spelling as get/communes).
     */
    public function getStopDesks(StopDeskQuery|array $query): array
    {
        $query = StopDeskQuery::from($query, self::NAME);
        $code = $this->resolveWilayaCode($query->wilayaId);
        $desks = array_filter($this->desks(), static fn (array $d) => $d['desk']->wilayaId === $code);
        if ($query->communeId !== null) {
            $commune = Text::key($this->resolveCommune($code, $query->communeId)->name);
            $desks = array_filter($desks, static fn (array $d) => $d['commune'] === $commune);
        }

        return array_values(array_column($desks, 'desk'));
    }

    public function listParcels(ParcelListQuery|array|null $query = null): ParcelListPage
    {
        throw ShippingError::notSupported('NOEST has no endpoint to list parcels', self::NAME);
    }

    /**
     * POST /delete/order. NOEST only deletes orders that are not validated yet; otherwise
     * it answers { success: false } and this throws VALIDATION_ERROR.
     */
    public function cancelParcel(string $trackingNumberOrId): void
    {
        $tracking = trim($trackingNumberOrId);
        if ($tracking === '') {
            throw ShippingError::validation('trackingNumberOrId is required', self::NAME, 'trackingNumberOrId');
        }

        try {
            $body = $this->send('POST', 'delete/order', ['user_guid' => $this->userGuid, 'tracking' => $tracking]);
        } catch (ShippingError $e) {
            // Unknown tracking: HTTP 422 with `tracking` as the only invalid field.
            $details = $e->details ?? [];
            if ($e->httpStatus === 422 && $details !== [] && array_filter($details, static fn ($d) => ($d['field'] ?? null) !== 'tracking') === []) {
                throw new ShippingError(ShippingError::NOT_FOUND, "Unknown NOEST tracking number: $tracking", 422, $details, $e->raw, self::NAME);
            }
            throw $e;
        }
        if (is_array($body) && ($body['success'] ?? null) === false) {
            throw new ShippingError(
                ShippingError::VALIDATION_ERROR,
                self::text($body['message'] ?? null)
                    ?? "NOEST order $tracking cannot be cancelled: it does not exist or has already been validated (only orders not yet validated can be deleted)",
                200,
                null,
                $this->raw($body),
                self::NAME,
            );
        }
    }

    /** Probes `GET get/wilayas` (bypasses cache). */
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
     * Laravel validation bag (`{ message, errors: { field: [messages] } }`) → [message, details].
     *
     * @return array{0: ?string, 1: ?array}
     */
    public static function parseError(int $status, mixed $body): array
    {
        if (!is_array($body)) {
            return HttpClient::defaultErrorParser($status, $body);
        }
        $details = self::collectDetails($body['errors'] ?? null);
        if ($details !== []) {
            return [implode('; ', array_column($details, 'message')), $details];
        }
        foreach (['message', 'error'] as $key) {
            if (is_scalar($body[$key] ?? null)) {
                return [(string) $body[$key], null];
            }
        }

        return [null, null];
    }

    // --- internals ---------------------------------------------------------------

    /** Every HTTP call goes through here so refineError() applies to all endpoints. */
    private function send(string $method, string $path, mixed $json = null): mixed
    {
        try {
            return $this->http->request($method, $path, [], $json);
        } catch (ShippingError $e) {
            throw self::refineError($e);
        }
    }

    /**
     * Re-classifies HTTP errors whose status alone is misleading: a business code in the
     * details (account_suspended → AUTH_FAILED) and an unknown partner (HTTP 404
     * { success: false }, wrong userGuid) → AUTH_FAILED.
     */
    private static function refineError(ShippingError $e): ShippingError
    {
        $code = null;
        $message = $e->getMessage();
        if ($e->httpStatus === 404 && is_array($e->raw) && ($e->raw['success'] ?? null) === false) {
            $code = ShippingError::AUTH_FAILED;
            $message = "NOEST partner not found (check userGuid): $message";
        } else {
            foreach ($e->details ?? [] as $detail) {
                $business = self::BUSINESS_ERRORS[$detail['code'] ?? ''] ?? null;
                if ($business !== null) {
                    $code = $business !== $e->code ? $business : null;
                    break;
                }
            }
        }
        if ($code === null) {
            return $e;
        }

        return new ShippingError($code, $message, $e->httpStatus, $e->details, $e->raw, self::NAME, $e, $e->retryAfter);
    }

    /** POST /valid/order — hands the order over to NOEST logistics. */
    private function validateOrder(string $tracking): void
    {
        try {
            $body = $this->send('POST', 'valid/order', ['user_guid' => $this->userGuid, 'tracking' => $tracking]);
            if (is_array($body) && ($body['success'] ?? null) === false) {
                throw $this->businessError($body, 200, 'NOEST refused to validate the order');
            }
        } catch (ShippingError $e) {
            throw new ShippingError(
                $e->code,
                "NOEST order $tracking was created but could not be validated: " . $e->getMessage(),
                $e->httpStatus,
                $e->details,
                $e->raw,
                self::NAME,
                $e,
                $e->retryAfter,
            );
        }
    }

    /** `{ success: false, ... }` (HTTP 200) → ShippingError. */
    private function businessError(array $body, int $httpStatus, string $fallback): ShippingError
    {
        $details = self::collectDetails($body['errors'] ?? null);
        $nativeCode = null;
        foreach (['code', 'error_code', 'error'] as $key) {
            $value = self::text($body[$key] ?? null);
            if ($value !== null && isset(self::BUSINESS_ERRORS[$value])) {
                $nativeCode = $value;
                break;
            }
        }
        foreach ($details as $detail) {
            $nativeCode ??= $detail['code'] ?? null;
        }
        $message = self::text($body['message'] ?? null)
            ?? ($details !== [] ? implode('; ', array_column($details, 'message')) : null)
            ?? (is_string($body['error'] ?? null) && $body['error'] !== '' ? $body['error'] : null)
            ?? $fallback;
        if ($details === []) {
            $details[] = $nativeCode !== null ? ['message' => $message, 'code' => $nativeCode] : ['message' => $message];
        }

        return new ShippingError(
            $nativeCode !== null ? self::BUSINESS_ERRORS[$nativeCode] : ShippingError::PROVIDER_ERROR,
            $message,
            $httpStatus,
            $details,
            $this->raw($body),
            self::NAME,
        );
    }

    /** @return list<array{field: string, message: string}> */
    private static function collectDetails(mixed $errors): array
    {
        $details = [];
        if (!is_array($errors) || array_is_list($errors)) {
            return $details;
        }
        foreach ($errors as $key => $value) {
            $key = (string) $key;
            foreach (is_array($value) ? $value : [$value] as $msg) {
                if (!is_string($msg)) {
                    continue;
                }
                // Keys that are business error codes become `code`, not `field`.
                $details[] = isset(self::BUSINESS_ERRORS[$key])
                    ? ['message' => $msg, 'code' => $key]
                    : ['field' => self::FIELDS[$key] ?? $key, 'message' => $msg];
            }
        }

        return $details;
    }

    /** Every station, with its normalized commune for the communeId filter. @return list<array{desk: StopDesk, commune: string}> */
    private function desks(): array
    {
        if ($this->desks === null) {
            $body = $this->send('GET', 'desks');
            if (!is_array($body)) {
                throw ShippingError::providerError('Unexpected NOEST desks response', self::NAME, $this->raw($body));
            }
            $desks = [];
            foreach ($body as $d) {
                $id = is_array($d) ? self::text($d['code'] ?? null) : null;
                if ($id === null || preg_match('/^(\d{1,2})/', $id, $m) !== 1) {
                    continue;
                }
                $phone = null;
                foreach (self::entries($d['phones'] ?? null) as $p) {
                    if (($phone = self::text($p)) !== null) {
                        break;
                    }
                }
                $desks[] = [
                    'desk' => new StopDesk(
                        id: $id,
                        name: self::text($d['name'] ?? null) ?? $id,
                        address: self::text($d['address'] ?? null),
                        wilayaId: (string) (int) $m[1],
                        phone: $phone,
                        openingHours: self::text($d['horaires'] ?? null),
                        raw: $this->raw($d),
                    ),
                    'commune' => Text::key((string) ($d['commune'] ?? '')),
                ];
            }
            $this->desks = $desks;
        }

        return $this->desks;
    }

    /** @return list<Location> */
    private function communesOf(string $wilayaCode): array
    {
        if (!isset($this->communes[$wilayaCode])) {
            $body = $this->send('GET', "get/communes/$wilayaCode");
            if (!is_array($body)) {
                throw ShippingError::providerError('Unexpected NOEST communes response', self::NAME, $this->raw($body));
            }
            $communes = [];
            foreach ($body as $c) {
                if (!is_array($c) || !self::hasValue($c['nom'] ?? null) || !self::isActive($c)) {
                    continue;
                }
                if (self::hasValue($c['wilaya_id'] ?? null) && (int) $c['wilaya_id'] !== (int) $wilayaCode) {
                    continue;
                }
                $name = trim((string) $c['nom']);
                $postal = self::text($c['code_postal'] ?? null);
                $communes[] = new Location(id: $postal ?? $name, name: $name, parentId: $wilayaCode, code: $postal, raw: $this->raw($c));
            }
            $this->communes[$wilayaCode] = $communes;
        }

        return $this->communes[$wilayaCode];
    }

    /** Official code 1–58 as-is (NOEST ids are the codes); names via get/wilayas. */
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

    private function resolveCommune(string $wilayaCode, string|int|null $ref): Location
    {
        $value = trim((string) $ref);
        $communes = $this->communesOf($wilayaCode);
        foreach ($communes as $c) {
            if ($c->id === $value) {
                return $c;
            }
        }
        foreach ($communes as $c) {
            if (Text::key($c->name) === Text::key($value)) {
                return $c;
            }
        }
        // Spelling-tolerant fallback ("Bab Ezzouar" → NOEST's "Bab Azzouar").
        $loose = Text::findLoosely($communes, $value, static fn (Location $c) => $c->name);
        if ($loose !== null) {
            return $loose;
        }

        throw ShippingError::notFound("Unknown commune: $value in wilaya $wilayaCode", self::NAME);
    }

    private static function isActive(array $row): bool
    {
        return !self::hasValue($row['is_active'] ?? null) || (int) $row['is_active'] === 1;
    }

    /** Values of a JSON list or of a keyed object. @return list<mixed> */
    private static function entries(mixed $value): array
    {
        return is_array($value) ? array_values($value) : [];
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
