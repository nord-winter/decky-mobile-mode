# CLAUDE.md — Mobile Mode for Steam Deck

## Project

A Decky Loader plugin that adds a third operating mode to the Steam Deck — **Mobile Mode**. A "Switch to Mobile" button in the Steam Power Menu switches the device into a custom KDE session with portrait orientation and touch-first UI.

**Status:** Phase 0 ✅ Phase 1 ✅ Phase 2 ✅ Phase 3 (portrait rotation working, final verification in progress)

## Architecture

```
Power Menu (Steam) → "Switch to Mobile"
    ↓ Decky Plugin (index.tsx — Power Menu patch)
    ↓ Decky Backend (main.py — runs as root)
        steamosctl set-default-desktop-session mobile.desktop
        (frontend calls SwitchToDesktop() via Steam webpack API)
    ↓ mobile.desktop → startplasma-mobile.sh
        plasma-dbus-run-session-if-needed startplasma-wayland
    ↓ KWin starts → autostart: mobile-mode-init.sh
        kscreen-doctor output.eDP-1.rotation.right
        qdbus org.kde.KWin /KWin reconfigure
        maliit-server
    ↓ KDE in portrait mode
```

Exit: "Return to Gaming" button → `steamosctl switch-to-game-mode`

## Repository layout

```
src/index.tsx              — Frontend: Power Menu patch, QAM panel
main.py                    — Python backend (root): session file management, steamosctl
assets/
  mobile.desktop           — Wayland session descriptor
  startplasma-mobile.sh    — KDE session launcher (sets Maliit env)
  mobile-mode-init.sh      — Autostart: rotation + maliit-server
  return-to-gaming.sh      — Returns to Gaming Mode
  return-to-gaming.desktop — KDE app entry for "Return to Gaming"
plugin.json                — Plugin metadata
```

## Key technical facts (Phase 1, verified on device)

- **Session Exec=**: must use `plasma-dbus-run-session-if-needed /usr/bin/startplasma-wayland` — without it the dbus session does not initialise correctly
- **Rotation**: `kscreen-doctor output.eDP-1.rotation.none` — removes the default Right rotation so the physical 800×1280 panel shows in portrait. The panel is natively portrait; KWin applies `rotation.right` by default to produce landscape. Apply only after KWin is ready (poll D-Bus, not a fixed sleep).
- **Geometry**: recalculated only after `qdbus org.kde.KWin /KWin reconfigure` following rotation
- **Keyboard**: Maliit 2.3.1 is pre-installed in SteamOS, activated via `QT_IM_MODULE=maliit`
- **Session switching**: `steamosctl` (official Valve API), supports custom `.desktop` files from `/usr/local/share/wayland-sessions/`
- **Backend = root**: `"flags": ["root"]` in plugin.json (note: `"_root"` with underscore does NOT work)

## Decky backend — verified facts (Phase 2, on-device)

### Root flag
- `"flags": ["_root"]` — **does NOT work**, backend runs as uid=1000(deck)
- `"flags": ["root"]` — **works**, backend runs as uid=0(root) ✅

### Path pitfall: expanduser("~") as root
- `os.path.expanduser("~")` resolves to `/root/` when uid=0
- All user-space paths must use `decky.DECKY_USER_HOME` (always `/home/deck`) and `decky.DECKY_USER` (always `"deck"`)
- This was the root cause of the blank KDE session: `startplasma-mobile.sh` was installed to `/root/.config/mobile-mode/` but `mobile.desktop` expected it at `/home/deck/.config/mobile-mode/`

### Session file location
- `/usr/share/wayland-sessions/` — read-only squashfs, even with root needs mount remount
- `/usr/local/share/wayland-sessions/` — **writable by root**, persistent (bind-mounted from `/var/usrlocal/`), survives SteamOS updates ✅
- `/var/usrlocal/share/` — the backing store, but `/var/usrlocal/` itself does not exist as a path (only via bind mount)

### D-Bus session bus
- `steamosctl` talks to `steamos-manager` via the **session bus**, not system bus
- When backend runs as root, `DBUS_SESSION_BUS_ADDRESS` is unset → steamosctl fails with `No such file or directory (os error 2)`
- Fix: set `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus` in env before calling steamosctl
- `set-default-desktop-session` also fails even with the correct bus when run directly as root → must use `sudo -u deck --preserve-env=DBUS_SESSION_BUS_ADDRESS steamosctl ...`
- `switch-to-desktop-mode` and `switch-to-game-mode` — when successful, gamescope tears down the session and the subprocess pipe breaks → exit code is non-zero (SIGPIPE / rc=-13 or rc=1), but the switch DID happen. Do NOT use `check=True`.

### Broken pipe = success
When any steamosctl session-switch command succeeds, the current session is destroyed, breaking the subprocess's stdout/stderr pipe. The PluginLoader journal shows `Error: I/O error: Broken pipe (os error 32)`. This is **expected** and means the switch worked.

### SwitchToDesktop from frontend
- `switch-to-desktop-mode` via Python subprocess is unreliable (D-Bus, broken pipe)
- Better: call `SwitchToDesktop({})` from the TypeScript frontend via the Steam webpack API
- Module 90389, export `Bd` (Steam Apr-2026 build) — found via content search for `'SwitchToDesktop'`
- `Bd.SwitchToDesktop({})` is exactly what the native "Switch to Desktop" button calls

## Power Menu — research findings (Phase 2)

Research conducted via CEF DevTools on SteamOS 3.8.2 (Steam build Apr 11 2026).

### Accessing DevTools

```bash
# Enable CEF debugging on device
touch ~/.steam/steam/.cef-enable-remote-debugging
# SSH tunnel from dev machine
ssh -L 8080:localhost:8080 deck@<IP>
# Open in browser: http://localhost:8080
```

Pages: use **SharedJSContext** for webpack searches, **Steam Big Picture Mode** for React tree inspection.

**Important:** `webpackChunksteamui` is available **only in SharedJSContext**.

### Webpack access (in SharedJSContext console)

```javascript
let req; webpackChunksteamui.push([[Symbol()],{},r=>{req=r}]);
```

### Power Menu module map

| Module | Export | Description |
|--------|--------|-------------|
| `38258` | `d4` | `$(browserWindow, onCancel)` — opens Power Menu via `T.lX` |
| `38258` | `gL` | `ShutdownPC()` |
| `38258` | `KS` | `RestartPC()` |
| `38258` | `bl` | `() => !IN_VR && IN_GAMESCOPE` — condition for showing Power Menu |
| `31084` | `lX` | `showContextMenu(element, browserWindow, opts)` |
| `90389` | `Bd` | `{ SwitchToDesktop({}) }` — session switching API |

### Power Menu component `ne`

- Lives in module `38258`, **not exported** (closure variable)
- Created as `React.memo(fn)` — `const ne = (0,B.PA)(fn)`
- `ne.type` — `{writable: true}` → `afterPatch` works ✅
- Power Menu uses **old JSX transform** (`React.createElement`), not `jsx/jsxs`

### Patch strategy (implemented, verified working)

1. Wrap both `jsx/jsxs` (Strategy A) and `React.createElement` (Strategy B) — intercept all element creation
2. Check each element type: `type?.type?.toString()` contains `'ShutdownPC'` + `'IN_GAMESCOPE'` → this is `ne`
3. Capture `ne`, immediately restore originals (one-shot intercept)
4. `afterPatch(ne, "type", injectMobileButton)` — inject "Switch to Mobile" after "Switch to Desktop"

**Identification strings (stable across Steam updates):**

| Target | Strings |
|--------|---------|
| Power Menu component `ne` | `element.type.type.toString()` contains `'ShutdownPC'` + `'IN_GAMESCOPE'` |
| `SwitchToDesktop` API | module exports object with `SwitchToDesktop` method |

### injectMobileButton

Finds the Fragment in Power Menu's children containing `feature=16 && tone="destructive"` (Switch to Desktop button). Appends a clone with `key="mobile-mode-btn"` as re-render guard, `onSelected` calls `enableMobile()` then `_sessionSwitcher.SwitchToDesktop({})`.

## Backend implementation details

### _set_default_session (three strategies)

1. **Direct steamosctl** with `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{deck_uid}/bus` — fails as root even with correct bus
2. **`sudo -u deck --preserve-env=DBUS_SESSION_BUS_ADDRESS steamosctl`** — ✅ works reliably
3. **Direct write to `/var/lib/AccountsService/users/deck`** — last resort, no D-Bus needed

### _switch_to_game (broken pipe handling)

```python
result = subprocess.run(["steamosctl", "switch-to-game-mode"], env=env, capture_output=True)
if result.returncode not in (0, -13):  # -13 = SIGPIPE = success
    raise subprocess.CalledProcessError(...)
```

### File paths (DECKY_USER_HOME vs expanduser)

```python
# WRONG when running as root:
MOBILE_CFG = os.path.expanduser("~/.config/mobile-mode")  # → /root/.config/...

# CORRECT:
MOBILE_CFG = os.path.join(decky.DECKY_USER_HOME, ".config", "mobile-mode")  # → /home/deck/.config/...
```

### Decky API constants used

| Constant | Value | Purpose |
|----------|-------|---------|
| `decky.DECKY_USER_HOME` | `/home/deck` | User-space paths (always deck user, even when root) |
| `decky.DECKY_USER` | `deck` | Username for sudo and AccountsService |
| `decky.DECKY_PLUGIN_DIR` | `/home/deck/homebrew/plugins/decky-mobile-mode` | Plugin root (replaces `__file__`-based PLUGIN_DIR) |

## Build commands

```bash
pnpm i          # install dependencies
pnpm run build  # build frontend → dist/index.js
pnpm run watch  # watch mode
```

Deploy to device — via VSCode tasks (`.vscode/tasks.json`) or manually via `cli/decky`.

### VSCode tasks (custom)

| Task | Description |
|------|-------------|
| `installsessionfile` | One-time SSH+sudo install of mobile.desktop to `/usr/local/share/wayland-sessions/` |
| `deployandinstall` | Full build + deploy + session file install + restart Decky |

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | TypeScript + React, @decky/ui, @decky/api, rollup |
| Backend | Python 3 (root), subprocess for steamosctl |
| Build | pnpm v9 |
| Target | SteamOS 3.8 (Arch-based), KWin 6.4.3, Maliit 2.3.1 |

## Phase 2 checklist

- [x] Power Menu module research (38258) and component structure
- [x] Patch strategy defined (runtime capture via createElement/jsx interception)
- [x] Python backend: `enable_mobile()`, `disable_mobile()`, `get_status()`
- [x] Asset files in repo
- [x] Power Menu patch implemented in `index.tsx`
- [x] Root flag fixed (`"root"` not `"_root"`)
- [x] D-Bus session bus fix for steamosctl as root
- [x] User-space paths fixed (DECKY_USER_HOME vs expanduser)
- [x] Session switch via frontend SwitchToDesktop() API
- [x] Broken pipe handling for switch-to-game-mode
- [x] KDE Mobile session starts correctly (startplasma-mobile.sh runs)
- [x] Portrait rotation verified (`rotation.none` removes default Right rotation; panel is natively 800×1280)
- [ ] "Return to Gaming" button verified in KDE session
- [ ] QAM panel toggle verified end-to-end

## Known bugs fixed (Phase 2 debugging)

| Bug | Root cause | Fix |
|-----|-----------|-----|
| `enable failed: Invalid desktop session` | `mobile.desktop` not installed (permission denied) | Fixed by correcting root flag to `"root"` |
| `/usr/local/share/` permission denied | Backend ran as uid=1000, not root | Fixed: `"_root"` → `"root"` in plugin.json |
| `/bin/bash: undefined symbol: rl_trim_arg_from_string` | readline library mismatch on this SteamOS build | Fixed: removed all bash subprocess calls, use Python/mount binaries directly |
| `set-default-desktop-session` fails with `No such file or directory` | Root has no D-Bus session bus → steamosctl can't find steamos-manager | Fixed: set `DBUS_SESSION_BUS_ADDRESS` + `sudo -u deck` fallback |
| `switch-to-desktop-mode` always fails from Python | Same D-Bus issue + gamescope tears down the pipe on success | Fixed: moved session switch to frontend (`SwitchToDesktop()`) |
| Black screen, no `session.log`, no plasma processes | `expanduser("~")` resolves to `/root/` as root → files copied to wrong location | Fixed: `DECKY_USER_HOME` for all user-space paths |
| `switch-to-game-mode` "disable failed" despite working | Broken pipe on success misinterpreted as error | Fixed: `returncode not in (0, -13)` |
| Screen stays landscape despite `kscreen-doctor exit=0` | Steam Deck panel is physically portrait (800×1280); default KWin rotation is `right` (landscape); we were applying the same rotation again | Fixed: `rotation.none` removes the default rotation → portrait |
| Autostart script not running | `~/.config/autostart-scripts/` is KDE 4 mechanism | Fixed: `mobile-mode-init.desktop` in `~/.config/autostart/` (KDE 5/6) |
| kscreen-doctor times out / runs too early | Blind `sleep 3` not enough for KWin to be ready | Fixed: poll `qdbus org.kde.KWin /KWin` until `reconfigure` method appears (up to 30s) |

## Display rotation — verified facts

- **Panel native resolution**: `800×1280` (physically portrait)
- **Default KWin rotation**: `Right` (8 = 90°CW) → logical output `1280×800` landscape
- **Portrait command**: `kscreen-doctor output.eDP-1.rotation.none` (removes the default rotation)
- **`rotation.right` is wrong**: it applies the same rotation that's already there — no visual change
- **kscreen-doctor IS working**: exit=0 + Rotation field updates correctly; `~/.local/share/kscreen/` not written is normal for transient changes
- **kscreen D-Bus service**: not registered separately — kscreen-doctor talks directly to KWin
- **EDID**: `aab1aad9-30a4-475e-a48a-cd7d3e21c42d`

## Open questions / Next phase

- **Plasma Mobile shell**: current session is just rotated KDE Desktop — not touch-optimised. See research brief below.
- **Maliit auto-invoke**: KWin InputMethod entry written to kwinrc (`com.github.maliit.keyboard.desktop`) — not yet verified on device.

## Plasma Mobile — research brief

### Problem

Current Mobile Mode session is `startplasma-wayland` — a standard KDE Plasma Desktop session in portrait orientation. It works but is not touch-first:
- No gesture navigation
- No mobile-optimised shell (no app grid, no swipe-up launcher)
- Desktop taskbar/panels at wrong scale for touch
- Maliit keyboard not auto-invoked without manual kwinrc config

### What `plasma-mobile` actually is

`plasma-mobile` is a KDE shell package (`plasma-mobile` + `plasma-mobile-components`) that replaces `plasma-desktop` as the `plasmashell` configuration. It provides:
- Home screen with app grid
- Gesture-based navigation (swipe up = app drawer, swipe from edge = back)
- KDE Mobile task switcher
- Scaled-for-touch panels

It does NOT replace KWin — KWin stays as the compositor. Only the shell layer changes.

### SteamOS constraint

SteamOS root filesystem is a read-only squashfs image. `pacman -S plasma-mobile` gets wiped on every OS update. Options:

| Approach | Persistence | Complexity |
|----------|------------|------------|
| `pacman -S plasma-mobile` | ❌ wiped on update | simple install |
| Decky plugin installs via overlay / bind-mount | ✓ survives updates | complex, needs root mount |
| Flatpak components | partial | some plasma-mobile pieces available |
| Bundle plasma-mobile in plugin assets | ✓ fully controlled | large download, self-update needed |
| Use `systemd-sysext` image | ✓ if Valve supports it | advanced |
| NixOS / distrobox container | ✓ | very complex |

### Recommended research directions

1. **Does SteamOS have `/var/usrlocal/` overlay for `/usr/local/`?** If `/usr/local/lib/` is writable+persistent, we can install plasma-mobile there and set `XDG_DATA_DIRS` to pick it up.
2. **Is `plasma-mobile` available as a Flatpak or AppImage?** Unlikely but worth checking.
3. **Can we bundle the shell QML files from plasma-mobile in the plugin's assets?** `plasmashell --shell org.kde.plasma.mobileshell` reads QML from `XDG_DATA_DIRS` — if we put the QML in `~/.local/share/plasma/shells/` it might work without installing the package system-wide.
4. **Minimal viable touch shell**: instead of full plasma-mobile, configure `plasma-desktop` with a custom layout (Panel at bottom, large icons, touch-friendly applets) — no extra packages needed.

## Risks

- SteamOS update deletes files from `/usr/local/share/wayland-sessions/` — unlikely since it's a persistent overlay, but backend reinstalls on every plugin load
- SteamOS update changes Power Menu module structure → identification by content strings, minimal version coupling
- `SwitchToDesktop({})` always switches to the session set by `set-default-desktop-session` — if that call fails silently, the wrong session starts
