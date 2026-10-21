/**
 * Live smoke test against ZRExpress (read-heavy; optional create+cancel).
 * Usage:
 *   ZREXPRESS_API_KEY=... ZREXPRESS_TENANT=... node scripts/live-zrexpress.mjs
 *   LIVE_CREATE=1 ...  # also create+cancel a parcel
 */
import { createClient, ShippingError } from '../dist/index.js';

const apiKey = process.env.ZREXPRESS_API_KEY;
const tenant = process.env.ZREXPRESS_TENANT;
if (!apiKey || !tenant) {
  console.error('Missing ZREXPRESS_API_KEY / ZREXPRESS_TENANT');
  process.exit(1);
}

const doCreate = process.env.LIVE_CREATE === '1';
const client = createClient('zrexpress', { apiKey, tenant, timeoutMs: 30000 });

function ok(label, detail) {
  console.log(`✓ ${label}${detail ? ` — ${detail}` : ''}`);
}
function fail(label, err) {
  const msg = err instanceof ShippingError
    ? `${err.code}: ${err.message}${err.details ? ` ${JSON.stringify(err.details)}` : ''}`
    : String(err?.message ?? err);
  console.error(`✗ ${label} — ${msg}`);
  throw err;
}

async function main() {
  console.log('ZRExpress live smoke (0.1.5)\n');

  try {
    const health = await client.healthCheck();
    ok('healthCheck', `${health.latencyMs}ms provider=${health.provider}`);
  } catch (e) {
    fail('healthCheck', e);
  }

  let wilayas;
  try {
    wilayas = await client.getWilayas();
    const alger = wilayas.find((w) => Number(w.code) === 16) ?? wilayas[0];
    ok('getWilayas', `${wilayas.length} wilayas; sample=${alger?.name} code=${alger?.code}`);
  } catch (e) {
    fail('getWilayas', e);
  }

  const wilaya = wilayas.find((w) => Number(w.code) === 16) ?? wilayas[0];
  let communes;
  try {
    communes = await client.getCommunes(wilaya.id);
    ok('getCommunes', `${communes.length} communes in ${wilaya.name}`);
  } catch (e) {
    fail('getCommunes', e);
  }

  let desksWilaya;
  try {
    desksWilaya = await client.getStopDesks({ wilayaId: wilaya.code ?? wilaya.id });
    const sample = desksWilaya[0];
    ok(
      'getStopDesks(wilaya)',
      `${desksWilaya.length} desks` +
        (sample
          ? `; first=${sample.name} phone=${sample.phone ?? '—'} hours=${sample.openingHours ?? '—'} type=${sample.type ?? '—'}`
          : ''),
    );
  } catch (e) {
    fail('getStopDesks(wilaya)', e);
  }

  const commune = communes.find((c) => /bab/i.test(c.name)) ?? communes[0];
  if (commune) {
    try {
      const desksCommune = await client.getStopDesks({
        wilayaId: wilaya.code ?? wilaya.id,
        communeId: commune.id,
      });
      ok('getStopDesks(wilaya+commune)', `${desksCommune.length} desks for ${commune.name}`);
    } catch (e) {
      if (e instanceof ShippingError && e.code === 'NOT_FOUND' && e.details?.[0]?.code === 'EMPTY_COMMUNE_HUBS') {
        ok('getStopDesks(wilaya+commune)', `EMPTY_COMMUNE_HUBS as expected (${e.message})`);
      } else {
        fail('getStopDesks(wilaya+commune)', e);
      }
    }
  }

  // Probe a random UUID commune that almost certainly has no hubs → hint path.
  if (desksWilaya?.length) {
    try {
      await client.getStopDesks({
        wilayaId: wilaya.id,
        communeId: '99999999-9999-4999-8999-999999999999',
      });
      ok('getStopDesks(fake commune)', 'unexpectedly returned desks');
    } catch (e) {
      if (e instanceof ShippingError && e.details?.[0]?.code === 'EMPTY_COMMUNE_HUBS') {
        ok('EMPTY_COMMUNE_HUBS hint', e.message);
      } else if (e instanceof ShippingError && e.code === 'NOT_FOUND') {
        ok('fake commune', `${e.code}: ${e.message}`);
      } else {
        fail('EMPTY_COMMUNE_HUBS probe', e);
      }
    }
  }

  try {
    const fees = await client.getFees({ toWilayaId: 16, isStopDesk: false });
    ok('getFees(home)', `deliveryFee=${fees.deliveryFee} stopDeskFee=${fees.stopDeskFee ?? '—'} ${fees.currency}`);
  } catch (e) {
    fail('getFees(home)', e);
  }

  try {
    const fees = await client.getFees({ toWilayaId: 16, isStopDesk: true });
    ok('getFees(stopDesk)', `deliveryFee=${fees.deliveryFee} ${fees.currency}`);
  } catch (e) {
    fail('getFees(stopDesk)', e);
  }

  if (doCreate) {
    const communeForCreate = communes[0];
    const orderId = `LIVE-SDK-${Date.now()}`;
    let parcel;
    try {
      parcel = await client.createParcel({
        recipientName: 'SDK Live Test',
        phone: '0550123456',
        address: '12 rue test SDK live — ne pas livrer',
        wilayaId: wilaya.id,
        communeId: communeForCreate.id,
        productName: 'Produit test SDK live',
        price: 1000,
        orderId,
        remark: 'auto-test cancel asap',
      });
      ok('createParcel', `id=${parcel.id} tracking=${parcel.trackingNumber} status=${parcel.status}`);
    } catch (e) {
      fail('createParcel', e);
    }

    try {
      const tracked = await client.track(parcel.trackingNumber);
      ok('track', `status=${tracked.parcel.status} events=${tracked.events.length}`);
    } catch (e) {
      fail('track', e);
    }

    try {
      await client.cancelParcel(parcel.id);
      ok('cancelParcel', parcel.trackingNumber);
    } catch (e) {
      fail('cancelParcel', e);
    }
  } else {
    console.log('\n(skip create/track/cancel — set LIVE_CREATE=1 to exercise write path)');
  }

  console.log('\nAll live checks passed.');
}

main().catch(() => process.exit(1));
