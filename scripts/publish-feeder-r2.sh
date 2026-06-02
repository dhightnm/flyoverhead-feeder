#!/usr/bin/env bash
# Upload feeder dist tarballs + manifest to the R2 "feeder" bucket.
#
# Required env:
#   R2_ENDPOINT, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
# Optional:
#   FEEDER_R2_BUCKET (default: feeder)
#   FEEDER_R2_PREFIX   (default: empty — objects at bucket root)
#
# Usage (from repo root, after building tarballs):
#   feeder/scripts/build-dist-tarball.sh linux-amd64
#   feeder/scripts/build-dist-tarball.sh linux-arm64   # on arm64 host or CI matrix
#   feeder/scripts/build-dist-tarball.sh linux-armv7l
#   feeder/scripts/publish-feeder-r2.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('${ROOT}/package.json').version")"
DIST_DIR="$ROOT/dist"
BUCKET="${FEEDER_R2_BUCKET:-feeder}"
PREFIX="${FEEDER_R2_PREFIX:-}"
PREFIX="${PREFIX#/}"
[[ -n "$PREFIX" ]] && PREFIX="${PREFIX%/}/"

if [[ -z "${R2_ENDPOINT:-}" ]]; then
  echo "R2_ENDPOINT is required" >&2
  exit 1
fi

export AWS_DEFAULT_REGION=auto
export AWS_REGION=auto

aws_cli() {
  aws --endpoint-url "$R2_ENDPOINT" s3 "$@"
}

object_key() {
  local name="$1"
  if [[ -n "$PREFIX" ]]; then
    printf '%s%s' "$PREFIX" "$name"
  else
    printf '%s' "$name"
  fi
}

upload_if_exists() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  echo "==> s3://${BUCKET}/$(object_key "$key")"
  aws_cli cp "$file" "s3://${BUCKET}/$(object_key "$key")" \
    --content-type application/gzip
}

MANIFEST="$(mktemp)"
published_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
archives_json=""
for arch in linux-amd64 linux-arm64 linux-armv7l; do
  file="$DIST_DIR/${arch}.tar.gz"
  [[ -f "$file" ]] || continue
  key="dist/${arch}.tar.gz"
  upload_if_exists "$file" "$key"
  ver_file="$DIST_DIR/fly-overhead-feeder-${VERSION}-${arch}.tar.gz"
  upload_if_exists "$ver_file" "dist/fly-overhead-feeder-${VERSION}-${arch}.tar.gz"
  if [[ -n "$archives_json" ]]; then archives_json+=","; fi
  archives_json+="\"${arch}\":\"dist/${arch}.tar.gz\""
done

cat >"$MANIFEST" <<EOF
{
  "version": "${VERSION}",
  "published_at": "${published_at}",
  "archives": { ${archives_json} },
  "source": "dist/feeder-source.tar.gz"
}
EOF

echo "==> manifest"
aws_cli cp "$MANIFEST" "s3://${BUCKET}/$(object_key "dist/manifest.json")" \
  --content-type application/json

# Source fallback tarball for Pis without a matching prebuild.
src_tgz="${DIST_DIR}/feeder-source.tar.gz"
if [[ ! -f "$src_tgz" ]] && [[ -f "$ROOT/../feeder-source.tar.gz" ]]; then
  src_tgz="$ROOT/../feeder-source.tar.gz"
fi
if [[ -f "$src_tgz" ]]; then
  upload_if_exists "$src_tgz" "dist/feeder-source.tar.gz"
fi

if [[ -f "$ROOT/install.sh" ]]; then
  aws_cli cp "$ROOT/install.sh" "s3://${BUCKET}/$(object_key "install.sh")" \
    --content-type text/plain
fi

rm -f "$MANIFEST"
echo "Done. Public URL: https://feeder.flyoverhead.com (FEEDER_CDN_URL)."
