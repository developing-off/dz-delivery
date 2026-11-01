<?php

declare(strict_types=1);

namespace DzDelivery\Http;

use DzDelivery\Errors\ShippingError;
use GuzzleHttp\Client;
use GuzzleHttp\ClientInterface;
use GuzzleHttp\Exception\ConnectException;
use GuzzleHttp\Exception\TransferException;
use GuzzleHttp\RequestOptions;
use Psr\Http\Message\ResponseInterface;

/**
 * Thin JSON wrapper around Guzzle that converts every failure into a ShippingError.
 */
final class HttpClient
{
    private ClientInterface $client;

    /** @var callable(int, mixed): array{0: ?string, 1: ?array} */
    private $errorParser;

    /**
     * @param array<string, string> $headers
     * @param callable|null $handler Guzzle handler (MockHandler / HandlerStack) for tests.
     * @param (callable(int, mixed): array{0: ?string, 1: ?array})|null $errorParser
     *        Extracts [message, details] from a native error body.
     */
    public function __construct(
        private readonly string $baseUrl,
        private readonly string $provider,
        array $headers = [],
        int $timeoutMs = 15000,
        private readonly bool $includeRaw = true,
        ?callable $handler = null,
        ?callable $errorParser = null,
        ?ClientInterface $client = null,
    ) {
        $config = [
            RequestOptions::TIMEOUT => $timeoutMs / 1000,
            RequestOptions::CONNECT_TIMEOUT => $timeoutMs / 1000,
            RequestOptions::HTTP_ERRORS => false,
            RequestOptions::HEADERS => $headers + [
                'Accept' => 'application/json',
                'User-Agent' => 'dz-delivery-php/0.1',
            ],
        ];
        if ($handler !== null) {
            $config['handler'] = $handler;
        }

        $this->client = $client ?? new Client($config);
        $this->errorParser = $errorParser ?? [self::class, 'defaultErrorParser'];
    }

    /**
     * @param array<string, mixed> $query
     * @return mixed Decoded JSON body (null for empty bodies, e.g. 204).
     */
    public function request(string $method, string $path, array $query = [], mixed $json = null): mixed
    {
        $response = $this->send($method, $path, $query, $json);
        $status = $response->getStatusCode();
        [$body, $decodeFailed] = self::decode((string) $response->getBody());

        if ($status >= 400) {
            $this->fail($response, $body);
        }

        if ($decodeFailed) {
            throw new ShippingError(
                ShippingError::PROVIDER_ERROR,
                'Unparseable response from carrier',
                $status,
                null,
                $this->includeRaw ? $body : null,
                $this->provider,
            );
        }

        return $body;
    }

    /**
     * Like request(), but a successful body is returned as raw bytes (e.g. a PDF label).
     * Error bodies are still decoded and mapped to a ShippingError.
     *
     * @param array<string, mixed> $query
     * @param array<string, string> $headers Extra request headers (e.g. Accept).
     * @return array{body: string, contentType: string}
     */
    public function requestBinary(string $method, string $path, array $query = [], mixed $json = null, array $headers = []): array
    {
        $response = $this->send($method, $path, $query, $json, $headers);
        if ($response->getStatusCode() >= 400) {
            $this->fail($response, self::decode((string) $response->getBody())[0]);
        }

        return ['body' => (string) $response->getBody(), 'contentType' => $response->getHeaderLine('Content-Type')];
    }

    /**
     * @param array<string, mixed> $query
     * @param array<string, string> $headers
     */
    private function send(string $method, string $path, array $query, mixed $json, array $headers = []): ResponseInterface
    {
        $url = rtrim($this->baseUrl, '/') . '/' . ltrim($path, '/');
        $options = [];
        if ($query !== []) {
            $options[RequestOptions::QUERY] = $query;
        }
        if ($json !== null) {
            $options[RequestOptions::JSON] = $json;
        }
        if ($headers !== []) {
            $options[RequestOptions::HEADERS] = $headers;
        }

        try {
            return $this->client->request($method, $url, $options);
        } catch (ConnectException $e) {
            throw new ShippingError(ShippingError::NETWORK_ERROR, $e->getMessage(), null, null, null, $this->provider, $e);
        } catch (TransferException $e) {
            throw new ShippingError(ShippingError::NETWORK_ERROR, $e->getMessage(), null, null, null, $this->provider, $e);
        } catch (\Throwable $e) {
            throw new ShippingError(ShippingError::UNKNOWN, $e->getMessage(), null, null, null, $this->provider, $e);
        }
    }

    /** @return array{0: mixed, 1: bool} [decoded body (raw string when not JSON), decode failed] */
    private static function decode(string $rawBody): array
    {
        if (trim($rawBody) === '') {
            return [null, false];
        }
        try {
            return [json_decode($rawBody, true, 512, JSON_THROW_ON_ERROR), false];
        } catch (\JsonException) {
            return [$rawBody, true];
        }
    }

    private function fail(ResponseInterface $response, mixed $body): never
    {
        $status = $response->getStatusCode();
        [$message, $details] = ($this->errorParser)($status, $body);
        throw new ShippingError(
            ShippingError::codeForHttpStatus($status),
            $message ?? "HTTP $status",
            $status,
            $details,
            $this->includeRaw ? $body : null,
            $this->provider,
            null,
            $status === 429 ? ShippingError::parseRetryAfter($response->getHeaderLine('Retry-After')) : null,
        );
    }

    /**
     * @return array{0: ?string, 1: ?array}
     */
    public static function defaultErrorParser(int $status, mixed $body): array
    {
        if (!is_array($body)) {
            return [is_string($body) && $body !== '' ? substr($body, 0, 500) : null, null];
        }
        $message = $body['detail'] ?? $body['title'] ?? $body['message'] ?? $body['error']['message'] ?? $body['error'] ?? null;

        return [is_string($message) ? $message : null, null];
    }
}
