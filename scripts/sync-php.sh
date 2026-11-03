#!/usr/bin/env bash
# Mirror the PHP package from this monorepo into a checkout of dz-delivery-php.
#
#   scripts/sync-php.sh <monorepo-dir> <dz-delivery-php-dir>
#
# The split repo is packages/php plus the shared docs its tests and README need:
#   packages/php/*            → ./      (except .gitattributes: the split keeps its own,
#                                        which also export-ignores /docs)
#   docs/fixtures/            → docs/fixtures/
#   docs/{CONTRACT,PROVIDERS,guide-php,ZREXPRESS}.md → docs/
#
# Only git-tracked files are copied (never docs/vendor/, .env, vendor/).
# Files tracked in the split but gone from the monorepo are removed with `git rm`.
# Nothing is committed: review with `git -C <split> status`, then commit.
set -euo pipefail

usage="usage: $0 <monorepo-dir> <dz-delivery-php-dir>"
src="$(cd "${1:?$usage}" && pwd)"
dst="$(cd "${2:?$usage}" && pwd)"

[ -d "$src/packages/php" ] || { echo "error: $src is not the monorepo" >&2; exit 1; }
[ -f "$dst/composer.json" ] && git -C "$dst" rev-parse --git-dir >/dev/null 2>&1 \
  || { echo "error: $dst is not a dz-delivery-php checkout" >&2; exit 1; }

shared_docs=(docs/CONTRACT.md docs/PROVIDERS.md docs/guide-php.md docs/ZREXPRESS.md docs/fixtures)

php_files() { git -C "$src/packages/php" ls-files | grep -vx '.gitattributes'; }
doc_files() { git -C "$src" ls-files -- "${shared_docs[@]}"; }

# Copy (tar keeps it fast with thousands of fixtures).
php_files | tar -C "$src/packages/php" -T - -cf - | tar -C "$dst" -xf -
doc_files | tar -C "$src" -T - -cf - | tar -C "$dst" -xf -

# Remove what the monorepo no longer has.
expected="$(mktemp)"; tracked="$(mktemp)"
trap 'rm -f "$expected" "$tracked"' EXIT
{ php_files; doc_files; echo .gitattributes; } | LC_ALL=C sort -u >"$expected"
git -C "$dst" ls-files | LC_ALL=C sort -u >"$tracked"
LC_ALL=C comm -13 "$expected" "$tracked" | while IFS= read -r f; do
  git -C "$dst" rm -q -- "$f"
  echo "removed: $f"
done

git -C "$dst" add -A
git -C "$dst" status --short
