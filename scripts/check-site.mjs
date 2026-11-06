#!/usr/bin/env node
// Checks the built site in _site/ (run scripts/build-site.sh first):
// - each page's canonical URL is its own URL,
// - each page has exactly the fr, en and x-default alternates, pointing to
//   built pages and reciprocal,
// - og:image / twitter:image files exist,
// - relative links and assets in every HTML file (404.html included) resolve
//   to files in the build.
// Exits with code 1 and lists the problems if anything is wrong.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';

const site = (process.env.SITE_URL || 'https://dz-delivery.younes-sarni.com').replace(/\/$/, '');
const out = resolve(process.argv[2] || '_site');
const problems = [];

function walk(dir, rel = '') {
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    return statSync(abs).isDirectory() ? walk(abs, r) : [r];
  });
}

const files = walk(out);
const isFile = (rel) => existsSync(join(out, rel)) && statSync(join(out, rel)).isFile();
const pages = files.filter((f) => f.endsWith('index.html'));
const htmlFiles = files.filter((f) => f.endsWith('.html'));
const LANGS = ['en', 'fr', 'x-default'];
const urlOf = (f) => `${site}/${f.slice(0, -'index.html'.length)}`;
const fileOf = (url) => {
  if (!url.startsWith(`${site}/`)) return null;
  const path = url.slice(site.length + 1).split('#')[0].split('?')[0];
  return path === '' || path.endsWith('/') ? `${path}index.html` : path;
};
const attr = (tag, name) => (tag.match(new RegExp(`\\s${name}="([^"]*)"`)) || [])[1];

const alternates = new Map();
for (const page of pages) {
  const html = readFileSync(join(out, page), 'utf8');
  const own = urlOf(page);

  const canonical = (html.match(/<link rel="canonical"[^>]*>/) || [])[0];
  if (!canonical) problems.push(`${page}: no canonical`);
  else if (attr(canonical, 'href') !== own) problems.push(`${page}: canonical ${attr(canonical, 'href')} ≠ ${own}`);

  const alts = {};
  for (const tag of html.match(/<link rel="alternate" hreflang[^>]*>/g) || []) {
    alts[attr(tag, 'hreflang')] = attr(tag, 'href');
  }
  alternates.set(own, alts);
  const langs = Object.keys(alts).sort();
  if (langs.join(',') !== LANGS.join(',')) {
    problems.push(`${page}: hreflang must be exactly ${LANGS.join(', ')} (found: ${langs.join(', ') || 'none'})`);
  }
  if (langs.length && !Object.values(alts).includes(own)) {
    problems.push(`${page}: hreflang alternates do not include the page itself`);
  }
  for (const [lang, href] of Object.entries(alts)) {
    const f = fileOf(href);
    if (!f || !pages.includes(f)) problems.push(`${page}: hreflang ${lang} → not a built page: ${href}`);
  }

  for (const tag of html.match(/<meta (property="og:image"|name="twitter:image")[^>]*>/g) || []) {
    const f = fileOf(attr(tag, 'content') || '');
    if (!f || !files.includes(f)) problems.push(`${page}: image not in build: ${attr(tag, 'content')}`);
  }

}

for (const file of htmlFiles) {
  const html = readFileSync(join(out, file), 'utf8');
  const base = posix.dirname(`/${file}`);
  for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const link = m[1];
    if (/^(?:[a-z]+:|\/\/|#|data:)/i.test(link)) continue;
    const clean = link.split('#')[0].split('?')[0];
    // posix.resolve drops the trailing slash: a folder link ("../yalidine/", "./", "..") means its index.html.
    const isDir = /(^|\/)\.{0,2}$/.test(clean);
    const path = posix.resolve(base, clean);
    const target = (isDir ? posix.join(path, 'index.html') : path).replace(/^\//, '');
    if (!isFile(target)) problems.push(`${file}: broken link ${link}`);
  }
}

for (const [url, alts] of alternates) {
  for (const [lang, href] of Object.entries(alts)) {
    if (lang === 'x-default' || href === url) continue;
    const back = alternates.get(href);
    if (back && !Object.values(back).includes(url)) problems.push(`${href}: no hreflang back to ${url}`);
  }
}

if (problems.length) {
  console.error(`check-site: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`- ${p}`);
  process.exit(1);
}
console.log(`check-site: ${pages.length} pages OK`);
