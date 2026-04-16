# PLAN: plasma-mobile через systemd-sysext

**Date:** 2026-04-16  
**Status:** Research complete — implementation not started  
**Цель:** Получить настоящий plasma-mobile shell на Steam Deck без зависимости от изменяемого rootfs

---

## 1. Что мы знаем (верифицировано на устройстве)

### Окружение SteamOS (deck@simdeck, SteamOS 3.8.2)

| Компонент | Версия | Где проверено |
|-----------|--------|---------------|
| qt6-base | 6.9.1-5 | `pacman -Q` |
| kwin | 6.4.3-1.8 | `pacman -Q` |
| plasma-desktop | 6.4.3-1 | `pacman -Q` |
| plasma-workspace | 6.4.3-1.3 | `pacman -Q` |
| systemd | 257.7-2.3-arch | `systemd-sysext --version` |
| extra-cmake-modules | 6.16.0-1 | установился при попытке сборки |

### Файловая система

| Путь | Writable as root | Persistent | Примечание |
|------|-----------------|------------|------------|
| `/usr/` | ❌ | ❌ | read-only squashfs, wipes on SteamOS update |
| `/usr/local/` | ✅ | ✅ | bind-mount из /var/usrlocal/ |
| `/usr/local/lib/` | ✅ (root) | ✅ | проверено: `sudo touch /usr/local/lib/.test` успех |
| `/var/lib/extensions/` | ✅ (root) | ✅ | проверено: sysext merge работает, /var на persistent разделе |
| `/home/deck/` | ✅ | ✅ | данные пользователя |

### systemd-sysext

- **Доступен**: systemd 257 с полной поддержкой sysext
- **Как работает**: overlay-монтирует содержимое image поверх `/usr/`
- **Команды**: `systemd-sysext merge` / `systemd-sysext unmerge` / `systemd-sysext status`
- **Хранилище**: `/var/lib/extensions/<name>.raw` или директория
- **Формат**: squashfs/ext4 `.raw` файл, или просто директория
- **Метаданные**: файл `usr/lib/extension-release.d/extension-release.<name>` внутри image
- **SYSEXT_LEVEL=1**: самый портабельный вариант, работает на любом systemd OS

### plasma-mobile

- **В SteamOS репах**: ❌ нет (кастомные репы Valve)
- **В официальных Arch репах**: ❌ нет (только AUR)
- **В AUR**: ✅ версия 6.6.3-1 (НО: требует ECM ≥ 6.22, на устройстве 6.16 → несовместимо)
- **На KDE серверах**: ✅ все версии, в т.ч. 6.4.3
  - Исходники: `https://download.kde.org/stable/plasma/6.4.3/plasma-mobile-6.4.3.tar.xz`
  - Размер: 3.5MB, скачали и распаковали — работает
- **Сборка на устройстве**: ❌ невозможна — Qt6 cmake dev файлы отсутствуют в SteamOS

### Зависимости plasma-mobile (из AUR PKGBUILD 6.6.3, применимо к 6.4.3)

Всего 29 зависимостей. Проблемные (не в SteamOS репах):

| Пакет | Тип | Нужен ли |
|-------|-----|---------|
| `breeze-cursors` | cursor theme | нет (cursors уже есть в breeze) |
| `plasma-keyboard` | virtual kbd mgmt | может нет (есть Maliit) |
| `plasma-nano` | lockscreen | нет (нет телефона, нет lock screen нужды) |
| `plasma-settings` | настройки приложение | нет (не обязательно для запуска) |

Остальные 25 зависимостей (kwin, plasma-workspace, qt6-*, kf6-*, bluez-qt, etc.) **присутствуют на SteamOS**.

---

## 2. Что НЕ знаем (нужно проверить)

- [x] `/var/lib/extensions/` — существует? writable? persistent? ✅ ДА
- [x] `systemd-sysext merge` — работает без доп. конфигурации на SteamOS? ✅ ДА (`ID=_any`)
- [x] Какие именно файлы производит `cmake install` для plasma-mobile 6.4.3? ✅ ~21MB staging, ~3MB squashfs
  - `/usr/share/plasma/shells/org.kde.plasma.mobileshell/` — QML shell package
  - `/usr/lib/qt6/qml/org/kde/plasma/private/mobileshell/` — shell QML components
  - `/usr/lib/qt6/qml/org/kde/plasma/mobileinitialstart/` — initial start wizard
  - `/usr/lib/qt6/plugins/plasma/kcms/systemsettings/kcm_mobileshell.so` — settings
  - KWin effect (mobiletaskswitcherplugin) **SKIPPED** — internal KWin API changed in 6.6, not compatible with dev machine
- [ ] Запустится ли `plasmashell --shell org.kde.plasma.mobileshell` без plasma-nano/plasma-keyboard/plasma-settings?
- [ ] Что именно не работает без telephony stack (modemmanager)?
- [ ] Нужен ли `plasma-keyboard` во время СБОРКИ или только runtime?

### Верифицированные факты о сборке

**Минимальные требования plasma-mobile-6.4.3 (из CMakeLists.txt):**
- `QT_MIN_VERSION = "6.8.0"` → SteamOS Qt 6.9.1 ✅ удовлетворяет
- `KF6_MIN_VERSION = "6.14.0"` → SteamOS ECM 6.16.0 ✅ удовлетворяет

**Сборка на Deck напрямую: ❌ НЕВОЗМОЖНА**
- SteamOS вырезает Qt6 cmake-файлы из qt6-base и qt6-tools
- `find /usr -name Qt6CoreToolsConfig.cmake` → пусто
- Без cmake-файлов Qt6 ECM не может найти qtpaths и настроить сборку

**Сборка на dev машине (Arch Linux) без Docker: ❌ НЕВЕРНАЯ ABI**
- Dev машина имеет Qt 6.11, SteamOS имеет Qt 6.9.1
- Qt plugins НЕ совместимы между minor версиями (строгая проверка KCoreAddons)
- Результат: `"uses incompatible Qt library. (6.11.0) [release]"` при загрузке .so
- Это проверка KCoreAddons (kf.coreaddons), не самого Qt

**Правильный подход: Docker с даунгрейдом Qt до 6.9.1 из Arch Archive**
- `FROM archlinux:latest` → установить всё latest
- Даунгрейд Qt + ICU до версий из архива Arch:
  - `qt6-base-6.9.1-5` (совпадает с SteamOS точно)
  - `qt6-declarative-6.9.1-3`, `qt6-wayland-6.9.1-1`, `qt6-multimedia-6.9.1-1`
  - `qt6-sensors-6.9.1-1`, `qt6-svg-6.9.1-1`, `qt6-tools-6.9.1-2`, `qt6-5compat-6.9.1-1`
  - `icu-76.1-1` (Qt 6.9.1 слинкован против libicui18n.so.76)
- Файлы: `sysext/Dockerfile`, `sysext/build.sh`, `sysext/build_inner.sh`

**Два патча исходников (оба нужны):**
1. `initialstart/modules/prepare/prepareutil.cpp` — `output->isPrimary()` удалён в новом libkscreen; убрать `if (isPrimary()) break`
2. `CMakeLists.txt` — `add_subdirectory(kwin)` закомментировать — KWin internal API несовместим между 6.4 и 6.6

**Первичный тест (неверная ABI):** sysext merge работает ✅, shell package виден ✅, но .so плагины отказываются загружаться из-за Qt ABI → plasmashell падает на desktop shell

---

## 3. Архитектура решения

```
[Dev machine: Arch Linux Docker]
    Dockerfile с точными версиями KDE dev
    → собирает plasma-mobile-6.4.3 из source
    → DESTDIR install → staging/
    → mksquashfs staging/ → plasma-mobile.raw
    → scp на устройство

[Steam Deck: /var/lib/extensions/plasma-mobile.raw]
    systemd-sysext merge
    → /usr/share/plasma/shells/org.kde.plasma.mobileshell/ появляется
    → /usr/lib/qt6/qml/org/kde/plasma/private/mobileshell/ появляется
    → plasmashell видит mobileshell

[Decky plugin: enable_mobile()]
    → systemd-sysext merge (если не смержен)
    → steamosctl set-default-desktop-session mobile.desktop
    → [frontend] SwitchToDesktop()
    → startplasma-mobile.sh: plasmashell --shell org.kde.plasma.mobileshell

[Decky plugin: disable_mobile() / _main()]
    → systemd-sysext unmerge
    → steamosctl set-default-desktop-session plasma
    → _restore_kwinrc()
```

---

## 4. Что нужно создать (предварительно)

### 4.1 Build pipeline (`sysext/`)

```
sysext/
  Dockerfile       — Arch + полный KDE dev stack
  build.sh         — cmake + make + DESTDIR install + mksquashfs
  deploy.sh        — scp + systemd-sysext merge на устройстве
  output/          — gitignore, здесь появится plasma-mobile.raw
```

**Ключевые решения для build.sh:**
- `cmake -DCMAKE_INSTALL_PREFIX=/usr` (не /usr/local) — Qt plugins ожидают `/usr/lib/qt6/`
- Отключить deps которых нет: plasma-keyboard, plasma-nano через cmake flags (если поддерживаются)
- DESTDIR install в staging директорию
- mksquashfs с zstd компрессией

**Что нужно в Dockerfile:**
- `qt6-tools` — содержит cmake dev файлы и `qtpaths6`
- Полный `kf6-*` набор
- `plasma-workspace`, `kwin` — для API headers
- `layer-shell-qt`, `kpipewire` — plasma-mobile зависимости

### 4.2 Plugin integration (`main.py`)

Новые методы:
```python
async def install_plasma_mobile(self) -> dict:
    # Скачивает plasma-mobile.raw из GitHub Releases
    # Кладёт в /var/lib/extensions/
    # Возвращает прогресс через streaming?

async def check_install_status(self) -> dict:
    # is_sysext_available: plasma-mobile.raw существует?
    # is_sysext_active: systemd-sysext status показывает merged?
    # is_mobileshell_visible: ls /usr/share/plasma/shells/org.kde.plasma.mobileshell/

# Изменить enable_mobile():
async def enable_mobile(self) -> dict:
    # 1. Проверить sysext — если не активен, merge
    # 2. Остальное как сейчас

# Изменить _main() и disable_mobile():
    # + systemd-sysext unmerge
```

### 4.3 QAM UI (`src/index.tsx`)

Новые состояния:
```
not_installed → [Кнопка: "Install plasma-mobile shell (~50MB)"]
installing    → [Прогресс: "Downloading... 23%"]
installed     → [Toggle: "Switch to Mobile Mode"] ← текущий UI
```

### 4.4 Session script (`assets/startplasma-mobile.sh`)

Изменить: запускать `plasmashell --shell org.kde.plasma.mobileshell` вместо обычного plasmashell.

```bash
# Проверить что mobileshell доступен
if [ -d "/usr/share/plasma/shells/org.kde.plasma.mobileshell" ]; then
    exec /usr/lib/plasma-dbus-run-session-if-needed \
        plasmashell --shell org.kde.plasma.mobileshell
else
    echo "ERROR: plasma-mobile shell not found" >> "$LOG"
    exit 1
fi
```

---

## 5. Следующие конкретные шаги

### Шаг 1 (СНАЧАЛА — верификация на устройстве, без кода)

```bash
# Проверить sysext storage
ls -la /var/lib/extensions/ 2>/dev/null || echo "extensions dir not found"
sudo systemd-sysext status

# Создать тестовый sysext вручную (без Docker)
sudo mkdir -p /var/lib/extensions/test-sysext/usr/lib/extension-release.d/
echo "SYSEXT_LEVEL=1" | sudo tee /var/lib/extensions/test-sysext/usr/lib/extension-release.d/extension-release.test-sysext
sudo mkdir -p /var/lib/extensions/test-sysext/usr/share/test-plasma-data/
echo "hello" | sudo tee /var/lib/extensions/test-sysext/usr/share/test-plasma-data/test.txt
sudo systemd-sysext merge
cat /usr/share/test-plasma-data/test.txt  # должно быть "hello"
sudo systemd-sysext unmerge
```

Это подтвердит что sysext механизм работает на SteamOS **до** того как мы тратим время на сборку.

### Шаг 2 (Docker build)

После подтверждения sysext работает — начать Docker build:

```bash
cd sysext/
docker build -t plasma-mobile-builder .
mkdir -p output
docker run --rm -v "$(pwd)/output:/output" plasma-mobile-builder /build/build.sh
```

### Шаг 3 (Deploy и test)

```bash
scp sysext/output/plasma-mobile.raw deck@steamdeck.local:/tmp/
ssh deck@steamdeck.local "sudo mv /tmp/plasma-mobile.raw /var/lib/extensions/"
ssh deck@steamdeck.local "sudo systemd-sysext merge && systemd-sysext status"
ssh deck@steamdeck.local "ls /usr/share/plasma/shells/ | grep mobile"
```

---

## 6. Риски и митигация

| Риск | Вероятность | Митигация |
|------|-------------|-----------|
| systemd-sysext не работает на SteamOS | средняя | Шаг 1 проверяет это до всего остального |
| plasma-mobile требует plasma-nano/plasma-keyboard для сборки | средняя | cmake скажет, тогда собираем и их |
| Версия qt6 в Docker не совпадает с SteamOS → ABI несовместимость | низкая | версии Qt ABI стабильны внутри 6.9.x |
| plasmashell --shell mobileshell крашится без телефонного стека | средняя | нужно тестировать, возможно патчить CMake для отключения telephony |
| SteamOS обновление меняет версию KWin → sysext ABI несовместим | неизбежно | нужен CI на GitHub Actions + update mechanism в плагине |
| `/var/lib/extensions/` не persistent | низкая | Шаг 1 проверяет |

---

## 7. Что НЕ входит в scope этого плана

- Сборка plasma-nano, plasma-keyboard, plasma-settings (если понадобится — отдельная задача)
- GitHub Actions CI (после того как local build работает)
- Update mechanism (проверка версий, re-download при SteamOS update)
- Телефонные функции (звонки, SMS) — Steam Deck не телефон
