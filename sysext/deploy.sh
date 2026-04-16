#!/bin/bash
# Deploy and test plasma-mobile sysext on the Steam Deck.
# Run from dev machine after build.sh produces output/plasma-mobile.raw.
#
# Usage:
#   ./sysext/deploy.sh [deck@ip]
#
# Requires: ssh key auth to the deck

set -euo pipefail

DECK="${1:-deck@steamdeck.local}"
SYSEXT="sysext/output/plasma-mobile.raw"
REMOTE_PATH="/var/lib/extensions/plasma-mobile.raw"

if [ ! -f "$SYSEXT" ]; then
    echo "ERROR: $SYSEXT not found — run build first"
    exit 1
fi

echo "=== Deploying to $DECK ==="
scp "$SYSEXT" "$DECK:/tmp/plasma-mobile.raw"
ssh -t "$DECK" "sudo mv /tmp/plasma-mobile.raw $REMOTE_PATH"

echo "=== Activating sysext ==="
ssh -t "$DECK" "sudo systemd-sysext merge"
ssh "$DECK" "systemd-sysext status"

echo "=== Checking plasma-mobile shell is visible ==="
ssh "$DECK" "ls /usr/share/plasma/shells/org.kde.plasma.mobileshell/ 2>/dev/null && echo 'Shell QML: OK' || echo 'Shell QML: NOT FOUND'"

echo "=== Done — test by running: ==="
echo "  ssh $DECK 'PLASMA_DEBUG=1 plasmashell --shell org.kde.plasma.mobileshell 2>&1 | head -50'"
