/**
 * dz-delivery quickstart (TypeScript).
 *
 * From the repo root, after `cp .env.example .env` and filling in your keys:
 *
 *   cd packages/ts && npm install && cd ../..
 *   npx --prefix packages/ts tsx --env-file=.env examples/ts/quickstart.ts
 *
 * Environment:
 *   DZ_PROVIDER          zrexpress (default) | yalidine | maystro | ecotrack
 *   ZREXPRESS_API_KEY, ZREXPRESS_TENANT
 *   YALIDINE_API_ID, YALIDINE_API_TOKEN, YALIDINE_FROM_WILAYA_ID (origin wilaya code, e.g. 16)
 *   MAYSTRO_API_TOKEN
 *   ECOTRACK_TOKEN + ECOTRACK_COURIER (e.g. dhd) or ECOTRACK_BASE_URL (tenant URL)
 *   DZ_TRACKING          optional: a tracking number to track
 *   DZ_CREATE_PARCEL=1   optional: really create a test parcel (then cancel it)
 */
import { createClient, isShippingError, type ShippingProvider } from '../../packages/ts/src/index';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name} (see .env.example)`);
  return value;
}

function makeClient(): ShippingProvider {
  const provider = process.env.DZ_PROVIDER ?? 'zrexpress';
  if (provider === 'zrexpress') {
    return createClient('zrexpress', { apiKey: env('ZREXPRESS_API_KEY'), tenant: env('ZREXPRESS_TENANT') });
  }
  if (provider === 'yalidine') {
    return createClient('yalidine', {
      apiId: env('YALIDINE_API_ID'),
      apiToken: env('YALIDINE_API_TOKEN'),
      fromWilayaId: process.env.YALIDINE_FROM_WILAYA_ID ?? 16,
    });
  }
  if (provider === 'maystro') {
    return createClient('maystro', { apiToken: env('MAYSTRO_API_TOKEN') });
  }
  if (provider === 'ecotrack') {
    const courier = process.env.ECOTRACK_COURIER || undefined;
    return createClient('ecotrack', {
      token: env('ECOTRACK_TOKEN'),
      ...(courier ? { courier } : { baseUrl: env('ECOTRACK_BASE_URL') }),
    });
  }
  throw new Error(`Unsupported DZ_PROVIDER "${provider}"`);
}

async function main() {
  const client = makeClient();
  console.log(`Provider: ${client.name}`);

  const wilayas = await client.getWilayas();
  console.log(`${wilayas.length} wilayas, e.g.`, wilayas.slice(0, 3).map((w) => `${w.code ?? '?'} ${w.name}`));

  const alger = wilayas.find((w) => w.code === '16') ?? wilayas[0];
  if (!alger) throw new Error('No wilaya returned');

  const communes = await client.getCommunes(alger.id);
  console.log(`${communes.length} communes in ${alger.name}, e.g.`, communes.slice(0, 3).map((c) => c.name));

  const fee = await client.getFees({ toWilayaId: alger.id, toCommuneId: communes[0]?.id });
  console.log(`Home delivery to ${alger.name}: ${fee.deliveryFee} ${fee.currency}`, fee.stopDeskFee !== undefined ? `(stop desk: ${fee.stopDeskFee})` : '');

  if (process.env.DZ_TRACKING) {
    const { parcel, events } = await client.track(process.env.DZ_TRACKING);
    console.log(`Parcel ${parcel.trackingNumber}: ${parcel.status}`);
    for (const e of events) console.log(`  ${e.at}  ${e.status.padEnd(10)}  ${e.label}`);
  }

  if (process.env.DZ_CREATE_PARCEL === '1') {
    const commune = communes[0];
    if (!commune) throw new Error(`No commune available in ${alger.name}`);
    const parcel = await client.createParcel({
      recipientName: 'Test Client',
      phone: '0550123456',
      address: 'Adresse de test',
      wilayaId: alger.id,
      communeId: commune.id,
      productName: 'Test product',
      price: 1000,
      orderId: `quickstart-${Date.now()}`,
    });
    console.log('Created:', { id: parcel.id, trackingNumber: parcel.trackingNumber, status: parcel.status });
    try {
      await client.cancelParcel(parcel.trackingNumber);
      console.log('Cancelled', parcel.trackingNumber);
    } catch (err) {
      // Maystro has no cancellation API.
      if (!isShippingError(err) || err.code !== 'NOT_SUPPORTED') throw err;
      console.log(`Cancellation not supported by ${client.name}: cancel ${parcel.trackingNumber} from its dashboard`);
    }
  }
}

main().catch((err) => {
  if (isShippingError(err)) {
    console.error(`[${err.provider ?? '?'}] ${err.code}${err.httpStatus ? ` (HTTP ${err.httpStatus})` : ''}: ${err.message}`);
    if (err.details) console.error(err.details);
  } else {
    console.error(err);
  }
  process.exit(1);
});
