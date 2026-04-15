#!/bin/bash
# mobile-mode-init.sh
# KDE autostart script — runs after KWin is up.
# Applies screen rotation and starts Maliit keyboard daemon.

LOG="$HOME/.config/mobile-mode/session.log"
echo "Autostart: applying mobile settings at $(date)..." >> "$LOG"

# Ensure Wayland env is set — some KDE autostart paths don't inherit all vars.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
export QT_QPA_PLATFORM=wayland
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

echo "Env: XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR WAYLAND_DISPLAY=$WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS" >> "$LOG"

# Wait for KWin to be fully ready on D-Bus (up to 30 s)
for i in $(seq 1 30); do
    if qdbus org.kde.KWin /KWin 2>/dev/null | grep -q "reconfigure"; then
        echo "KWin ready after ${i}s" >> "$LOG"
        break
    fi
    sleep 1
done

# Remove the default Right rotation so the physical 800×1280 panel shows portrait.
# The Steam Deck panel is natively portrait (800×1280); KWin applies rotation.right
# by default to produce landscape (1280×800). rotation.none = portrait mode.
kscreen-doctor output.eDP-1.rotation.none >> "$LOG" 2>&1
echo "kscreen-doctor rotation exit=$?" >> "$LOG"

# Give kscreen a moment to apply the rotation
sleep 1

# Force KWin to recalculate geometry after rotation
qdbus org.kde.KWin /KWin reconfigure >> "$LOG" 2>&1
echo "qdbus reconfigure exit=$?" >> "$LOG"

echo "Screen rotated to portrait" >> "$LOG"

# Start Maliit virtual keyboard daemon
/usr/lib/maliit-server &
echo "Maliit server started (pid=$!)" >> "$LOG"
