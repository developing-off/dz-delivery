#!/bin/sh
# Builds the public documentation site into _site/ (Cloudflare Pages output directory).
#
# Only the site files are published: the home page, 404.html, one folder per carrier page,
# assets/ and _headers. robots.txt and sitemap.xml are generated here, with each
# page's <lastmod> taken from the date of the last commit that touched it.
#
# Cloudflare Pages settings: build command `sh scripts/build-site.sh`, output `_site`.
set -eu

cd "$(dirname "$0")/.."

SITE_URL="${SITE_URL:-https://dz-delivery.younes-sarni.com}"
SITE_URL="${SITE_URL%/}"
# Origin only (scheme + host[:port]): it is concatenated into URLs and written
# unescaped into sitemap.xml.
case "$SITE_URL" in
  http://*|https://*) ;;
  *) echo "build-site: SITE_URL must start with http:// or https:// (got '$SITE_URL')" >&2; exit 1 ;;
esac
case "${SITE_URL#*://}" in
  ''|*/*|*'?'*|*'#'*|*'&'*|*'<'*|*'>'*|*'"'*|*"'"*|*' '*)
    echo "build-site: SITE_URL must be an origin like https://example.com (got '$SITE_URL')" >&2; exit 1 ;;
esac
OUT=_site

# Every top-level folder holding an index.html is a carrier page.
PAGES=""
for f in */index.html; do
  dir="${f%/index.html}"
  [ "$dir" = "$OUT" ] && continue
  PAGES="$PAGES $dir"
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
cp index.html 404.html _headers "$OUT/"
cp -R assets "$OUT/"
for p in $PAGES; do
  mkdir -p "$OUT/$p"
  cp "$p/index.html" "$OUT/$p/"
done

cat > "$OUT/robots.txt" <<EOF
User-agent: *
Allow: /

Sitemap: $SITE_URL/sitemap.xml
EOF

{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
  echo "  <url><loc>$SITE_URL/</loc><lastmod>$(lastmod index.html)</lastmod></url>"
  for p in $PAGES; do
    echo "  <url><loc>$SITE_URL/$p/</loc><lastmod>$(lastmod "$p/index.html")</lastmod></url>"
  done
  echo '</urlset>'
} > "$OUT/sitemap.xml"

echo "build-site: $(echo $PAGES | wc -w | tr -d ' ') carrier pages -> $OUT/ ($SITE_URL)"
