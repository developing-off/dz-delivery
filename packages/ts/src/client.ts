import { ShippingError } from './errors';
import { EcotrackProvider } from './providers/ecotrack';
import { MaystroProvider } from './providers/maystro';
import type { ShippingProvider } from './providers/types';
import { YalidineProvider } from './providers/yalidine';
import { ZRExpressProvider } from './providers/zrexpress';
import type {
  EcotrackConfig,
  MaystroConfig,
  ProviderConfigMap,
  ProviderName,
  YalidineConfig,
  ZRExpressConfig,
} from './types';

export const SUPPORTED_PROVIDERS: readonly ProviderName[] = ['zrexpress', 'yalidine', 'maystro', 'ecotrack'];

export function createClient(provider: 'zrexpress', config: ZRExpressConfig): ShippingProvider;
export function createClient(provider: 'yalidine', config: YalidineConfig): ShippingProvider;
export function createClient(provider: 'maystro', config: MaystroConfig): ShippingProvider;
export function createClient(provider: 'ecotrack', config: EcotrackConfig): ShippingProvider;
export function createClient<P extends ProviderName>(provider: P, config: ProviderConfigMap[P]): ShippingProvider;
export function createClient(provider: ProviderName, config: ProviderConfigMap[ProviderName]): ShippingProvider {
  switch (provider) {
    case 'zrexpress':
      return new ZRExpressProvider(config as ZRExpressConfig);
    case 'yalidine':
      return new YalidineProvider(config as YalidineConfig);
    case 'maystro':
      return new MaystroProvider(config as MaystroConfig);
    case 'ecotrack':
      return new EcotrackProvider(config as EcotrackConfig);
    default:
      throw new ShippingError(
        'NOT_SUPPORTED',
        `Unknown provider "${String(provider)}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}`,
      );
  }
}
