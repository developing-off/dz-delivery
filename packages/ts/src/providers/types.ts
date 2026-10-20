import type {
  FeeQuery,
  FeeQuote,
  HealthCheckResult,
  Location,
  Parcel,
  ParcelInput,
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
  cancelParcel(trackingNumberOrId: string): Promise<void>;
  /** Lightweight authenticated probe (wilayas listing). Always hits the network. */
  healthCheck(): Promise<HealthCheckResult>;
}
