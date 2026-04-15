# Changelog

All notable changes to Mobile Mode are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) · Versioning: [SemVer](https://semver.org/)

---

## [Unreleased]

### Added
- Power Menu patch — "Switch to Mobile" button injected at runtime
  - Update-resistant: components identified by content strings, no hardcoded webpack IDs
  - Captures Power Menu component (`ne`) via `showContextMenu` intercept on first open
  - Injects button into the same Fragment as "Switch to Desktop" (`feature=16`)
- QAM panel — `ToggleField` showing current mode, error display, status hint
- Python backend
  - `enable_mobile()` — installs session files, calls `steamosctl switch-to-desktop-mode`
  - `disable_mobile()` — calls `steamosctl switch-to-game-mode`
  - `get_status()` — reads persistent state file
  - Session files reinstalled on every plugin load (survives SteamOS updates)
  - State persisted at `~/.config/mobile-mode/active_mode`
- Asset files: `mobile.desktop`, `startplasma-mobile.sh`, `mobile-mode-init.sh`
- "Return to Gaming" — `return-to-gaming.desktop` + script for KDE

### Research (Phase 1, verified on SteamOS 3.8.2 Apr 2026)
- `plasma-dbus-run-session-if-needed` required in `Exec=` — bare `startplasma-wayland` breaks the dbus session
- Screen rotation: `kscreen-doctor output.eDP-1.rotation.right` + `qdbus org.kde.KWin /KWin reconfigure`
- Maliit 2.3.1 pre-installed in SteamOS, activated via `QT_IM_MODULE=maliit`
- `steamosctl` supports custom `.desktop` files in `/usr/share/wayland-sessions/`
- Power Menu is a context menu (`showContextMenu`, module 31084)
- Power Menu component is not exported from its webpack module — captured at runtime

---

## [0.0.1] — 2026-04-15

### Added
- Repository initialised from decky-plugin-template
- Design document `SteamDeck_MobileMode_v0.3.docx`
