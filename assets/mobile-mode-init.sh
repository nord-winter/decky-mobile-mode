#!/bin/bash
# mobile-mode-init.sh
# KDE autostart script — runs after KWin is up.
# Applies screen rotation and starts Maliit keyboard daemon.

LOG="$HOME/.config/mobile-mode/session.log"
echo "Autostart: applying mobile settings at $(date)..." >> "$LOG"

# Wait for KWin compositor to be ready
sleep 2

# Rotate built-in display to portrait (right = 90°)
kscreen-doctor output.eDP-1.rotation.right
# Force KWin to recalculate geometry after rotation
qdbus org.kde.KWin /KWin reconfigure
echo "Screen rotated to portrait" >> "$LOG"

# Start Maliit virtual keyboard daemon
/usr/lib/maliit-server &
echo "Maliit server started" >> "$LOG"
