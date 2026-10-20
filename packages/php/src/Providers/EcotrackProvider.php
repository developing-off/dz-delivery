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
 * Ecotrack — one provider for every courier running on the Ecotrack platform
 * (DHD, Conexlog, Anderson, World Express, MSM Go, Packers, ...), each on its own host.
 * Mapping and assumptions: docs/PROVIDERS.md#ecotrack.
 *
 * Options: 'token', exactly one of 'baseUrl' (tenant URL, https) or 'courier'
 * (built-in key, see COURIERS), and 'autoValidate' (default false: orders stay
 * pending until validated from the courier's dashboard).
 */
final class EcotrackProvider implements ShippingProviderInterface
{
    public const NAME = 'ecotrack';

    /** Built-in tenant hosts for 'courier' => '<key>'. Same table as the TS provider. */
    public const COURIERS = [
        'dhd' => 'https://platform.dhd-dz.com',
        'conexlog' => 'https://app.conexlog-dz.com',
        'andersondelivery' => 'https://andersondelivery.ecotrack.dz',
        'msmgo' => 'https://msmgo.ecotrack.dz',
        'packers' => 'https://packers.ecotrack.dz',
        'rocketdelivery' => 'https://rocketdelivery.ecotrack.dz',
        'worldexpress' => 'https://worldexpress.ecotrack.dz',
    ];

    private const API_PREFIX = '/api/v1';
    private const TIMEZONE = 'Africa/Algiers';
    private const ORDER_TYPE_DELIVERY = 1;
    private const NOTIFICATION = 'notification_on_order';

    /** Business error code → [unified code, message, ParcelInput field]. Same table as the TS provider. */
    private const BUSINESS_ERRORS = [
        10001 => [ShippingError::VALIDATION_ERROR, 'Order can no longer be modified (already validated)', null],
        10002 => [ShippingError::VALIDATION_ERROR, 'No delivery to the selected wilaya', 'wilayaId'],
        10003 => [ShippingError::VALIDATION_ERROR, 'A return cannot be requested for this order', null],
    ];

    private HttpClient $http;
    private bool $includeRaw;
    private bool $autoValidate;

    /** @var Location[]|null */
    private ?array $wilayas = null;

    /** @var array<string, list<array{location: Location, stopDesk: bool}>> keyed by wilaya code */
    private array $communes = [];

    public function __construct(ClientOptions $options, ?HttpClient $http = null)
    {
        $token = (string) preg_replace('/^bearer\s+/i', '', trim((string) $options->get('token', '')));
        if ($token === '') {
            throw new ShippingError(ShippingError::AUTH_FAILED, 'Ecotrack requires "token"', null, null, null, self::NAME);
        }
        $tenant = self::resolveBaseUrl($options->baseUrl, $options->get('courier'));

        $this->includeRaw = $options->includeRaw;
        $this->autoValidate = (bool) $options->get('autoValidate', false);
        $this->http = $http ?? new HttpClient(
            baseUrl: $tenant . self::API_PREFIX,
            provider: self::NAME,
            headers: ['Authorization' => 'Bearer ' . $token],
            timeoutMs: $options->timeoutMs,
            includeRaw: $options->includeRaw,
            handler: is_callable($options->handler) ? $options->handler : null,
            errorParser: [self::class, 'parseError'],
        );
    }

    /**
     * Tenant host from 'baseUrl' or 'courier' (exactly one). Only https URLs are accepted;
     * a trailing /api/v1 is stripped. Throws VALIDATION_ERROR.
     */
    public static function resolveBaseUrl(?string $baseUrl, mixed $courier): string
    {
        $baseUrl = trim((string) $baseUrl);
        $courier = strtolower(trim((string) $courier));
        if (($baseUrl === '') === ($courier === '')) {
            throw new ShippingError(
                ShippingError::VALIDATION_ERROR,
                'Ecotrack requires exactly one of "baseUrl" (tenant URL) or "courier"',
                null,
                [['field' => 'baseUrl', 'message' => 'Exactly one of baseUrl / courier is required']],
                null,
                self::NAME,
            );
        }
        if ($courier !== '') {
            if (!isset(self::COURIERS[$courier])) {
                throw new ShippingError(
                    ShippingError::VALIDATION_ERROR,
                    "Unknown Ecotrack courier \"$courier\". Known: " . implode(', ', array_keys(self::COURIERS))
                        . '; pass the tenant URL as "baseUrl" instead',
                    null,
                    [['field' => 'courier', 'message' => "Unknown Ecotrack courier \"$courier\""]],
                    null,
                    self::NAME,
                );
            }

            return self::COURIERS[$courier];
        }

        $parts = parse_url($baseUrl);
        if (
            !is_array($parts) || strtolower($parts['scheme'] ?? '') !== 'https' || ($parts['host'] ?? '') === ''
            || isset($parts['user']) || isset($parts['pass'])
        ) {
            throw new ShippingError(
                ShippingError::VALIDATION_ERROR,
                "Ecotrack baseUrl must be an https URL, got \"$baseUrl\"",
                null,
                [['field' => 'baseUrl', 'message' => 'baseUrl must be an https URL']],
                null,
                self::NAME,
            );
        }
        $port = isset($parts['port']) && $parts['port'] !== 443 ? ':' . $parts['port'] : '';
        $path = (string) preg_replace('#/api/v1$#i', '', rtrim($parts['path'] ?? '', '/'));

        return 'https://' . strtolower($parts['host']) . $port . $path;
    }

    public function getName(): string
    {
        return self::NAME;
    }

    /**
     * POST /create/order with query parameters. The commune is resolved to the tenant's
     * spelling through get/communes. With autoValidate, POST /valid/order follows.
     */
    public function createParcel(ParcelInput|array $input): Parcel
    {
        $input = ParcelInput::from($input, self::NAME);
        $phone = Phone::toLocal($input->phone, self::NAME, 'phone');
        $phone2 = $input->phone2 !== null ? Phone::toLocal($input->phone2, self::NAME, 'phone2') : null;

        $wilayaCode = $this->resolveWilayaCode($input->wilayaId ?? $input->wilayaName);
        $commune = $this->resolveCommune($wilayaCode, $input->communeId ?? $input->communeName);

        $query = [
            'nom_client' => trim($input->recipientName),
            'telephone' => $phone,
            'adresse' => trim($input->address),
            'code_wilaya' => (int) $wilayaCode,
            'commune' => $commune->name,
            // montant includes the delivery fee: it is exactly what the recipient pays.
            'montant' => (int) round($input->price),
            'produit' => trim($input->productDescription()),
            'type' => self::ORDER_TYPE_DELIVERY,
            'stop_desk' => $input->isStopDesk ? 1 : 0,
        ];
        if ($phone2 !== null) {
            $query['telephone_2'] = $phone2;
        }
        if ($input->isStopDesk) {
            $query['code_postal'] = trim((string) $input->stopDeskId);
        }
        if ($input->weight !== null) {
            $query['weight'] = $input->weight;
        }
        if ($input->remark !== null && trim($input->remark) !== '') {
            $query['remarque'] = trim($input->remark);
        }
        if ($input->orderId !== null && trim($input->orderId) !== '') {
            $query['reference'] = trim($input->orderId);
        }

        $body = $this->http->request('POST', 'create/order', $query);
        if (is_array($body) && ($body['success'] ?? null) === false) {
            throw $this->businessError($body, 200);
        }
        if (!is_array($body) || !self::hasValue($body['tracking'] ?? null)) {
            throw ShippingError::providerError('Ecotrack did not return a tracking number', self::NAME, $this->raw($body));
        }

        $tracking = trim((string) $body['tracking']);
        $status = ParcelStatus::PENDING;
        if ($this->autoValidate) {
            $this->validateOrder($tracking);
            $status = ParcelStatus::CREATED;
        }

        return new Parcel($tracking, $tracking, $status, self::NAME, $this->raw($body));
    }

    /**
     * GET /get/tracking/info?tracking=. Only the entry for this exact tracking number is
     * used. notification_on_order (a remark) keeps the previous status; no activity yet
     * means the order is not validated (pending).
     */
    public function track(string $trackingNumber): TrackResult
    {
        $tracking = trim($trackingNumber);
        if ($tracking === '') {
            throw ShippingError::validation('trackingNumber is required', self::NAME, 'trackingNumber');
        }

        try {
            $body = $this->http->request('GET', 'get/tracking/info', ['tracking' => $tracking]);
        } catch (ShippingError $e) {
            throw self::asTrackingNotFound($e, $tracking);
        }
        $info = $this->pickTrackingInfo($body, $tracking);

        $rows = [];
        foreach (self::entries($info['activity'] ?? null) as $a) {
            if (!is_array($a) || array_is_list($a)) {
                continue;
            }
            if (self::hasValue($a['tracking'] ?? null) && trim((string) $a['tracking']) !== $tracking) {
                continue;
            }
            $date = trim((string) ($a['date'] ?? ''));
            $time = trim((string) ($a['time'] ?? ''));
            $value = $date !== '' && preg_match('/[T ]\d/', $date) !== 1 ? $date . ' ' . ($time !== '' ? $time : '00:00:00') : $date;
            $rows[] = ['a' => $a, 'at' => Dates::toIso($value, self::TIMEZONE)];
        }
        usort($rows, static fn (array $x, array $y) => strcmp($x['at'], $y['at']));

        $current = ParcelStatus::PENDING;
        $events = [];
        foreach ($rows as ['a' => $a, 'at' => $at]) {
            $key = trim((string) ($a['status'] ?? ''));
            if ($key !== self::NOTIFICATION) {
                $current = StatusMapper::ecotrack($key);
            }
            $label = self::hasValue($a['reason'] ?? null) ? $key . ' (' . trim((string) $a['reason']) . ')' : $key;
            $events[] = new TrackingEvent(status: $current, label: $label, at: $at, raw: $this->raw($a));
        }

        return new TrackResult(new Parcel($tracking, $tracking, $current, self::NAME, $this->raw($info)), $events);
    }

    /**
     * GET /get/fees: per-wilaya livraison (home tarif, tarif_stopdesk) and retours rows
     * for the account. A 0 delivery price means the mode is not offered.
     */
    public function getFees(FeeQuery|array $query): FeeQuote
    {
        $query = FeeQuery::from($query, self::NAME);
        $code = (int) $this->resolveWilayaCode($query->toWilayaId);

        $body = $this->http->request('GET', 'get/fees');
        if (!is_array($body) || !array_key_exists('livraison', $body)) {
            throw ShippingError::providerError('Unexpected Ecotrack fees response', self::NAME, $this->raw($body));
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

        $delivery = $rowOf($body['livraison']);
        $home = $positive($delivery['tarif'] ?? null);
        $desk = $positive($delivery['tarif_stopdesk'] ?? null);
        $fee = $query->isStopDesk ? $desk : $home;
        if ($fee === null) {
            throw new ShippingError(
                ShippingError::NOT_FOUND,
                'No Ecotrack ' . ($query->isStopDesk ? 'stop-desk' : 'home') . " rate for wilaya $code",
                null,
                null,
                $this->raw($body),
                self::NAME,
            );
        }

        $returns = $rowOf($body['retours'] ?? $body['retour'] ?? null);
        $returnFee = self::number($query->isStopDesk ? ($returns['tarif_stopdesk'] ?? null) : ($returns['tarif'] ?? null));

        return new FeeQuote(deliveryFee: $fee, returnFee: $returnFee, stopDeskFee: $desk, raw: $this->raw($body));
    }

    /** GET /get/wilayas: only the wilayas this tenant delivers to. */
    public function getWilayas(): array
    {
        if ($this->wilayas === null) {
            $body = $this->http->request('GET', 'get/wilayas');
            $items = is_array($body) && !array_is_list($body) && array_key_exists('data', $body) ? $body['data'] : $body;
            if (!is_array($items)) {
                throw ShippingError::providerError('Unexpected Ecotrack wilayas response', self::NAME, $this->raw($body));
            }
            $wilayas = [];
            foreach ($items as $w) {
                if (!is_array($w) || !self::hasValue($w['wilaya_id'] ?? null)) {
                    continue;
                }
                $id = trim((string) $w['wilaya_id']);
                $wilayas[] = new Location(id: $id, name: (string) ($w['wilaya_name'] ?? ''), parentId: null, code: $id, raw: $this->raw($w));
            }
            $this->wilayas = $wilayas;
        }

        return $this->wilayas;
    }

    /** GET /get/communes?wilaya_id= (an index-keyed object, not a list). */
    public function getCommunes(string|int $wilayaId): array
    {
        return array_column($this->communesOf($this->resolveWilayaCode($wilayaId)), 'location');
    }

    /**
     * Communes flagged has_stop_desk = 1. The desk id is the commune's code_postal
     * (Ecotrack "station code"), sent back as code_postal by createParcel().
     */
    public function getStopDesks(StopDeskQuery|array $query): array
    {
        $query = StopDeskQuery::from($query, self::NAME);
        $code = $this->resolveWilayaCode($query->wilayaId);
        $communes = $this->communesOf($code);
        if ($query->communeId !== null) {
            $commune = $this->resolveCommune($code, $query->communeId);
            $communes = array_filter($communes, static fn (array $c) => $c['location']->id === $commune->id);
        }

        $desks = [];
        foreach ($communes as ['location' => $location, 'stopDesk' => $stopDesk]) {
            if ($stopDesk && $location->code !== null) {
                $desks[] = new StopDesk(
                    id: $location->code,
                    name: $location->name,
                    communeId: $location->id,
                    wilayaId: $code,
                    raw: $location->raw,
                );
            }
        }

        return $desks;
    }

    /**
     * DELETE /delete/order?tracking=. Ecotrack only deletes orders that are not validated
     * yet; afterwards (error 10001) this throws VALIDATION_ERROR.
     */
    public function cancelParcel(string $trackingNumberOrId): void
    {
        $tracking = trim($trackingNumberOrId);
        if ($tracking === '') {
            throw ShippingError::validation('trackingNumberOrId is required', self::NAME, 'trackingNumberOrId');
        }

        try {
            $body = $this->http->request('DELETE', 'delete/order', ['tracking' => $tracking]);
        } catch (ShippingError $e) {
            throw self::asTrackingNotFound($e, $tracking);
        }
        if (is_array($body) && ($body['success'] ?? null) === false) {
            $error = $this->businessError($body, 200);
            if (($error->details[0]['code'] ?? null) === '10001') {
                throw new ShippingError(
                    ShippingError::VALIDATION_ERROR,
                    "Ecotrack order $tracking cannot be cancelled: it has already been validated (only orders not yet validated can be deleted)",
                    200,
                    $error->details,
                    $this->raw($body),
                    self::NAME,
                );
            }
            throw $error;
        }
        if (is_array($body) && ($body['delete'] ?? null) === 'fail') {
            throw new ShippingError(
                ShippingError::VALIDATION_ERROR,
                "Ecotrack refused to delete order $tracking (already validated?)",
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
        $details = [];
        if (is_array($body['errors'] ?? null) && !array_is_list($body['errors'])) {
            foreach ($body['errors'] as $field => $value) {
                foreach (is_array($value) ? $value : [$value] as $msg) {
                    if (is_string($msg)) {
                        $details[] = ['field' => (string) $field, 'message' => $msg];
                    }
                }
            }
        }
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

    /** POST /valid/order?tracking= — hands the order over to the courier. */
    private function validateOrder(string $tracking): void
    {
        try {
            $body = $this->http->request('POST', 'valid/order', ['tracking' => $tracking]);
            if (is_array($body) && ($body['success'] ?? null) === false) {
                throw $this->businessError($body, 200);
            }
        } catch (ShippingError $e) {
            throw new ShippingError(
                $e->code,
                "Ecotrack order $tracking was created but could not be validated: " . $e->getMessage(),
                $e->httpStatus,
                $e->details,
                $e->raw,
                self::NAME,
                $e,
                $e->retryAfter,
            );
        }
    }

    /** `{ success: false, error, message }` (HTTP 200) → ShippingError. */
    private function businessError(array $body, int $httpStatus): ShippingError
    {
        $error = $body['error'] ?? null;
        $nativeCode = self::hasValue($error) && ctype_digit(trim((string) $error)) ? (int) $error : null;
        $known = $nativeCode !== null ? (self::BUSINESS_ERRORS[$nativeCode] ?? null) : null;

        $message = self::hasValue($body['message'] ?? null) ? (string) $body['message'] : '';
        if ($message === '') {
            $message = $known[1] ?? (is_string($error) && $error !== '' ? $error : 'Ecotrack rejected the request');
        }
        $detail = [];
        if (($known[2] ?? null) !== null) {
            $detail['field'] = $known[2];
        }
        $detail['message'] = $message;
        if ($nativeCode !== null) {
            $detail['code'] = (string) $nativeCode;
        }

        return new ShippingError($known[0] ?? ShippingError::PROVIDER_ERROR, $message, $httpStatus, [$detail], $this->raw($body), self::NAME);
    }

    /** A 422 whose only invalid field is `tracking` means the tracking number does not exist. */
    private static function asTrackingNotFound(ShippingError $e, string $tracking): ShippingError
    {
        $details = $e->details ?? [];
        if ($e->httpStatus !== 422 || $details === [] || array_filter($details, static fn ($d) => ($d['field'] ?? null) !== 'tracking') !== []) {
            return $e;
        }

        return new ShippingError(ShippingError::NOT_FOUND, "Unknown Ecotrack tracking number: $tracking", 422, $details, $e->raw, self::NAME);
    }

    /**
     * The tracking info object for exactly $tracking. Tolerates list-style answers and
     * objects keyed by tracking number; never takes "the first row" of a list.
     *
     * @return array<string, mixed>
     */
    private function pickTrackingInfo(mixed $body, string $tracking): array
    {
        $notFound = fn () => new ShippingError(ShippingError::NOT_FOUND, "Unknown Ecotrack tracking number: $tracking", null, null, $this->raw($body), self::NAME);
        $root = is_array($body) && !array_is_list($body) && array_key_exists('data', $body) && !array_key_exists('activity', $body)
            ? $body['data']
            : $body;
        if (!is_array($root)) {
            throw ShippingError::providerError('Unexpected Ecotrack tracking response', self::NAME, $this->raw($body));
        }
        if (array_is_list($root)) {
            foreach ($root as $row) {
                if (is_array($row) && self::hasValue($row['tracking'] ?? null) && trim((string) $row['tracking']) === $tracking) {
                    return $row;
                }
            }
            throw $notFound();
        }
        if (!array_key_exists('activity', $root)) {
            if (is_array($root[$tracking] ?? null) && !array_is_list($root[$tracking])) {
                return $root[$tracking];
            }
            throw $notFound();
        }
        if (self::hasValue($root['tracking'] ?? null) && trim((string) $root['tracking']) !== $tracking) {
            throw $notFound();
        }

        return $root;
    }

    /** @return list<array{location: Location, stopDesk: bool}> */
    private function communesOf(string $wilayaCode): array
    {
        if (!isset($this->communes[$wilayaCode])) {
            $body = $this->http->request('GET', 'get/communes', ['wilaya_id' => $wilayaCode]);
            if (!is_array($body)) {
                throw ShippingError::providerError('Unexpected Ecotrack communes response', self::NAME, $this->raw($body));
            }
            $communes = [];
            foreach ($body as $c) {
                if (!is_array($c) || !self::hasValue($c['nom'] ?? null)) {
                    continue;
                }
                if (self::hasValue($c['wilaya_id'] ?? null) && (int) $c['wilaya_id'] !== (int) $wilayaCode) {
                    continue;
                }
                $name = trim((string) $c['nom']);
                $postal = self::hasValue($c['code_postal'] ?? null) ? trim((string) $c['code_postal']) : null;
                $communes[] = [
                    'location' => new Location(id: $postal ?? $name, name: $name, parentId: $wilayaCode, code: $postal, raw: $this->raw($c)),
                    'stopDesk' => (int) ($c['has_stop_desk'] ?? 0) === 1,
                ];
            }
            $this->communes[$wilayaCode] = $communes;
        }

        return $this->communes[$wilayaCode];
    }

    /** Official code 1–58 as-is (Ecotrack ids are the codes); names via get/wilayas. */
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
        $communes = array_column($this->communesOf($wilayaCode), 'location');
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

        throw ShippingError::notFound("Unknown commune: $value in wilaya $wilayaCode", self::NAME);
    }

    /** Values of a JSON list or of an index-keyed object. @return list<mixed> */
    private static function entries(mixed $value): array
    {
        return is_array($value) ? array_values($value) : [];
    }

    private static function hasValue(mixed $value): bool
    {
        return is_scalar($value) && trim((string) $value) !== '';
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
