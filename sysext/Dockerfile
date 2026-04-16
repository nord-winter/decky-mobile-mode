FROM archlinux:latest

# WHY THIS APPROACH:
# - Qt plugins are NOT loadable across minor versions (KCoreAddons strict check).
# - SteamOS 3.8.2 has Qt 6.9.1. Building with Qt 6.11 produces plugins that fail
#   on device with: "uses incompatible Qt library. (6.11.0)"
# - We install everything normally (latest), then downgrade ONLY Qt to 6.9.1 using
#   the Arch Linux archive. This avoids the gcc-libs split conflict that arises when
#   trying to pin the entire Arch snapshot to 2025.

ARG QT_ARCHIVE=https://archive.archlinux.org/packages

# Base update
RUN pacman -Syu --noconfirm

# Build tools
RUN pacman -S --noconfirm --needed \
    base-devel cmake git wget squashfs-tools python

# Qt6 — install latest first so dependency metadata is satisfied
RUN pacman -S --noconfirm --needed \
    qt6-base qt6-declarative qt6-wayland qt6-multimedia \
    qt6-sensors qt6-svg qt6-tools qt6-5compat

# Downgrade Qt6 to 6.9.1-x to match SteamOS ABI.
# Qt 6.9.1 was built against ICU 76.x; also downgrade ICU.
# All packages installed together so pacman resolves inter-dependencies in one shot.
RUN pacman -U --noconfirm --overwrite '*' \
    "${QT_ARCHIVE}/i/icu/icu-76.1-1-x86_64.pkg.tar.zst" \
    "${QT_ARCHIVE}/q/qt6-base/qt6-base-6.9.1-5-x86_64.pkg.tar.zst" \
    "${QT_ARCHIVE}/q/qt6-declarative/qt6-declarative-6.9.1-3-x86_64.pkg.tar.zst" \
    "${QT_ARCHIVE}/q/qt6-wayland/qt6-wayland-6.9.1-1-x86_64.pkg.tar.zst" \
    "${QT_ARCHIVE}/q/qt6-multimedia/qt6-multimedia-6.9.1-1-x86_64.pkg.tar.zst" \
    "${QT_ARCHIVE}/q/qt6-sensors/qt6-sensors-6.9.1-1-x86_64.pkg.tar.zst" \
    "${QT_ARCHIVE}/q/qt6-svg/qt6-svg-6.9.1-1-x86_64.pkg.tar.zst" \
    "${QT_ARCHIVE}/q/qt6-tools/qt6-tools-6.9.1-2-x86_64.pkg.tar.zst" \
    "${QT_ARCHIVE}/q/qt6-5compat/qt6-5compat-6.9.1-1-x86_64.pkg.tar.zst"

# KDE Frameworks 6 (latest — these don't affect Qt ABI check)
RUN pacman -S --noconfirm --needed \
    extra-cmake-modules \
    kcoreaddons ki18n kconfig kdbusaddons kglobalaccel kguiaddons \
    kiconthemes kirigami kio knotifications kservice kwayland \
    kwidgetsaddons kwindowsystem plasma5support solid kstatusnotifieritem

# KDE Plasma runtime + dev headers
RUN pacman -S --noconfirm --needed \
    kwin plasma-workspace plasma-desktop layer-shell-qt kpipewire \
    milou plasma-nm plasma-pa powerdevil bluez-qt modemmanager-qt \
    qqc2-breeze-style breeze breeze-icons

# Sanity check: confirm Qt 6.9.1
RUN /usr/lib/qt6/bin/qtpaths6 --query QT_VERSION

WORKDIR /build
COPY build_inner.sh /build/build_inner.sh
