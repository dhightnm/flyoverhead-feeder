#!/usr/bin/env bash
# Build a production dist tarball for the current (or requested) CPU arch.
# Output: feeder/dist/fly-overhead-feeder-<version>-<arch>.tar.gz
#   (contains dist/, node_modules/, package.json at archive root)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
ARCH="${1:-}"
if [[ -z "$ARCH" ]]; then
  machine="$(uname -m)"
  case "$machine" in
    x86_64|amd64) ARCH="linux-amd64" ;;
    aarch64|arm64) ARCH="linux-arm64" ;;
    armv7l|armv6l) ARCH="linux-armv7l" ;;
    *) ARCH="linux-${machine}" ;;
  esac
fi

OUT_DIR="$ROOT/dist"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

echo "==> fly-overhead-feeder ${VERSION} (${ARCH})"
npm ci --no-audit --no-fund
npm run build
npm prune --omit=dev

cp -a dist node_modules package.json "$STAGING/"

mkdir -p "$OUT_DIR"
artifact="$OUT_DIR/fly-overhead-feeder-${VERSION}-${ARCH}.tar.gz"
tar -czf "$artifact" -C "$STAGING" dist node_modules package.json
cp -f "$artifact" "$OUT_DIR/${ARCH}.tar.gz"

echo "    wrote ${artifact}"
echo "    alias ${OUT_DIR}/${ARCH}.tar.gz"
