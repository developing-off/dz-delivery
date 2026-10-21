export { createClient, createZRExpress, SUPPORTED_PROVIDERS } from './client';
export { ShippingError, isShippingError, codeFromHttpStatus } from './errors';
export type { ShippingErrorOptions } from './errors';
export { createStatusMapper, normalizeStatusKey } from './status';
export type { StatusMapper, StatusMapperOptions } from './status';
export { normalizeAlgerianPhone } from './utils';
export type { ShippingProvider } from './providers/types';
export {
  ZRExpressProvider,
  mapZRExpressStatus,
  ZREXPRESS_DEFAULT_BASE_URL,
} from './providers/zrexpress';
export type {
  LabelResult,
  BulkCreateResult,
  BulkCreateFailure,
  BulkDeleteResult,
  BulkDeleteSuccess,
  BulkDeleteFailure,
} from './providers/zrexpress';
export {
  verifyZRExpressWebhook,
  parseZRExpressWebhook,
  ZREXPRESS_WEBHOOK_TOLERANCE_SEC,
} from './providers/zrexpress-webhooks';
export type { ZRExpressWebhookEvent, ZRExpressWebhookHeaders } from './providers/zrexpress-webhooks';
export {
  YalidineProvider,
  mapYalidineStatus,
  YALIDINE_DEFAULT_BASE_URL,
  GUEPEX_DEFAULT_BASE_URL,
} from './providers/yalidine';
export {
  MaystroProvider,
  mapMaystroStatus,
  MAYSTRO_DEFAULT_BASE_URL,
  MAYSTRO_BACKEND_BASE_URL,
  MAYSTRO_STATUS_CODES,
} from './providers/maystro';
export {
  EcotrackProvider,
  mapEcotrackStatus,
  resolveEcotrackBaseUrl,
  ECOTRACK_COURIERS,
} from './providers/ecotrack';
export { PARCEL_STATUSES } from './types';
export type {
  BaseClientConfig,
  EcotrackConfig,
  FeeQuery,
  FeeQuote,
  HealthCheckResult,
  Location,
  MaystroConfig,
  Parcel,
  ParcelInput,
  ParcelListPage,
  ParcelListQuery,
  ParcelStatus,
  ProductItem,
  ProviderConfigMap,
  ProviderName,
  ShippingErrorCode,
  ShippingErrorDetail,
  StockType,
  StopDesk,
  StopDeskQuery,
  TrackingEvent,
  TrackResult,
  YalidineConfig,
  ZRExpressConfig,
} from './types';
