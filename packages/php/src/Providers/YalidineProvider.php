<?php

declare(strict_types=1);

namespace DzDelivery\Providers;

use DzDelivery\Contracts\ShippingProviderInterface;
use DzDelivery\Errors\ShippingError;
use DzDelivery\Http\HttpClient;
use DzDelivery\Models\ClientOptions;
use DzDelivery\Models\FeeQuery;
use DzDelivery\Models\FeeQuote;
use DzDelivery\Models\Location;
use DzDelivery\Models\Parcel;
use DzDelivery\Models\ParcelInput;
use DzDelivery\Models\ParcelStatus;
use DzDelivery\Models\StopDesk;
use DzDelivery\Models\StopDeskQuery;
use DzDelivery\Models\TrackingEvent;
use DzDelivery\Models\TrackResult;
use DzDelivery\Support\Dates;
use DzDelivery\Support\Phone;
use DzDelivery\Support\StatusMapper;
use DzDelivery\Support\Text;

/**
 * Yalidine (https://api.yalidine.app/v1/). Mapping: docs/PROVIDERS.md#yalidine.
 *
 * Extra config keys: `fromWilayaId` or `fromWilayaName` (origin wilaya, required
 * by Yalidine to create parcels and quote fees).
 */
final class YalidineProvider implements ShippingProviderInterface
{
    public const NAME = 'yalidine';
    public const DEFAULT_BASE_URL = 'https://api.yalidine.app/v1/';

    private const TIMEZONE = 'Africa/Algiers';
    private const MAX_PAGES = 50;
    /** Largest `page_size` accepted by list endpoints (saves quota: 50 requests/minute). */
    private const PAGE_SIZE = 1000;
    private const FREE_WEIGHT_KG = 5;
    /** Volumetric weight (kg) = length × width × height (cm) × this factor. */
    private const VOLUMETRIC_FACTOR = 0.0002;

    private HttpClient $http;
    private bool $includeRaw;
    private string|int|null $fromWilayaId;
    private ?string $fromWilayaName;

    /** @var Location[]|null */
    private ?array $wilayas = null;

    /** @var array<string, Location[]> keyed by wilaya id */
    private array $communes = [];

    public function __construct(ClientOptions $options, ?HttpClient $http = null)
    {
        $apiId = (string) $options->get('apiId', '');
        $apiToken = (string) $options->get('apiToken', '');
        if ($apiId === '' || $apiToken === '') {
            throw new ShippingError(ShippingError::AUTH_FAILED, 'Yalidine requires "apiId" and "apiToken"', null, null, null, self::NAME);
        }

        $this->includeRaw = $options->includeRaw;
        $this->fromWilayaId = $options->get('fromWilayaId');
        $this->fromWilayaName = $options->get('fromWilayaName');
        $this->http = $http ?? new HttpClient(
            baseUrl: $options->baseUrl ?? self::DEFAULT_BASE_URL,
            provider: self::NAME,
            headers: [
                'X-API-ID' => $apiId,
                'X-API-TOKEN' => $apiToken,
                'Content-Type' => 'application/json',
            ],
            timeoutMs: $options->timeoutMs,
            includeRaw: $options->includeRaw,
            handler: is_callable($options->handler) ? $options->handler : null,
        );
    }

    public function getName(): string
    {
        return self::NAME;
    }

    public function createParcel(ParcelInput|array $input): Parcel
    {
        $input = ParcelInput::from($input, self::NAME);

        $wilaya = $this->findWilaya($input->wilayaId ?? $input->wilayaName, $input->wilayaId === null);
        $commune = $this->findCommune($wilaya, $input->communeId ?? $input->communeName, $input->communeId === null);
        $fromWilayaName = $this->originWilayaName();

        $phones = [Phone::toLocal($input->phone, self::NAME, 'phone')];
        if ($input->phone2 !== null) {
            $phones[] = Phone::toLocal($input->phone2, self::NAME, 'phone2');
        }

        $nameParts = preg_split('/\s+/', trim($input->recipientName), 2) ?: [$input->recipientName];
        $orderId = $input->orderId ?? 'dzd-' . bin2hex(random_bytes(6));

        $parcel = array_filter([
            'order_id' => $orderId,
            'from_wilaya_name' => $fromWilayaName,
            'firstname' => $nameParts[0],
            'familyname' => $nameParts[1] ?? $nameParts[0],
            'contact_phone' => implode(',', $phones),
            'address' => $input->address,
            'to_commune_name' => $commune->name,
            'to_wilaya_name' => $wilaya->name,
            'product_list' => $input->productDescription(),
            'price' => $input->price,
            'do_insurance' => false,
            'declared_value' => $input->price,
            // Required integers: missing → 0, decimals rounded up.
            'length' => self::intOrZero($input->length),
            'width' => self::intOrZero($input->width),
            'height' => self::intOrZero($input->height),
            'weight' => self::intOrZero($input->weight),
            'freeshipping' => true,
            'is_stopdesk' => $input->isStopDesk,
            'stopdesk_id' => $input->isStopDesk && ctype_digit((string) $input->stopDeskId) ? (int) $input->stopDeskId : $input->stopDeskId,
            'has_exchange' => false,
        ], static fn ($v) => $v !== null);

        $response = $this->http->request('POST', 'parcels/', [], [$parcel]);

        $result = null;
        if (is_array($response)) {
            $result = $response[$orderId] ?? (array_is_list($response) ? ($response[0] ?? null) : (reset($response) ?: null));
        }
        if (!is_array($result)) {
            throw ShippingError::providerError('Unexpected Yalidine create response', self::NAME, $this->raw($response));
        }
        if (($result['success'] ?? false) !== true || empty($result['tracking'])) {
            throw new ShippingError(
                ShippingError::VALIDATION_ERROR,
                (string) ($result['message'] ?? 'Yalidine rejected the parcel'),
                null,
                [['message' => (string) ($result['message'] ?? 'Yalidine rejected the parcel')]],
                $this->raw($response),
                self::NAME,
            );
        }

        $tracking = (string) $result['tracking'];

        return new Parcel($tracking, $tracking, ParcelStatus::PENDING, self::NAME, $this->raw($result));
    }

    public function track(string $trackingNumber): TrackResult
    {
        $native = $this->fetchParcel($trackingNumber);
        $parcel = $this->toParcel($native);

        $history = $this->http->request('GET', 'histories/' . rawurlencode($parcel->trackingNumber), ['page_size' => self::PAGE_SIZE]);
        $events = [];
        foreach (self::dataItems($history) as $item) {
            if (!is_array($item)) {
                continue;
            }
            $label = (string) ($item['status'] ?? '');
            if (!empty($item['reason'])) {
                $label .= ' (' . $item['reason'] . ')';
            }
            $events[] = new TrackingEvent(
                status: StatusMapper::yalidine($item['status'] ?? null),
                label: $label,
                at: Dates::toIso($item['date_status'] ?? null, self::TIMEZONE),
                raw: $this->raw($item),
            );
        }
        usort($events, static fn (TrackingEvent $a, TrackingEvent $b) => strtotime($a->at) <=> strtotime($b->at));

        return new TrackResult($parcel, $events);
    }

    public function getFees(FeeQuery|array $query): FeeQuote
    {
        $query = FeeQuery::from($query, self::NAME);
        $to = $this->wilayaByRef($query->toWilayaId);
        $from = $query->fromWilayaId !== null
            ? $this->wilayaByRef($query->fromWilayaId)
            : $this->originWilaya();

        $native = $this->http->request('GET', 'fees/', ['from_wilaya_id' => $from->id, 'to_wilaya_id' => $to->id]);
        if (!is_array($native)) {
            throw ShippingError::providerError('Unexpected Yalidine fees response', self::NAME, $this->raw($native));
        }

        $perCommune = is_array($native['per_commune'] ?? null) ? $native['per_commune'] : [];
        $entry = null;
        if ($query->toCommuneId !== null) {
            $entry = $perCommune[(string) $query->toCommuneId] ?? null;
            if ($entry === null) {
                foreach ($perCommune as $candidate) {
                    if (is_array($candidate) && (string) ($candidate['commune_id'] ?? '') === (string) $query->toCommuneId) {
                        $entry = $candidate;
                        break;
                    }
                }
            }
        } else {
            $first = reset($perCommune);
            $entry = $first === false ? null : $first;
        }
        if (!is_array($entry)) {
            throw new ShippingError(ShippingError::NOT_FOUND, 'No Yalidine rate for this destination', null, null, $this->raw($native), self::NAME);
        }

        $home = self::number($entry['express_home'] ?? null);
        $desk = self::number($entry['express_desk'] ?? $entry['express_stopdesk'] ?? null);
        $fee = $query->isStopDesk ? $desk : $home;
        if ($fee === null) {
            throw new ShippingError(ShippingError::NOT_FOUND, 'No Yalidine rate for this delivery type', null, null, $this->raw($native), self::NAME);
        }

        $oversize = self::number($native['oversize_fee'] ?? null);
        $weight = self::billableWeight($query);
        if ($weight !== null && $oversize !== null && $weight > self::FREE_WEIGHT_KG) {
            // (billable weight − 5) × oversize_fee, float noise removed, rounded up to the dinar.
            $extra = (int) ceil(round(($weight - self::FREE_WEIGHT_KG) * $oversize, 6));
            $fee += $extra;
            $desk = $desk !== null ? $desk + $extra : null;
        }

        return new FeeQuote(
            deliveryFee: $fee,
            returnFee: self::number($native['retour_fee'] ?? null),
            stopDeskFee: $desk,
            raw: $this->raw($native),
        );
    }

    public function getWilayas(): array
    {
        if ($this->wilayas === null) {
            $this->wilayas = [];
            foreach ($this->paginate('wilayas/') as $w) {
                if (array_key_exists('is_deliverable', $w) && !$w['is_deliverable']) {
                    continue;
                }
                $this->wilayas[] = new Location(
                    id: (string) $w['id'],
                    name: (string) ($w['name'] ?? ''),
                    parentId: null,
                    code: (string) $w['id'],
                    raw: $this->raw($w),
                );
            }
        }

        return $this->wilayas;
    }

    public function getCommunes(string|int $wilayaId): array
    {
        $wilaya = $this->findWilaya($wilayaId, !ctype_digit(trim((string) $wilayaId)));

        return $this->communesOf($wilaya->id);
    }

    /** `GET centers/?wilaya_id=[&commune_id=]`; a center's `center_id` is Yalidine's `stopdesk_id`. */
    public function getStopDesks(StopDeskQuery|array $query): array
    {
        $query = StopDeskQuery::from($query, self::NAME);
        $wilaya = $this->findWilaya($query->wilayaId, !ctype_digit(trim((string) $query->wilayaId)));
        $filter = ['wilaya_id' => $wilaya->id];
        if ($query->communeId !== null) {
            $filter['commune_id'] = $this->findCommune($wilaya, $query->communeId, !ctype_digit(trim((string) $query->communeId)))->id;
        }

        $desks = [];
        foreach ($this->paginate('centers/', $filter, 'center_id') as $c) {
            $desks[] = new StopDesk(
                id: (string) $c['center_id'],
                name: (string) ($c['name'] ?? ''),
                address: ($c['address'] ?? '') !== '' ? (string) $c['address'] : null,
                communeId: isset($c['commune_id']) ? (string) $c['commune_id'] : null,
                wilayaId: isset($c['wilaya_id']) ? (string) $c['wilaya_id'] : $wilaya->id,
                raw: $this->raw($c),
            );
        }

        return $desks;
    }

    public function cancelParcel(string $trackingNumberOrId): void
    {
        $response = $this->http->request('DELETE', 'parcels/' . rawurlencode($trackingNumberOrId));

        $result = is_array($response) && array_is_list($response) ? ($response[0] ?? null) : $response;
        if (is_array($result) && array_key_exists('deleted', $result) && !$result['deleted']) {
            throw new ShippingError(
                ShippingError::VALIDATION_ERROR,
                'Yalidine refused to delete the parcel (only parcels "En préparation" can be deleted)',
                null,
                null,
                $this->raw($response),
                self::NAME,
            );
        }
    }

    /** @return array<string, mixed> */
    private function fetchParcel(string $tracking): array
    {
        $response = $this->http->request('GET', 'parcels/' . rawurlencode($tracking));
        $items = self::dataItems($response);
        $parcel = $items[0] ?? (is_array($response) && isset($response['tracking']) ? $response : null);
        if (!is_array($parcel)) {
            throw new ShippingError(ShippingError::NOT_FOUND, "Parcel not found: $tracking", 404, null, $this->raw($response), self::NAME);
        }

        return $parcel;
    }

    /** @param array<string, mixed> $native */
    private function toParcel(array $native): Parcel
    {
        $tracking = (string) ($native['tracking'] ?? '');

        return new Parcel(
            id: $tracking,
            trackingNumber: $tracking,
            status: StatusMapper::yalidine($native['last_status'] ?? null),
            provider: self::NAME,
            raw: $this->raw($native),
        );
    }

    /** @return Location[] */
    private function communesOf(string $wilayaId): array
    {
        if (!isset($this->communes[$wilayaId])) {
            $this->communes[$wilayaId] = [];
            foreach ($this->paginate('communes/', ['wilaya_id' => $wilayaId]) as $c) {
                if (array_key_exists('is_deliverable', $c) && !$c['is_deliverable']) {
                    continue;
                }
                $this->communes[$wilayaId][] = new Location(
                    id: (string) $c['id'],
                    name: (string) ($c['name'] ?? ''),
                    parentId: (string) ($c['wilaya_id'] ?? $wilayaId),
                    code: null,
                    raw: $this->raw($c),
                );
            }
        }

        return $this->communes[$wilayaId];
    }

    /**
     * @param array<string, mixed> $query
     * @return list<array<string, mixed>>
     */
    private function paginate(string $path, array $query = [], string $idKey = 'id'): array
    {
        $all = [];
        $page = 1;
        do {
            $response = $this->http->request('GET', $path, $query + ['page' => $page, 'page_size' => self::PAGE_SIZE]);
            foreach (self::dataItems($response) as $item) {
                if (is_array($item) && isset($item[$idKey])) {
                    $all[] = $item;
                }
            }
            $hasMore = is_array($response) && !empty($response['has_more']);
            $page++;
        } while ($hasMore && $page <= self::MAX_PAGES);

        return $all;
    }

    /** Wilaya by id/code (1–58) or by name. */
    private function findWilaya(string|int|null $value, bool $byName): Location
    {
        $value = trim((string) $value);
        foreach ($this->getWilayas() as $w) {
            if ($byName ? Text::key($w->name) === Text::key($value) : ($w->id === $value || (ctype_digit($value) && (int) $w->id === (int) $value))) {
                return $w;
            }
        }

        throw ShippingError::notFound(($byName ? 'Unknown wilaya name: ' : 'Unknown wilaya: ') . $value, self::NAME);
    }

    /** Wilaya by id / code (digits) or by name, like the TS `resolveWilaya`. */
    private function wilayaByRef(string|int $value): Location
    {
        return $this->findWilaya($value, !ctype_digit(trim((string) $value)));
    }

    private function findCommune(Location $wilaya, string|int|null $value, bool $byName): Location
    {
        $value = trim((string) $value);
        foreach ($this->communesOf($wilaya->id) as $c) {
            if ($byName ? Text::key($c->name) === Text::key($value) : $c->id === $value) {
                return $c;
            }
        }

        throw ShippingError::notFound(
            ($byName ? 'Unknown commune name: ' : 'Unknown commune: ') . $value . ' in wilaya ' . $wilaya->name,
            self::NAME,
        );
    }

    private function originWilaya(): Location
    {
        if ($this->fromWilayaId !== null && $this->fromWilayaId !== '') {
            return $this->wilayaByRef($this->fromWilayaId);
        }
        if ($this->fromWilayaName !== null && $this->fromWilayaName !== '') {
            return $this->findWilaya($this->fromWilayaName, true);
        }

        throw ShippingError::validation(
            'Yalidine needs the origin wilaya: set "fromWilayaId" or "fromWilayaName" in the client options (or pass fromWilayaId to getFees)',
            self::NAME,
            'fromWilayaId',
        );
    }

    private function originWilayaName(): string
    {
        return $this->originWilaya()->name;
    }

    /** @return list<mixed> */
    private static function dataItems(mixed $response): array
    {
        if (!is_array($response)) {
            return [];
        }
        if (isset($response['data']) && is_array($response['data'])) {
            return array_values($response['data']);
        }

        return array_is_list($response) ? $response : [];
    }

    private static function intOrZero(int|float|null $value): int
    {
        return $value === null ? 0 : (int) ceil($value);
    }

    /** Billable weight = max(actual weight, volumetric weight) when dimensions are known. */
    private static function billableWeight(FeeQuery $query): int|float|null
    {
        $volumetric = $query->length !== null && $query->width !== null && $query->height !== null
            ? $query->length * $query->width * $query->height * self::VOLUMETRIC_FACTOR
            : null;
        if ($query->weight === null) {
            return $volumetric;
        }

        return $volumetric === null ? $query->weight : max($query->weight, $volumetric);
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
