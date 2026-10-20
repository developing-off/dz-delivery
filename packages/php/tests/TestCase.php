<?php

declare(strict_types=1);

namespace DzDelivery\Tests;

use DzDelivery\ClientFactory;
use DzDelivery\Contracts\ShippingProviderInterface;
use DzDelivery\Models\Location;
use DzDelivery\Models\StopDesk;
use DzDelivery\Models\Parcel;
use DzDelivery\Models\TrackingEvent;
use DzDelivery\Models\TrackResult;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\Response;
use Psr\Http\Message\RequestInterface;

abstract class TestCase extends \PHPUnit\Framework\TestCase
{
    /**
     * Monorepo: packages/php/tests → ../../../docs/fixtures.
     * Split repo (dz-delivery-php): tests → ../docs/fixtures (copied on sync).
     */
    protected static function fixturesDir(): string
    {
        static $dir;
        if ($dir !== null) {
            return $dir;
        }
        $monorepo = dirname(__DIR__, 3) . '/docs/fixtures';
        $split = dirname(__DIR__) . '/docs/fixtures';
        $dir = is_dir($monorepo) ? $monorepo : $split;

        return $dir;
    }

    protected const CREDENTIALS = [
        'zrexpress' => ['apiKey' => 'test-api-key', 'tenant' => 'test-tenant'],
        'yalidine' => ['apiId' => 'test-api-id', 'apiToken' => 'test-api-token', 'fromWilayaId' => 5],
        'maystro' => ['apiToken' => 'test-api-token'],
        'ecotrack' => ['token' => 'test-api-token', 'baseUrl' => 'https://test.ecotrack.dz'],
    ];

    /** @var array<int, array{request: RequestInterface}> */
    protected array $history = [];

    protected MockHandler $mock;

    /**
     * @param list<Response|\Throwable> $responses
     * @param array<string, mixed> $options
     */
    protected function client(string $provider, array $responses, array $options = []): ShippingProviderInterface
    {
        $this->history = [];
        $this->mock = new MockHandler($responses);
        $stack = HandlerStack::create($this->mock);
        $stack->push(Middleware::history($this->history));

        return ClientFactory::create($provider, $options + self::CREDENTIALS[$provider] + ['handler' => $stack]);
    }

    protected static function json(int $status, mixed $body = null, array $headers = []): Response
    {
        return new Response(
            $status,
            $headers + ['Content-Type' => 'application/json'],
            $body === null ? '' : json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE),
        );
    }

    protected static function fixture(string $relativePath): mixed
    {
        $path = self::fixturesDir() . '/' . $relativePath;
        self::assertFileExists($path);

        return json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
    }

    /** @return list<Response> */
    protected static function nativeResponses(string $relativePath): array
    {
        return array_map(
            static fn (array $r) => self::json($r['status'], $r['body'] ?? null, $r['headers'] ?? []),
            self::fixture($relativePath),
        );
    }

    /**
     * Asserts the recorded requests match a *.request.json fixture. Bodies are
     * compared as subsets (fields not listed in the fixture are ignored).
     */
    protected function assertRequests(string $relativePath): void
    {
        $expected = self::fixture($relativePath);
        self::assertCount(count($expected), $this->history, 'Unexpected number of HTTP calls');

        foreach ($expected as $i => $exp) {
            $request = $this->history[$i]['request'];
            self::assertSame($exp['method'], $request->getMethod(), "Request #$i method");
            self::assertSame($exp['path'], $request->getUri()->getPath(), "Request #$i path");
            foreach ($exp['headers'] ?? [] as $name => $value) {
                self::assertSame($value, $request->getHeaderLine($name), "Request #$i header $name");
            }
            if (isset($exp['query'])) {
                parse_str($request->getUri()->getQuery(), $query);
                self::assertSubset($exp['query'], $query, "Request #$i query");
            }
            if (isset($exp['body'])) {
                $body = json_decode((string) $request->getBody(), true, 512, JSON_THROW_ON_ERROR);
                self::assertSubset($exp['body'], $body, "Request #$i body");
            }
        }
    }

    protected static function assertSubset(array $expected, mixed $actual, string $path = ''): void
    {
        self::assertIsArray($actual, "$path is not an array");
        foreach ($expected as $key => $value) {
            self::assertArrayHasKey($key, $actual, "$path.$key is missing");
            if (is_array($value)) {
                self::assertSubset($value, $actual[$key], "$path.$key");
            } else {
                self::assertEquals($value, $actual[$key], "$path.$key");
            }
        }
    }

    /** @return array<string, mixed> */
    protected static function parcelToArray(Parcel $p): array
    {
        return ['id' => $p->id, 'trackingNumber' => $p->trackingNumber, 'status' => $p->status, 'provider' => $p->provider];
    }

    /** @return array<string, mixed> */
    protected static function trackToArray(TrackResult $r): array
    {
        return [
            'parcel' => self::parcelToArray($r->parcel),
            'events' => array_map(
                static fn (TrackingEvent $e) => ['status' => $e->status, 'label' => $e->label, 'at' => $e->at],
                $r->events,
            ),
        ];
    }

    /** @return array<string, mixed> */
    protected static function stopDeskToArray(StopDesk $d): array
    {
        return ['id' => $d->id, 'name' => $d->name, 'address' => $d->address, 'communeId' => $d->communeId, 'wilayaId' => $d->wilayaId];
    }

    /** @return array<string, mixed> */
    protected static function locationToArray(Location $l): array
    {
        return ['id' => $l->id, 'name' => $l->name, 'parentId' => $l->parentId, 'code' => $l->code];
    }
}
