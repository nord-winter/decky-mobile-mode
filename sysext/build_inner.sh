#!/bin/bash
# Runs INSIDE the Docker container. Do not call directly.
set -euo pipefail

PLASMA_VERSION="${PLASMA_VERSION:-6.4.3}"
SYSEXT_NAME="plasma-mobile"
STAGING="/staging"
OUTPUT="/output"

mkdir -p "$STAGING" "$OUTPUT"

echo "=== Building plasma-mobile ${PLASMA_VERSION} ==="
echo "=== Qt version: $(qmake6 -query QT_VERSION 2>/dev/null || echo unknown) ==="

cd /build
if [ ! -f "plasma-mobile-${PLASMA_VERSION}.tar.xz" ]; then
    wget -q "https://download.kde.org/stable/plasma/${PLASMA_VERSION}/plasma-mobile-${PLASMA_VERSION}.tar.xz"
fi
if [ ! -d "plasma-mobile-${PLASMA_VERSION}" ]; then
    tar xf "plasma-mobile-${PLASMA_VERSION}.tar.xz"
fi

cd "plasma-mobile-${PLASMA_VERSION}"

# Patch 1: prepareutil.cpp — isPrimary() removed from newer libkscreen.
PREPAREUTIL="initialstart/modules/prepare/prepareutil.cpp"
if grep -q "isPrimary" "$PREPAREUTIL"; then
    echo "=== Patching: removing isPrimary() ==="
    sed -i 's/if (output->isPrimary()) {/\/\/ isPrimary() removed — use last output/' "$PREPAREUTIL"
    sed -i '/\/\/ isPrimary() removed/{ n; s/.*break.*//; }' "$PREPAREUTIL"
fi

# Patch 2: skip kwin/ subdirectory — internal KWin API changes.
CMAKE_LISTS="CMakeLists.txt"
if grep -q "^add_subdirectory(kwin)" "$CMAKE_LISTS"; then
    echo "=== Patching: disabling kwin subdirectory ==="
    sed -i 's/^add_subdirectory(kwin)/# add_subdirectory(kwin)/' "$CMAKE_LISTS"
fi

rm -rf build && mkdir build && cd build

echo "=== cmake ==="
PATH="/usr/lib/qt6/bin:$PATH" cmake .. \
    -DCMAKE_INSTALL_PREFIX=/usr \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_TESTING=OFF \
    -DCMAKE_FIND_PACKAGE_PREFER_CONFIG=ON

echo "=== make ($(nproc) cores) ==="
make -j"$(nproc)"

echo "=== install to staging ==="
rm -rf "$STAGING" && mkdir -p "$STAGING"
DESTDIR="$STAGING" make install

echo "=== sysext extension-release ==="
mkdir -p "$STAGING/usr/lib/extension-release.d"
echo "ID=_any" > "$STAGING/usr/lib/extension-release.d/extension-release.${SYSEXT_NAME}"

echo "=== mksquashfs ==="
mksquashfs "$STAGING" "$OUTPUT/${SYSEXT_NAME}.raw" \
    -comp zstd -Xcompression-level 19 -noappend -quiet

echo "=== Done: $(du -sh "$OUTPUT/${SYSEXT_NAME}.raw" | cut -f1) ==="
