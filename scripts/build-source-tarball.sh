#!/usr/bin/env bash
# Source-only tarball (Pi fallback when no prebuilt matches).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${REPO}/feeder/dist/feeder-source.tar.gz"
mkdir -p "$(dirname "$OUT")"
tar --exclude='feeder/node_modules' --exclude='feeder/dist' \
  -czf "$OUT" -C "$REPO" feeder
echo "    wrote ${OUT}"
