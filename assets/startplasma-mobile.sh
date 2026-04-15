#!/bin/bash
# startplasma-mobile.sh
# Wrapper for KDE Mobile session on Steam Deck.
# Must be launched via plasma-dbus-run-session-if-needed — without it
# the dbus session is not initialised correctly.

LOG="$HOME/.config/mobile-mode/session.log"
mkdir -p "$(dirname "$LOG")"
echo "=== Mobile Mode start: $(date) ===" >> "$LOG"

# Maliit virtual keyboard as input method
export QT_IM_MODULE=maliit
export MALIIT_SERVER_ARGUMENTS="--overridePlatformPlugins maliit"

echo "Starting KDE Wayland session..." >> "$LOG"
exec /usr/lib/plasma-dbus-run-session-if-needed /usr/bin/startplasma-wayland
