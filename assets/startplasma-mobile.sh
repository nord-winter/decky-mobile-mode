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

# Tell KWin to use Maliit as the Wayland input method.
# Without this KWin ignores the running maliit-server.
KWINRC="$HOME/.config/kwinrc"
if ! grep -q "^\[Wayland\]" "$KWINRC" 2>/dev/null; then
    echo "" >> "$KWINRC"
    echo "[Wayland]" >> "$KWINRC"
fi
# Remove any existing InputMethod line and write fresh
grep -v "^InputMethod=" "$KWINRC" > "${KWINRC}.tmp" && mv "${KWINRC}.tmp" "$KWINRC"
# Insert InputMethod after [Wayland] header
sed -i '/^\[Wayland\]/a InputMethod=/usr/share/applications/com.github.maliit.keyboard.desktop' "$KWINRC"
echo "kwinrc: Maliit InputMethod set" >> "$LOG"

echo "Starting KDE Wayland session..." >> "$LOG"

# Tell plasmashell to use the mobile shell package.
# plasmashell reads ShellPackage from plasmashellrc on startup.
# We write it here so normal Desktop Mode (plasma.desktop) is unaffected.
PLASMASHELLRC="$HOME/.config/plasmashellrc"
kwriteconfig6 --file "$PLASMASHELLRC" --group General --key ShellPackage org.kde.plasma.mobileshell
echo "plasmashellrc: ShellPackage=org.kde.plasma.mobileshell" >> "$LOG"

exec /usr/lib/plasma-dbus-run-session-if-needed /usr/bin/startplasma-wayland
