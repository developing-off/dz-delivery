#!/usr/bin/env node
// Generates the Open Graph images (1200×630) shown when a site page is shared.
// One image per page and language, written to assets/og/<key>.png.
// The FR home page keeps assets/og.png.
//
// Requires Node.js ≥ 18 and a local Chrome/Chromium (no npm dependencies):
//   node scripts/og/generate.mjs                  # all images
//   node scripts/og/generate.mjs yalidine en-php  # only these keys
// Set CHROME=/path/to/chrome if it is not found automatically.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(root, 'assets', 'og');

const carriers = [
  { slug: 'yalidine', name: 'Yalidine', fr: 'GuepEx inclus', en: 'GuepEx included' },
  { slug: 'zrexpress', name: 'ZR Express', fr: 'Étiquettes, envoi en masse, webhooks', en: 'Labels, bulk shipping, webhooks' },
  { slug: 'maystro', name: 'Maystro', fr: 'Commandes, frais, points relais', en: 'Orders, fees, pickup points' },
  { slug: 'ecotrack', name: 'Ecotrack', fr: 'DHD · Anderson · World Express…', en: 'DHD · Anderson · World Express…' },
  { slug: 'noest', name: 'NoEST', fr: 'Commandes, suivi, stations', en: 'Orders, tracking, stations' },
  { slug: 'ecom', name: 'E-com Delivery', fr: 'Colis, suivi, stop desks', en: 'Parcels, tracking, stop desks' },
  { slug: 'mdm', name: 'MDM Express', fr: 'Expédition depuis le stock MDM', en: 'Ship from MDM fulfilment stock' },
  { slug: 'elogistia', name: 'Elogistia', fr: 'Colis, suivi, tarifs', en: 'Parcels, tracking, fees' },
];

const images = [];
for (const c of carriers) {
  images.push({
    key: c.slug,
    lang: 'fr',
    eyebrow: 'dz-delivery · SDK open source',
    title: `API ${c.name}`,
    subtitle: 'Node.js & PHP',
    tagline: `Créer, suivre et tarifer des colis · ${c.fr}`,
    logo: `assets/logos/${c.slug}.png`,
  });
  images.push({
    key: `en-${c.slug}`,
    lang: 'en',
    eyebrow: 'dz-delivery · open source SDK',
    title: `${c.name} API`,
    subtitle: 'Node.js & PHP',
    tagline: `Create, track and price parcels · ${c.en}`,
    logo: `assets/logos/${c.slug}.png`,
  });
}
images.push(
  {
    key: 'en-home',
    lang: 'en',
    eyebrow: 'Open source SDK · TypeScript & PHP',
    title: 'dz-delivery',
    subtitle: 'Algeria delivery SDK',
    tagline: 'Yalidine · GuepEx · ZR Express · Maystro · Ecotrack · DHD · NoEST · E-com · MDM · Elogistia',
  },
  {
    key: 'php',
    lang: 'fr',
    eyebrow: 'dz-delivery · guide',
    title: 'Livraison en PHP',
    subtitle: 'Laravel · Composer',
    tagline: 'Yalidine, ZR Express, Maystro, Ecotrack… une seule API',
  },
  {
    key: 'en-php',
    lang: 'en',
    eyebrow: 'dz-delivery · guide',
    title: 'Delivery in PHP',
    subtitle: 'Laravel · Composer',
    tagline: 'Yalidine, ZR Express, Maystro, Ecotrack… one API',
  },
  {
    key: 'statuts',
    lang: 'fr',
    eyebrow: 'dz-delivery · référence',
    title: 'Statuts de colis',
    subtitle: 'Un modèle unifié',
    tagline: 'pending · created · in_transit · delivered · returned · cancelled · unknown',
  },
  {
    key: 'en-statuses',
    lang: 'en',
    eyebrow: 'dz-delivery · reference',
    title: 'Parcel statuses',
    subtitle: 'One unified model',
    tagline: 'pending · created · in_transit · delivered · returned · cancelled · unknown',
  },
);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function page(img) {
  const textWidth = img.logo ? 620 : 1040;
  // Keep the title on one line, left of the logo / route line: shrink it for long names.
  const titleSize = Math.max(64, Math.min(124, Math.floor(620 / (img.title.length * 0.6))));
  const logo = img.logo
    ? `<img class="logo" src="${pathToFileURL(join(root, img.logo)).href}" alt="" />`
    : '';
  // Route line: under the logo card, or top right when there is no logo.
  const route = img.logo
    ? { top: 300, width: 360, height: 130, d: 'M10 115 C80 80, 130 30, 190 50 S290 110, 350 15', a: [10, 115], b: [190, 50], c: [350, 15] }
    : { top: 60, width: 380, height: 190, d: 'M10 175 C90 130, 140 60, 210 80 S320 150, 370 15', a: [10, 175], b: [210, 80], c: [370, 15] };
  return `<!doctype html>
<html lang="${img.lang}"><head><meta charset="utf-8" />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700&family=IBM+Plex+Mono:wght@400;500&family=Source+Sans+3:wght@400;500&display=swap" rel="stylesheet" />
<style>
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 1200px; height: 630px; overflow: hidden; }
  body {
    position: relative;
    background:
      radial-gradient(700px 360px at 0% 0%, #e7efe8 0%, transparent 60%),
      linear-gradient(#e9ece6 1px, transparent 1px) 0 0 / 40px 40px,
      linear-gradient(90deg, #e9ece6 1px, transparent 1px) 0 0 / 40px 40px,
      #f4f5f2;
    color: #14181c;
    font-family: "Source Sans 3", system-ui, sans-serif;
  }
  .text { position: absolute; left: 80px; top: 92px; width: ${textWidth}px; }
  .eyebrow { font: 500 22px "IBM Plex Mono", monospace; letter-spacing: 0.12em; text-transform: uppercase; color: #6b757c; }
  h1 { margin-top: 18px; font: 700 ${titleSize}px/1.05 "Archivo", sans-serif; letter-spacing: -0.035em; white-space: nowrap; }
  .subtitle { margin-top: 14px; font: 700 44px "Archivo", sans-serif; letter-spacing: -0.02em; color: #0f3f2c; }
  .tagline { margin-top: 20px; font-size: 30px; line-height: 1.3; color: #3d474f; }
  .chips { position: absolute; left: 80px; bottom: 76px; display: flex; gap: 16px; }
  .chip { font: 400 24px "IBM Plex Mono", monospace; background: #fff; border: 1px solid #d8ddd6; border-radius: 8px; padding: 12px 18px; }
  .logo { position: absolute; right: 80px; top: 110px; width: 360px; height: auto; border-radius: 18px; box-shadow: 0 10px 30px rgba(20, 24, 28, 0.08); }
  svg { position: absolute; right: 70px; top: ${route.top}px; }
  path { fill: none; stroke: #8fb9a3; stroke-width: 3; stroke-dasharray: 9 9; stroke-linecap: round; }
</style></head>
<body>
  <div class="text">
    <div class="eyebrow">${esc(img.eyebrow)}</div>
    <h1>${esc(img.title)}</h1>
    <div class="subtitle">${esc(img.subtitle)}</div>
    <div class="tagline">${esc(img.tagline)}</div>
  </div>
  ${logo}
  <svg width="${route.width}" height="${route.height}" viewBox="0 0 ${route.width} ${route.height}">
    <path d="${route.d}" />
    <circle cx="${route.a[0]}" cy="${route.a[1]}" r="7" fill="#4f8f6f" />
    <circle cx="${route.b[0]}" cy="${route.b[1]}" r="7" fill="#4f8f6f" />
    <circle cx="${route.c[0]}" cy="${route.c[1]}" r="9" fill="#1a6b4a" />
  </svg>
  <div class="chips">
    <div class="chip">npm i @dz-delivery/core</div>
    <div class="chip">composer require dz-delivery/sdk</div>
  </div>
</body></html>`;
}

function findChrome() {
  const candidates = [
    process.env.CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Chrome not found: set the CHROME environment variable.');
  return found;
}

const only = new Set(process.argv.slice(2));
const unknown = [...only].filter((key) => !images.some((img) => img.key === key));
if (unknown.length) throw new Error(`Unknown key(s): ${unknown.join(', ')}`);
const selected = images.filter((img) => only.size === 0 || only.has(img.key));

const chrome = findChrome();
const tmp = mkdtempSync(join(tmpdir(), 'dz-og-'));
mkdirSync(outDir, { recursive: true });
try {
  for (const img of selected) {
    const html = join(tmp, `${img.key}.html`);
    const out = join(outDir, `${img.key}.png`);
    writeFileSync(html, page(img));
    execFileSync(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--window-size=1200,630',
      '--virtual-time-budget=8000',
      `--user-data-dir=${join(tmp, 'profile')}`,
      `--screenshot=${out}`,
      pathToFileURL(html).href,
    ], { stdio: 'ignore' });
    console.log(`assets/og/${img.key}.png`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
