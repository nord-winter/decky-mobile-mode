#!/bin/bash
# return-to-gaming.sh
# Restore landscape orientation and switch back to Gaming Mode.

LOG="$HOME/.config/mobile-mode/session.log"
echo "=== Returning to Gaming Mode: $(date) ===" >> "$LOG"

# Restore landscape orientation before leaving the session
kscreen-doctor output.eDP-1.rotation.none
qdbus org.kde.KWin /KWin reconfigure

echo "Screen restored to landscape" >> "$LOG"

# Switch back to Gaming Mode
steamosctl switch-to-game-mode
