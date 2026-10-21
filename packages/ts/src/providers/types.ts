import type {
  FeeQuery,
  FeeQuote,
  HealthCheckResult,
  Location,
  Parcel,
  ParcelInput,
  ParcelListPage,
  ParcelListQuery,
  StopDesk,
  StopDeskQuery,
  TrackResult,
} from '../types';

/** Unified carrier interface — CONTRACT.md §5. */
export interface ShippingProvider {
  readonly name: string;
  createParcel(input: ParcelInput): Promise<Parcel>;
  track(trackingNumber: string): Promise<TrackResult>;
  getFees(query: FeeQuery): Promise<FeeQuote>;
  getWilayas(): Promise<Location[]>;
  getCommunes(wilayaId: string | number): Promise<Location[]>;
  getStopDesks(query: StopDeskQuery): Promise<StopDesk[]>;
  /**
   * Paginated account parcels with current unified status (no event history).
   * Throws `NOT_SUPPORTED` when the carrier has no listing API.
   */
  listParcels(query?: ParcelListQuery): Promise<ParcelListPage>;
  cancelParcel(trackingNumberOrId: string): Promise<void>;
  /** Lightweight authenticated probe (wilayas listing). Always hits the network. */
  healthCheck(): Promise<HealthCheckResult>;
}
