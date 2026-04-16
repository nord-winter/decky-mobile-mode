#!/bin/bash
# return-to-gaming.sh
# Restore landscape orientation and switch back to Gaming Mode.

LOG="$HOME/.config/mobile-mode/session.log"
echo "=== Returning to Gaming Mode: $(date) ===" >> "$LOG"

# Restore landscape orientation before leaving the session.
# The panel is physically portrait (800×1280); KWin default is rotation.right (landscape).
# We applied rotation.none on entry — restore rotation.right before switching back.
kscreen-doctor output.eDP-1.rotation.right
qdbus org.kde.KWin /KWin reconfigure

echo "Screen restored to landscape" >> "$LOG"

# Switch back to Gaming Mode
steamosctl switch-to-game-mode
