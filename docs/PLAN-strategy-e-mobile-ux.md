# PLAN: Strategy E Mobile UX — QAM + KDE tweaks

**Date:** 2026-04-16  
**Status:** Draft — edit freely  
**Goal:** Clean codebase + good QAM UX + real touch experience via KDE Desktop tweaks (Strategy E from ADR-001)

---

## 0. Состояние кодовой базы сейчас

Что реально работает:
- ✅ Portrait rotation (`kscreen-doctor output.eDP-1.rotation.none`)
- ✅ Maliit сервер запускается
- ✅ InputMethod прописывается в kwinrc через `startplasma-mobile.sh`
- ✅ Return to Gaming кнопка в KDE
- ✅ `_restore_kwinrc()` при disable через QAM
- ✅ `_clear_state()` при старте Gaming Mode

Что не работает / не сделано:
- ❌ Power Menu кнопка (abandoned — три стратегии провалились, MutationObserver не видит frame Power Menu)
- ❌ Scale factor 1.5× (в плане ADR, не реализовано)
- ❌ Plasma shell tweaks (fullscreen launcher, taskbar)
- ❌ kwinrc и default session не сбрасываются при return через KDE кнопку (баг — см. секцию 2)
- ❌ `return-to-gaming.sh` применяет `rotation.none` вместо `rotation.right` (баг)

---

## 1. Cleanup: мёртвый код (приоритет: сделать первым)

### 1.1 `src/index.tsx` — убрать весь Power Menu patch

**Убрать** (строки 6, 84–245, 343, ссылки в definePlugin):
- `afterPatch` из импорта `@decky/ui` (строка 6) — больше не нужен
- `injectMobileButton()` (строки 84–130) — вся функция
- `patchPowerMenu()` (строки 132–245) — вся функция (~113 строк мёртвого кода)
- `let _unpatch` (строка 343)
- `_unpatch = patchPowerMenu()` в `definePlugin()`
- `_unpatch?.()` в `onDismount`

**Оставить** (нужны для `SwitchToDesktop`):
- `WpRequire` тип + `getWpRequire()` (строки 27–37) — используется в `findSessionSwitcher()`
- `findSessionSwitcher()` (строки 42–70) — нужен для SwitchToDesktop после enable

После чистки: 364 → ~175 строк. Файл становится читаемым.

### 1.2 Проверить что `_sessionSwitcher` остаётся и правильно инициализируется

После удаления `_unpatch`, паттерн в `definePlugin()` становится:
```typescript
export default definePlugin(() => {
  console.log("[MobileMode] Plugin initialising");
  _sessionSwitcher = findSessionSwitcher();
  return { ... onDismount() { _sessionSwitcher = null; } };
});
```

### 1.3 `.claude/CLAUDE.md` — обновить секцию Power Menu

Убрать: описание стратегий A/B/C (showContextMenu, DevTools hook, MutationObserver) — они провалились и это мусор.  
Оставить: краткую заметку "Power Menu patch deferred — все три стратегии провалились по причине X" + текущий fingerprint `ne` (полезен если вернёмся).  
Обновить: checklist фаз.

---

## 2. Баги: критические correctness проблемы

### 2.1 Утечка конфига при return через KDE кнопку (CRITICAL BUG)

**Проблема:** когда пользователь нажимает "Return to Gaming" в KDE, вызывается `return-to-gaming.sh` напрямую. `disable_mobile()` из Python **не вызывается**. Это значит:
- `_restore_kwinrc()` не выполняется → `InputMethod=` остаётся в kwinrc → Maliit активен в следующей Desktop Mode сессии
- `_set_default_session("plasma.desktop")` не выполняется → default session остаётся `mobile.desktop` → следующий "Switch to Desktop" из Gaming Mode откроет Mobile Mode снова!

**Fix (вариант A — рекомендуется): в `_main()` всегда делать cleanup**
```python
async def _main(self):
    decky.logger.info(f"Mobile Mode loaded (uid={os.getuid()})")
    self._install_session_files()
    # Always clean up in case we returned via KDE button (bypass disable_mobile)
    self._restore_kwinrc()
    self._set_default_session("plasma.desktop")
    self._clear_state()
```
Вызовы идемпотентны: `_restore_kwinrc()` без InputMethod= ничего не меняет, `_set_default_session("plasma.desktop")` безопасно вызывать всегда. Это делает Gaming Mode старт единственным местом нормализации состояния.

**Fix (вариант B — альтернатива): починить `return-to-gaming.sh`**  
Добавить в скрипт: `steamosctl set-default-desktop-session plasma` и sed для kwinrc. Минус: дублирование логики и ненадёжность bash-скрипта на SteamOS.

**Рекомендация:** вариант A.

### 2.2 `return-to-gaming.sh` применяет неверную rotation (MINOR BUG)

**Проблема:** строка 9:
```bash
kscreen-doctor output.eDP-1.rotation.none
```
`rotation.none` — это команда которую мы применяем для **портретного** режима. В момент выхода из Mobile Mode экран уже в portrait. Применение той же команды — no-op.

Для восстановления landscape нужно `rotation.right` (дефолтное KWin поведение, 90°CW от физически-portrait панели).

**Severity:** Low. Когда steamosctl switch-to-game-mode выполняется, KDE сессия немедленно уничтожается и gamescope берёт управление дисплеем. KWin rotation не влияет на gamescope. Баг виден только если steamosctl завершится с ошибкой и пользователь останется в KDE.

**Fix:**
```bash
# Restore landscape orientation before leaving the session
kscreen-doctor output.eDP-1.rotation.right
```

### 2.3 `startplasma-mobile.sh` пишет в kwinrc через grep+sed (техдолг)

Текущее решение работает но хрупко — grep+mv+sed не атомарно, и если `[Wayland]` секция отсутствует или структура файла нестандартная, может повредить конфиг. 

Более надёжная альтернатива — Python делает это через `configparser` в `enable_mobile()`. Но это изменение архитектуры. Пока оставить, задокументировать.

---

## 3. QAM UX — редизайн панели

### 3.1 Аналитика: что реально показывается в QAM

Ключевой инсайт: пользователь видит QAM **только в Gaming Mode**. Когда Mobile Mode активен (KDE), QAM Steam недоступен. Значит:
- `is_mobile === true` в QAM возможен только в edge case (plugin crash/reload в KDE, что сбрасывается `_main()`)  
- В нормальном потоке QAM = "включить Mobile Mode", не toggle

### 3.2 Текущие проблемы QAM

- `ToggleField` с label "Mobile Mode off" — непонятно что произойдёт
- Нет предупреждения что Steam сессия закроется
- Loading state показывает spinner без объяснения
- Switching state: "Switching to Mobile Mode…" — слишком вяло
- Info text внизу спрятан и мелкий

### 3.3 Дизайн улучшенного QAM

**Принципы:**
1. Основное действие — "Switch to Mobile Mode" — должно быть понятным CTA
2. Деструктивный эффект (Steam закроется) — явное предупреждение
3. Состояния процесса — конкретные, не абстрактные

**Структура:**
```
┌─────────────────────────────────────┐
│ MOBILE MODE                         │
├─────────────────────────────────────┤
│ [Toggle] Switch to Mobile Mode      │  ← чёткий label
│          Portrait · touch-first KDE │  ← что получишь
│          ⚠ Steam session will close │  ← предупреждение (только когда off)
├─────────────────────────────────────┤
│ [если switching] Preparing session…  │
│ [если error] ⚠ Error: <text>        │
└─────────────────────────────────────┘
```

**Детали реализации:**

- `ToggleField.label`: 
  - off: `"Switch to Mobile Mode"`
  - on: `"Mobile Mode active"` (edge case)
- `ToggleField.description`:
  - off: `"Portrait orientation · Maliit keyboard · touch UI"`
  - switching: `"Closing Steam session…"` (через отдельный row)
- Предупреждение: добавить `PanelSectionRow` с мелким текстом `"Steam will close to switch sessions"` только когда `!isMobile && !switching`
- Error: красный текст, как сейчас, но с prefix иконкой
- Disabled state: `loading || switching` (уже правильно)

**Примечание об иконке:** `FaMobileAlt` заменить на `FaMobileScreen` или оставить — вопрос вкуса.

---

## 4. Strategy E: Phase 1 — Scale factor (высокий impact, малый риск)

### 4.1 Что добавить в `mobile-mode-init.sh`

```bash
# Apply 1.5× scale for touch-friendly UI (after rotation, before reconfigure)
kscreen-doctor output.eDP-1.scale.1.5 >> "$LOG" 2>&1
echo "kscreen-doctor scale exit=$?" >> "$LOG"
```

**Место в скрипте:** после `kscreen-doctor output.eDP-1.rotation.none`, до `qdbus reconfigure`.

**Результат:** физический 800×1280 → логический 533×853. Все UI элементы в 1.5× размере — touch targets достигаемы пальцем.

### 4.2 Нужна ли очистка scale при выходе?

Per CLAUDE.md: kscreen-doctor делает transient изменения (`~/.local/share/kscreen/` не пишется). Когда KDE сессия завершается и gamescope берёт управление, scale не переносится. При следующей Desktop Mode сессии KDE стартует со своим defaults.

**Вывод:** очистка не нужна. Scale самоочищается при уничтожении сессии.

**Но:** нужно верифицировать на устройстве что scale не прописывается в `~/.config/kwinrc` или `~/.local/share/kscreen/`. Если пишется — добавить restore в `disable_mobile()` / `_main()`.

### 4.3 Тест

После применения scale `1.5`:
- `kscreen-doctor` output должен показать Scale=1.5 в eDP-1
- Визуально: всё крупнее, taskbar/icons заметно больше
- Проверить: следующая Desktop Mode сессия — scale обычный (1.0)

---

## 5. Strategy E: Phase 2 — Plasma shell tweaks (следующая итерация)

*Эта секция — план на будущее, не для текущей итерации.*

### 5.1 Taskbar size

```bash
# Increase panel height for easier touch
kwriteconfig6 --file plasmashellrc --group "PlasmaViews" --group "Panel 2" --key "thickness" "72"
```
Проблема: containment ID `2` не гарантирован. Нужно динамически найти ID панели.

### 5.2 Fullscreen App Launcher

Вариант A: заменить Kickoff applet на Application Dashboard (fullscreen):
```bash
kwriteconfig6 --file plasma-org.kde.plasma.desktop-appletsrc \
  --group "Containments" --group "<panel_id>" --group "Applets" --group "<applet_id>" \
  --key "plugin" "org.kde.plasma.applicationdashboard"
```
Требует: знание containment/applet ID — нельзя захардкодить.

Вариант B: запускать KRunner при старте (fullscreen поиск приложений):
```bash
qdbus org.kde.krunner /App display
```
Проще, не требует конфигурации Plasma. Но не "хранится" после закрытия.

Вариант C: поставить в автостарт скрипт открывающий Application Dashboard через DBus.

**Рекомендация:** в Phase 2 начать с Варианта B (KRunner), оценить UX, затем решать нужен ли Application Dashboard.

### 5.3 Backup/Restore стратегия для persistent config

Если будем менять appletsrc (persistent):
```python
# в enable_mobile():
shutil.copy(appletsrc_path, os.path.join(MOBILE_CFG, "appletsrc.backup"))
# применить mobile config

# в _main() и disable_mobile():
backup = os.path.join(MOBILE_CFG, "appletsrc.backup")
if os.path.exists(backup):
    shutil.copy(backup, appletsrc_path)
    os.remove(backup)
```

---

## 6. Чего не делать (lessons learned)

| Что | Почему нет |
|-----|-----------|
| Power Menu: `Object.defineProperty` на lX | `configurable: false` — выбросит TypeError |
| Power Menu: `__REACT_DEVTOOLS_GLOBAL_HOOK__` | Только когда DevTools активно подключен |
| Power Menu: MutationObserver на document.body | Power Menu рендерится в другом CEF frame — наш observer не видит этот DOM |
| Power Menu: wrapping req.m фабрики | Executing uncached modules через req(id) — side effects |
| `expanduser("~")` для user paths | Как root возвращает /root/, нужен DECKY_USER_HOME |
| `"_root"` в plugin.json flags | Не работает, нужен `"root"` без underscore |
| `check=True` для switch-to-game-mode | broken pipe (rc=-13) = успех, не ошибка |
| `rotation.right` для portrait | Steam Deck панель физически portrait, right — дефолт landscape; для portrait нужно none |
| Установка в `/usr/share/wayland-sessions/` | Read-only squashfs, нужен `/usr/local/share/wayland-sessions/` |
| `autostart-scripts/` для KDE autostart | Это KDE 4. KDE 5/6 использует `~/.config/autostart/` |

---

## 7. Порядок реализации

```
[x] 1. Code cleanup (index.tsx — убрать Power Menu код) — 364→185 строк
[x] 2. Bug fix: _main() нормализует состояние при старте Gaming Mode
[x] 3. Bug fix: return-to-gaming.sh rotation.right
[x] 4. QAM UX редизайн (улучшенные labels, предупреждение)
[ ] 5. Scale factor 1.5× — ОТМЕНЁН (Strategy E признана нежизнеспособной)

--- PIVOT: plasma-mobile через systemd-sysext ---

[x] P1. Build: Docker + Qt 6.9.1 из Arch Archive (правильный ABI) — pipeline готов, требует запуска
[x] P2. Deploy test: sysext merge работает ✅, shell package виден ✅
[~] P3. Session test: plasmashell запускается с desktop shell — Qt ABI mismatch (P1 фиксит)
[x] P4. Plugin integration: sysext merge/unmerge в main.py + ShellPackage в plasmashellrc ✅
[ ] P5. QAM UI: "Install plasma-mobile" state + прогресс
[ ] P6. Cleanup: systemd-sysext unmerge при deactivate + uninstall
[ ] P7. GitHub Actions CI для автоматических сборок при выходе новых Plasma версий

### Верифицированные факты о plugin integration (P4)

**Проблемы и фиксы:**

| Проблема | Причина | Фикс |
|----------|---------|------|
| `systemd-sysext merge` падает с OpenSSL ошибкой | Decky/PyInstaller устанавливает LD_LIBRARY_PATH с bundled libcrypto.so.3 | Убрать LD_LIBRARY_PATH/LD_PRELOAD из env перед вызовом systemd-sysext |
| После merge `/usr/local/` read-only | sysext merge создаёт overlayfs на `/usr/`, скрывая bind-mount `/usr/local/` | Порядок: install files → set session → merge |
| kwinrc/plasmashellrc остаются загрязнёнными если Return via KDE кнопку | disable_mobile() не вызывается | `_main()`: unmerge → restore → set plasma.desktop → install files |
| `plasmashellrc` не применяется вовремя | kwriteconfig6 в bash скрипте ненадёжен | Писать plasmashellrc из Python в enable_mobile() через configparser |
```

---

## 8. Тестовый план

### Smoke test после каждого изменения

1. Build: `pnpm run build` — no TypeScript errors
2. Deploy на устройство
3. Enable Mobile Mode через QAM → KDE стартует в portrait 1.5×
4. Maliit: тапнуть текстовое поле → клавиатура появляется
5. Return to Gaming: кнопка в KDE → Gaming Mode
6. Verify no pollution:
   - `grep InputMethod ~/.config/kwinrc` → пусто
   - `steamosctl get-default-desktop-session` → `plasma` (не `mobile`)
7. Switch to Desktop (обычный) → нормальная Desktop Mode (не Mobile!)
8. Session log: `cat ~/.config/mobile-mode/session.log` — нет ошибок

### Verify scale restore

После Mobile Mode и возврата в Gaming/Desktop Mode:
```bash
kscreen-doctor -o | grep Scale
# Должно быть Scale=1 (или отсутствовать)
```
