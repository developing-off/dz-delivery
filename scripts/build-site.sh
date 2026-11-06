#!/bin/sh
# Builds the public documentation site into _site/ (Cloudflare Pages output directory).
#
# Only the site files are published: the home page, 404.html, one folder per page
# (carriers, guides, and their English versions under en/), assets/ and _headers.
# robots.txt and sitemap.xml are generated here, with each page's <lastmod> taken
# from the date of the last commit that touched it.
#
# Cloudflare Pages settings: build command `sh scripts/build-site.sh`, output `_site`.
set -eu

cd "$(dirname "$0")/.."

# Production origin, as written in the pages' hreflang links.
PROD_URL=https://dz-delivery.younes-sarni.com
SITE_URL="${SITE_URL:-$PROD_URL}"
SITE_URL="${SITE_URL%/}"
# Origin only (scheme + host[:port]): it is concatenated into URLs, written
# unescaped into sitemap.xml and used as a sed replacement.
case "$SITE_URL" in
  http://*|https://*) ;;
  *) echo "build-site: SITE_URL must start with http:// or https:// (got '$SITE_URL')" >&2; exit 1 ;;
esac
case "${SITE_URL#*://}" in
  ''|*/*|*'?'*|*'#'*|*'&'*|*'<'*|*'>'*|*'"'*|*"'"*|*' '*|*'\'*|*[[:cntrl:]]*)
    echo "build-site: SITE_URL must be an origin like https://example.com (got '$SITE_URL')" >&2; exit 1 ;;
esac
OUT=_site

# Pages: the home page, every top-level folder holding an index.html (carriers,
# guides) and the same one level below en/ (English version).
FILES=""
for f in index.html */index.html en/*/index.html; do
  [ -f "$f" ] || continue
  case "$f" in "$OUT"/*) continue ;; esac
  FILES="$FILES $f"
done

# Builds may start from a shallow clone; lastmod dates need the history.
if [ "$(git rev-parse --is-shallow-repository 2>/dev/null || echo false)" = "true" ]; then
  git fetch --unshallow --quiet 2>/dev/null \
    || echo "build-site: shallow clone, lastmod dates fall back to the last commit" >&2
fi

lastmod() {
  d="$(git log -1 --format=%cs -- "$1" 2>/dev/null || true)"
  if [ -n "$d" ]; then echo "$d"; else date -u +%F; fi
}

rm -rf "$OUT"
mkdir -p "$OUT"
cp 404.html _headers "$OUT/"
cp -R assets "$OUT/"
for f in $FILES; do
  mkdir -p "$OUT/$(dirname "$f")"
  cp "$f" "$OUT/$f"
done

cat > "$OUT/robots.txt" <<EOF
User-agent: *
Allow: /

Sitemap: $SITE_URL/sitemap.xml
EOF

# Each page lists its language versions with <link rel="alternate" hreflang>;
# the sitemap repeats them so search engines pair the FR and EN pages.
{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">'
  for f in $FILES; do
    echo "  <url>"
    echo "    <loc>$SITE_URL/${f%index.html}</loc>"
    echo "    <lastmod>$(lastmod "$f")</lastmod>"
    sed -n 's#^ *<link rel="alternate" hreflang="\([^"]*\)" href="\([^"]*\)" */>.*#    <xhtml:link rel="alternate" hreflang="\1" href="\2"/>#p' "$f" \
      | sed "s#$PROD_URL/#$SITE_URL/#g"
    echo "  </url>"
  done
  echo '</urlset>'
} > "$OUT/sitemap.xml"

echo "build-site: $(echo $FILES | wc -w | tr -d ' ') pages -> $OUT/ ($SITE_URL)"
