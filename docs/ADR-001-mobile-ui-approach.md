# ADR-001: Mobile UI Approach

**Date:** 2026-04-16  
**Status:** Decided  
**Decider:** xvsim

---

## Context

Mobile Mode needs a touch-optimised UI for the KDE session. The obvious candidate is `plasma-mobile` — KDE's official mobile shell. However, SteamOS has a fundamental constraint: the root filesystem is a read-only squashfs image that gets replaced on every OS update. Any package installed via `pacman` is wiped.

Research was conducted to find a persistent, update-safe approach.

---

## Options Considered

### Option A — Full `plasma-mobile` package
Install `plasma-mobile` via pacman. Provides the complete mobile shell (app grid, gesture navigation, mobile task switcher).

**Rejected.** Wiped on every SteamOS update. Not viable without a persistent install mechanism.

---

### Option B — QML-only (copy shell files to `~/.local`)
Copy QML files from `plasma-mobile` into `~/.local/share/plasma/shells/org.kde.plasma.mobileshell/`. Run `plasmashell --shell org.kde.plasma.mobileshell`.

**Rejected.** The shell requires backend KPlugin factories and D-Bus services (`plasma-workspace`, `plasma-nm`, `powerdevil`, telephony stack) that are not installed. Results in `module "org.kde.plasma.private.mobileshell" is not installed` crashes.

---

### Option C — `/usr/local` overlay + env vars
Install files to `/usr/local/share/plasma/` (persistent via bind-mount from `/var/usrlocal/`). Set `QML2_IMPORT_PATH`, `XDG_DATA_DIRS`, `QT_PLUGIN_PATH`.

**Deferred.** Medium stability — ABI incompatibilities can appear after SteamOS updates since system Qt/KDE libraries change. Viable as a future enhancement if the simpler approach proves insufficient.

---

### Option D — `plasma-phone-components` hybrid
Embed individual QML components from `plasma-phone-components` (KDE/plasma-phone-components on GitHub) as Plasma applets. Provides `FlickContainer`, mobile homescreen, quicktiles without the full phone stack.

**Deferred.** Good stability, no phone-stack dependencies. Requires manual QML integration. Consider as an incremental improvement on top of Option E.

---

### Option E — KDE Desktop tweaks (DECIDED ✅)
Configure standard `plasma-desktop` to be touch-friendly. No additional packages.

**Chosen.** Zero extra dependencies, fully persistent in `~/.config/`, survives SteamOS updates, 90% of the mobile UX benefit.

---

## Decision: Option E — KDE Desktop tweaks

### What this means

The Mobile Mode KDE session starts as a standard `plasma-desktop` session (via `startplasma-wayland`) with a touch-optimised configuration applied at session start:

| Setting | Value | Mechanism |
|---------|-------|-----------|
| Scale | 1.5× | `kscreen-doctor output.eDP-1.scale.1.5` |
| Virtual keyboard | Maliit | `~/.config/kwinrc` → `[Wayland] InputMethod=...` |
| Launcher | Fullscreen Kickoff | `plasma-org.kde.plasma.desktop-appletsrc` |
| Taskbar | Icon-only dock, 96px | `appletsrc` |
| Panels | Hidden / minimal | `appletsrc` |

All config changes are applied at Mobile Mode start and **reverted** when returning to Gaming Mode.

### Why not plasma-mobile

1. SteamOS immutable rootfs — packages get wiped on updates
2. No phone stack (ofono, telephony) — half the shell breaks anyway  
3. Steam Deck controls and Steam overlay don't integrate with plasma-mobile
4. Portrait mode + input is handled by our kscreen/Maliit setup regardless of shell

### Future path

If deeper mobile UX is needed:
1. Try Option D (plasma-phone-components QML) as applets within the desktop session
2. Try Option C (/usr/local overlay) if ABI stability improves or we bundle Qt ourselves
3. Consider a Flatpak-based approach for the shell components

---

## Consequences

- KDE session looks like a modified desktop, not a "true" mobile OS
- All config changes must be cleanly reverted on `disable_mobile()` — any leftover config in `~/.config/` that affects regular Desktop Mode is a bug
- New mobile-specific configs (kwinrc, appletsrc) must be backed up before overwriting and restored on exit
