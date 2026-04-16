#!/bin/bash
# Build plasma-mobile as a systemd-sysext image.
#
# WHY DOCKER:
#   Qt plugins are NOT binary compatible across minor versions.
#   SteamOS 3.8.2 has Qt 6.9.1. Arch Linux (dev machine) has Qt 6.11+.
#   A plugin built with Qt 6.11 refuses to load on Qt 6.9 with:
#     "uses incompatible Qt library. (6.11.0)"
#   Docker with an Arch archive snapshot pins Qt to 6.9.x.
#
# Usage:
#   ./sysext/build.sh           # build image + run container
#   ./sysext/build.sh nobuild   # skip docker build, just run container
#
# Output: sysext/output/plasma-mobile.raw

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT="${SCRIPT_DIR}/output"
DOCKER_IMAGE="plasma-mobile-builder"
PLASMA_VERSION="${PLASMA_VERSION:-6.4.3}"

mkdir -p "$OUTPUT"

if [ "${1:-}" != "nobuild" ]; then
    echo "=== Building Docker image (Arch + Qt 6.9.x) ==="
    docker build -t "$DOCKER_IMAGE" "$SCRIPT_DIR"
fi

echo "=== Running build container ==="
docker run --rm \
    -v "$OUTPUT:/output" \
    -e PLASMA_VERSION="$PLASMA_VERSION" \
    "$DOCKER_IMAGE" \
    bash /build/build_inner.sh

echo "=== Done: output/plasma-mobile.raw ==="
du -sh "$OUTPUT/plasma-mobile.raw"
