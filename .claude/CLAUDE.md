# CLAUDE.md — Mobile Mode for Steam Deck

## Project

A Decky Loader plugin that adds a third operating mode to the Steam Deck — **Mobile Mode**. A "Switch to Mobile" button in the Steam Power Menu switches the device into a custom KDE session with portrait orientation and touch-first UI.

**Status:** Phase 0 ✅ Phase 1 ✅ Phase 2 → (plugin development)

## Architecture

```
Power Menu (Steam) → "Switch to Mobile"
    ↓ Decky Plugin (index.tsx — Power Menu patch)
    ↓ Decky Backend (main.py — runs as root)
        steamosctl switch-to-desktop-mode
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
main.py                    — Python backend (root): steamosctl, file management
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
- **Rotation**: `kscreen-doctor output.eDP-1.rotation.right` — apply only after KWin starts (autostart + sleep 2)
- **Geometry**: recalculated only after `qdbus org.kde.KWin /KWin reconfigure` following rotation
- **Keyboard**: Maliit 2.3.1 is pre-installed in SteamOS, activated via `QT_IM_MODULE=maliit`
- **Session switching**: `steamosctl` (official Valve API), supports custom `.desktop` files from `/usr/share/wayland-sessions/`
- **Backend = root**: Decky backend runs as root — can write to `/usr/share/`

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

**Important:** `webpackChunksteamui` is available **only in SharedJSContext** — not in Steam Big Picture Mode or MainMenu.

### Webpack access (in SharedJSContext console)

```javascript
let req; webpackChunksteamui.push([[Symbol()],{},r=>{req=r}]);
```

- `findModuleChild` is **deprecated** — use `findModuleExport` instead

### Power Menu module map

| Module | Export | Description |
|--------|--------|-------------|
| `38258` | `d4` | `$(browserWindow, onCancel)` — opens Power Menu as a **context menu** via `T.lX` |
| `38258` | `gL` | `ShutdownPC()` |
| `38258` | `KS` | `RestartPC()` |
| `38258` | `bl` | `() => !IN_VR && IN_GAMESCOPE` — condition for showing Power Menu |
| `38258` | `ve` | SuspendDialog component |
| `38258` | `_p` | ResumeDialog component |
| `31084` | `lX` | `showContextMenu(element, browserWindow, opts)` — creates context menu via `CreateContextMenuInstance` |
| `90389` | `Bd` | `{ SwitchToDesktop({}) }` — session switching API |

### Power Menu component `ne`

- Lives in module `38258`, **not exported** (closure variable)
- Created as `React.memo(fn)` — `const ne = (0,B.PA)(fn)`
- `d4` calls: `T.lX(jsx(ne, {onCancel}), browserWindow, {onCancel})`
- `T` = module `31084`, `T.lX` = **showContextMenu** (not showModal)
- Power Menu renders as a **context menu** via `GetContextMenuManagerFromWindow(browserWindow).CreateContextMenuInstance(element, ...)`
- Full source of `lX`: `function o(e,t,n){let r,i,o,a=t; if(a?.preventDefault&&...){...} else o=t; let c=s.GetContextMenuManagerFromWindow(o).CreateContextMenuInstance(e,o,r,i,n); return c.Show(),...}`

### "Switch to Desktop" button structure

```javascript
// Rendered under condition: P = IN_GAMESCOPE && !kiosk && !lockScreen && (showAtLogin || isMain)
P && (
  <>
    <Separator />
    <MenuItem feature={16} tone="destructive" onSelected={() => z(browserWindow)}>
      {loc("#SwitchToDesktop")}
    </MenuItem>
  </>
)
// z(e) → showContextMenu(<ConfirmDialog onProceed={() => J.Bd.SwitchToDesktop({})} />, e)
```

### Verified patch strategy

All points confirmed in DevTools. Approach is update-resistant — no hardcoded module IDs.

**Verifications:**
- `ne.type` — `{writable: true, enumerable: true, configurable: true}` → `afterPatch` works ✅
- Content-based search for `showContextMenu` → **unique**: only module `31084` ✅
- Content-based search for Power Menu module → **unique**: only module `38258` ✅

**Algorithm (content-based, not ID-based):**

1. Find `showContextMenu` by: `'CreateContextMenuInstance'` + `'GetContextMenuManagerFromWindow'`
2. Intercept it. When called with `element.type.type.toString()` containing `'ShutdownPC'` + `'IN_GAMESCOPE'` → Power Menu
3. Capture `ne = element.type`, restore `showContextMenu` immediately (one-shot intercept)
4. `afterPatch(ne, "type", ...)` — inject "Switch to Mobile" after "Switch to Desktop"

**Identification strings (stable across Steam updates):**

| Target | Strings |
|--------|---------|
| `showContextMenu` | `'CreateContextMenuInstance'` + `'GetContextMenuManagerFromWindow'` |
| Power Menu module | `'ShutdownPC'` + `'IN_GAMESCOPE'` + `'SwitchToDesktop'` |
| Power Menu component `ne` | `element.type.type.toString()` contains `'ShutdownPC'` + `'IN_GAMESCOPE'` |

```javascript
// Verification in SharedJSContext console:
let req; webpackChunksteamui.push([[Symbol()],{},r=>{req=r}]);
// Power Menu module → ['38258']
Object.keys(req.m).filter(id=>{try{const s=req.m[id].toString();return s.includes('ShutdownPC')&&s.includes('IN_GAMESCOPE')&&s.includes('SwitchToDesktop')}catch{}})
// showContextMenu → ['31084']
Object.keys(req.m).filter(id=>{try{const s=req.m[id].toString();return s.includes('CreateContextMenuInstance')&&s.includes('GetContextMenuManagerFromWindow')}catch{}})
```

## Build commands

```bash
pnpm i          # install dependencies
pnpm run build  # build frontend → dist/index.js
pnpm run watch  # watch mode
```

Deploy to device — via VSCode tasks (`.vscode/tasks.json`) or manually via `cli/decky`.

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | TypeScript + React, @decky/ui, @decky/api, rollup |
| Backend | Python 3 (root), subprocess for steamosctl |
| Build | pnpm v9 |
| Target | SteamOS 3.8 (Arch-based), KWin 6.4.3, Maliit 2.3.1 |

## Phase 2 checklist

- [x] Power Menu module research (38258) and component structure
- [x] Patch strategy defined (runtime capture via showContextMenu intercept)
- [x] Python backend: `enable_mobile()`, `disable_mobile()`, `get_status()`
- [x] Asset files in repo
- [x] Power Menu patch implemented in `index.tsx`
- [ ] On-device testing
- [ ] "Return to Gaming" button verified in KDE session
- [ ] QAM panel verified

## Open questions

- Does Maliit auto-invoke on text input focus in KDE?
- Does Geometry recalculate correctly after `qdbus reconfigure`?

## Risks

- SteamOS update deletes files from `/usr/share/wayland-sessions/` → backend reinstalls on every plugin load
- SteamOS update changes module `38258` → patch identifies by content strings, minimal version coupling
- Module ID `38258` may change after Steam update → identification by content, never by ID
