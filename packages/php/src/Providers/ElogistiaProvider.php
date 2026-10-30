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
use DzDelivery\Models\StopDeskQuery;
use DzDelivery\Models\TrackingEvent;
use DzDelivery\Models\TrackResult;
use DzDelivery\Support\Dates;
use DzDelivery\Support\Health;
use DzDelivery\Support\Phone;
use DzDelivery\Support\StatusMapper;
use DzDelivery\Support\Text;

/**
 * Elogistia — api.elogistia.com. Mapping and assumptions: docs/PROVIDERS.md#elogistia.
 *
 * Options: 'apiKey' (sent in the query string, as Elogistia requires) and 'email' (sent as
 * mail on every order, mandatory for Elogistia; default customer@example.com).
 *
 * Elogistia publishes no API documentation: endpoints follow the legacy Confirmation-api and
 * were checked against live responses. No stop-desk list, parcel list or cancellation
 * endpoint: those throw NOT_SUPPORTED.
 */
final class ElogistiaProvider implements ShippingProviderInterface
{
    public const NAME = 'elogistia';
    public const DEFAULT_BASE_URL = 'https://api.elogistia.com';

    private const TIMEZONE = 'Africa/Algiers';
    private const DEFAULT_EMAIL = 'customer@example.com';
    private const DELIVERY_HOME = 1;
    private const DELIVERY_STOP_DESK = 2;
    private const MODE_STANDARD = 1;

    /** "Missing parameter: commune" → communeId. Same table as the TS provider. */
    private const FIELDS = [
        'name' => 'recipientName',
        'firstname' => 'recipientName',
        'phone' => 'phone',
        'address' => 'address',
        'commune' => 'communeId',
        'wilaya' => 'wilayaId',
        'product' => 'productName',
        'price' => 'price',
        'IdCommande' => 'orderId',
    ];

    private HttpClient $http;
    private string $apiKey;
    private string $email;
    private bool $includeRaw;

    /** @var list<array<string, mixed>>|null */
    private ?array $fees = null;

    /** @var list<array<string, mixed>>|null */
    private ?array $communes = null;

    public function __construct(ClientOptions $options, ?HttpClient $http = null)
    {
        $apiKey = trim((string) $options->get('apiKey', ''));
        if ($apiKey === '') {
            throw new ShippingError(ShippingError::AUTH_FAILED, 'Elogistia requires "apiKey"', null, null, null, self::NAME);
        }

        $this->apiKey = $apiKey;
        $this->email = trim((string) $options->get('email', '')) ?: self::DEFAULT_EMAIL;
        $this->includeRaw = $options->includeRaw;
        $this->http = $http ?? new HttpClient(
            baseUrl: Dates::requireHttps(trim((string) ($options->baseUrl ?? '')) ?: self::DEFAULT_BASE_URL, self::NAME),
            provider: self::NAME,
            headers: [],
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
     * POST insertCommande/ with every field in the query string. The commune is sent with
     * Elogistia's spelling (resolved through getMunicipalities). Stop desk: stop_desk = 2;
     * Elogistia picks the desk itself, so stopDeskId is not sent. Answer { success: "<tracking>" }.
     */
    public function createParcel(ParcelInput|array $input): Parcel
    {
        $input = ParcelInput::from($input, self::NAME);
        $phone = Phone::toLocal($input->phone, self::NAME, 'phone');
        $wilayaCode = $this->resolveWilayaCode($input->wilayaId ?? $input->wilayaName);
        $commune = $this->resolveCommune($wilayaCode, $input->communeId ?? $input->communeName);

        // name (family name) and firstname are both required: a one-word name fills both.
        $parts = preg_split('/\s+/', trim($input->recipientName)) ?: [];
        $first = (string) array_shift($parts);
        $orderId = trim((string) $input->orderId);
        $query = [
            'apiKey' => $this->apiKey,
            'name' => $parts !== [] ? implode(' ', $parts) : $first,
            'firstname' => $first,
            'mail' => $this->email,
            'phone' => $phone,
            'address' => trim($input->address) !== '' ? trim($input->address) : $commune->name,
            'commune' => $commune->name,
            'wilaya' => (int) $wilayaCode,
            'product' => trim($input->productDescription()),
            // price is what the recipient pays; the delivery fee is already in it.
            'price' => (int) round($input->price),
            'fraisDeLivraison' => 0,
            'stop_desk' => $input->isStopDesk ? self::DELIVERY_STOP_DESK : self::DELIVERY_HOME,
            'modeDeLivraison' => self::MODE_STANDARD,
            'IdCommande' => $orderId !== '' ? $orderId : 'dzd-' . (int) (microtime(true) * 1000),
        ];
        if ($input->remark !== null && trim($input->remark) !== '') {
            $query['remarque'] = trim($input->remark);
        }

        $body = $this->http->request('POST', 'insertCommande/', $query);
        if (is_array($body) && self::hasValue($body['error'] ?? null)) {
            throw new ShippingError(ShippingError::VALIDATION_ERROR, (string) $body['error'], null, null, $this->raw($body), self::NAME);
        }
        $tracking = is_array($body) ? self::text($body['success'] ?? null) : null;
        if ($tracking === null) {
            throw ShippingError::providerError('Elogistia did not return a tracking number', self::NAME, $this->raw($body));
        }

        return new Parcel($tracking, $tracking, ParcelStatus::PENDING, self::NAME, $this->raw($body));
    }

    /**
     * GET getTracking/?tracking=: body [{ Date, Statut, Log }]. HTTP 404
     * "Commande not found or no log yet." → NOT_FOUND (also for a parcel with no log yet).
     */
    public function track(string $trackingNumber): TrackResult
    {
        $tracking = trim($trackingNumber);
        if ($tracking === '') {
            throw ShippingError::validation('trackingNumber is required', self::NAME, 'trackingNumber');
        }

        $body = $this->http->request('GET', 'getTracking/', ['apiKey' => $this->apiKey, 'tracking' => $tracking]);
        $rows = [];
        foreach ($this->bodyList($body, 'tracking') as $i => $step) {
            $rows[] = ['step' => $step, 'i' => $i, 'at' => Dates::toIso(self::text($step['Date'] ?? null) ?? '', self::TIMEZONE)];
        }
        usort($rows, static fn (array $x, array $y) => Dates::compare($x['at'], $y['at']) ?: $x['i'] <=> $y['i']);

        $events = [];
        $current = ParcelStatus::UNKNOWN;
        foreach ($rows as ['step' => $step, 'at' => $at]) {
            $statut = self::text($step['Statut'] ?? null);
            $log = self::text($step['Log'] ?? null);
            $label = $statut !== null && $log !== null && $log !== $statut ? "$statut ($log)" : ($statut ?? $log ?? '');
            $status = StatusMapper::elogistia($statut ?? $log);
            if ($status !== ParcelStatus::UNKNOWN) {
                $current = $status;
            }
            $events[] = new TrackingEvent(status: $status, label: $label, at: $at, raw: $this->raw($step));
        }

        return new TrackResult(new Parcel($tracking, $tracking, $current, self::NAME, $this->raw($body)), $events);
    }

    /** GET getShippingCost/: per-wilaya home and stopdesk rates. No return fee. */
    public function getFees(FeeQuery|array $query): FeeQuote
    {
        $query = FeeQuery::from($query, self::NAME);
        $code = (int) $this->resolveWilayaCode($query->toWilayaId);
        $row = null;
        foreach ($this->feeRows() as $r) {
            if (is_numeric($r['wilayaID'] ?? null) && (int) $r['wilayaID'] === $code) {
                $row = $r;
                break;
            }
        }
        $home = self::number($row['home'] ?? null);
        $desk = self::number($row['stopdesk'] ?? null);
        $fee = $query->isStopDesk ? $desk : $home;
        if ($fee === null) {
            throw ShippingError::notFound('No Elogistia ' . ($query->isStopDesk ? 'stop-desk' : 'home') . " rate for wilaya $code", self::NAME);
        }

        return new FeeQuote(deliveryFee: $fee, returnFee: null, stopDeskFee: $desk, raw: $this->raw($row));
    }

    /** Wilayas of the fee grid (getShippingCost), ordered by code: the ones Elogistia serves. */
    public function getWilayas(): array
    {
        $wilayas = [];
        foreach ($this->feeRows() as $r) {
            if (!is_numeric($r['wilayaID'] ?? null)) {
                continue;
            }
            $id = (string) (int) $r['wilayaID'];
            $wilayas[] = new Location(id: $id, name: trim((string) ($r['wilayaLabel'] ?? '')), parentId: null, code: $id, raw: $this->raw($r));
        }
        usort($wilayas, static fn (Location $a, Location $b) => (int) $a->id <=> (int) $b->id);

        return $wilayas;
    }

    /** GET getMunicipalities/ (every commune, filtered by wilaya). Location id = Elogistia Id. */
    public function getCommunes(string|int $wilayaId): array
    {
        $code = $this->resolveWilayaCode($wilayaId);
        $communes = [];
        foreach ($this->communeRows() as $c) {
            if (!is_numeric($c['wilaya'] ?? null) || (int) $c['wilaya'] !== (int) $code) {
                continue;
            }
            if (!self::hasValue($c['Id'] ?? null) || !self::hasValue($c['name'] ?? null)) {
                continue;
            }
            $communes[] = new Location(id: (string) $c['Id'], name: trim((string) $c['name']), parentId: $code, code: null, raw: $this->raw($c));
        }

        return $communes;
    }

    /** Elogistia has no stop-desk list: with isStopDesk, it picks the desk itself. */
    public function getStopDesks(StopDeskQuery|array $query): array
    {
        throw ShippingError::notSupported('Elogistia has no stop-desk list (it assigns the desk itself)', self::NAME);
    }

    public function listParcels(ParcelListQuery|array|null $query = null): ParcelListPage
    {
        throw ShippingError::notSupported('Elogistia has no parcel listing endpoint', self::NAME);
    }

    public function cancelParcel(string $trackingNumberOrId): void
    {
        throw ShippingError::notSupported('Elogistia has no cancellation endpoint (cancel from the dashboard)', self::NAME);
    }

    /** Probes getShippingCost (bypasses cache). */
    public function healthCheck(): HealthCheckResult
    {
        return Health::probeWilayas(
            self::NAME,
            function (): void {
                $this->fees = null;
            },
            fn () => $this->getWilayas(),
        );
    }

    /**
     * { "Message": "..." } (401, 404), { "error": "..." } (400 missing parameter) or a bare
     * JSON string ("fee not found.0"). "Missing parameter: x" becomes a detail on field x.
     *
     * @return array{0: ?string, 1: ?array}
     */
    public static function parseError(int $status, mixed $body): array
    {
        if (is_string($body)) {
            return [$body !== '' ? substr($body, 0, 500) : null, null];
        }
        if (!is_array($body)) {
            return [null, null];
        }
        $message = self::text($body['Message'] ?? null) ?? self::text($body['error'] ?? null) ?? self::text($body['message'] ?? null);
        if ($message === null) {
            return [null, null];
        }
        if (preg_match('/^Missing parameter:\s*(\w+)/i', $message, $m) === 1) {
            return [$message, [['field' => self::FIELDS[$m[1]] ?? $m[1], 'message' => $message]]];
        }

        return [$message, null];
    }

    // --- internals ---------------------------------------------------------------

    /**
     * A wrong key answers HTTP 404 "fee not found.0" here: reported as AUTH_FAILED.
     *
     * @return list<array<string, mixed>>
     */
    private function feeRows(): array
    {
        if ($this->fees === null) {
            try {
                $body = $this->http->request('GET', 'getShippingCost/', ['key' => $this->apiKey]);
            } catch (ShippingError $e) {
                if ($e->httpStatus === 404) {
                    throw new ShippingError(
                        ShippingError::AUTH_FAILED,
                        'Elogistia returned no fee grid (check apiKey): ' . $e->getMessage(),
                        404,
                        null,
                        $e->raw,
                        self::NAME,
                        $e,
                    );
                }
                throw $e;
            }
            $this->fees = $this->bodyList($body, 'fees');
        }

        return $this->fees;
    }

    /** @return list<array<string, mixed>> */
    private function communeRows(): array
    {
        if ($this->communes === null) {
            $this->communes = $this->bodyList($this->http->request('GET', 'getMunicipalities/', ['key' => $this->apiKey]), 'communes');
        }

        return $this->communes;
    }

    /** @return list<array<string, mixed>> body: [...] of every answer. */
    private function bodyList(mixed $body, string $what): array
    {
        if (!is_array($body) || !is_array($body['body'] ?? null)) {
            throw ShippingError::providerError("Unexpected Elogistia $what response", self::NAME, $this->raw($body));
        }

        return array_values(array_filter($body['body'], static fn ($r) => is_array($r) && !array_is_list($r)));
    }

    /** Official code 1–58 as-is; names through the fee grid. */
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

    /** By Elogistia id, exact name, then spelling-tolerant name (unambiguous only). */
    private function resolveCommune(string $wilayaCode, string|int|null $ref): Location
    {
        $value = trim((string) $ref);
        $communes = $this->getCommunes($wilayaCode);
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
        $found = Text::findLoosely($communes, $value, static fn (Location $c) => $c->name);
        if ($found === null) {
            throw ShippingError::notFound("Unknown commune: $value in wilaya $wilayaCode", self::NAME);
        }

        return $found;
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
