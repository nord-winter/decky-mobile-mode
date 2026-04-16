import configparser
import os
import shutil
import subprocess

import decky

ASSETS_DIR = os.path.join(decky.DECKY_PLUGIN_DIR, "assets")

# Use DECKY_USER_HOME / DECKY_USER — always the deck user's paths,
# even when the backend runs as root (unlike expanduser("~") which gives /root/).
MOBILE_CFG = os.path.join(decky.DECKY_USER_HOME, ".config", "mobile-mode")
AUTOSTART  = os.path.join(decky.DECKY_USER_HOME, ".config", "autostart")   # KDE Plasma 5/6 autostart
APPS_DIR   = os.path.join(decky.DECKY_USER_HOME, ".local", "share", "applications")

# /usr/local is bind-mounted from /var/usrlocal (persistent, survives SteamOS updates).
# steamosctl reads XDG_DATA_DIRS which includes /usr/local/share.
LOCAL_SESSIONS_DIR   = "/usr/local/share/wayland-sessions"
LOCAL_MOBILE_DESKTOP = os.path.join(LOCAL_SESSIONS_DIR, "mobile.desktop")

MODE_STATE_FILE = os.path.join(MOBILE_CFG, "active_mode")

# systemd-sysext paths
SYSEXT_EXTENSIONS_DIR = "/var/lib/extensions"
SYSEXT_RAW = os.path.join(SYSEXT_EXTENSIONS_DIR, "plasma-mobile.raw")
MOBILESHELL_DIR = "/usr/share/plasma/shells/org.kde.plasma.mobileshell"

# Explicit PATH — Decky's systemd unit has a restricted PATH.
_SYS_ENV = dict(os.environ, PATH="/usr/bin:/usr/local/bin:/bin:/usr/sbin:/sbin")


class Plugin:

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def check_install_status(self) -> dict:
        """Return sysext installation and activation status."""
        try:
            is_installed = os.path.exists(SYSEXT_RAW)
            is_active = os.path.isdir(MOBILESHELL_DIR)
            return {"success": True, "is_installed": is_installed, "is_active": is_active}
        except Exception as e:
            decky.logger.error(f"Mobile Mode: check_install_status failed — {e}")
            return {"success": False, "is_installed": False, "is_active": False, "error": str(e)}

    async def enable_mobile(self) -> dict:
        """Merge plasma-mobile sysext, install session files, and set default session.

        The frontend calls SwitchToDesktop() via the Steam webpack API after this
        returns — the same path the native 'Switch to Desktop' button uses.
        """
        try:
            # Install files BEFORE sysext merge: after merge /usr/ becomes overlayfs
            # and the bind-mount at /usr/local/ is hidden (read-only).
            self._install_session_files()
            self._set_mobile_shell_config()
            self._set_default_session("mobile.desktop")
            if os.path.exists(SYSEXT_RAW):
                self._sysext_merge()
            else:
                decky.logger.warning("Mobile Mode: plasma-mobile.raw not found — shell may fall back to desktop")
            self._write_state("mobile")
            decky.logger.info("Mobile Mode: ready — frontend will switch session")
            return {"success": True}
        except Exception as e:
            decky.logger.error(f"Mobile Mode: enable failed — {e}")
            return {"success": False, "error": str(e)}

    async def disable_mobile(self) -> dict:
        """Switch back to Gaming Mode."""
        try:
            self._clear_state()
            self._restore_kwinrc()
            self._restore_plasmashellrc()
            self._set_default_session("plasma.desktop")
            self._switch_to_game()
            decky.logger.info("Mobile Mode: returned to gaming mode")
            return {"success": True}
        except Exception as e:
            decky.logger.error(f"Mobile Mode: disable failed — {e}")
            return {"success": False, "error": str(e)}

    async def get_status(self) -> dict:
        try:
            return {"success": True, "is_mobile": self._read_state() == "mobile"}
        except Exception as e:
            decky.logger.error(f"Mobile Mode: get_status failed — {e}")
            return {"success": False, "is_mobile": False, "error": str(e)}

    # ------------------------------------------------------------------
    # Decky lifecycle
    # ------------------------------------------------------------------

    async def _main(self):
        decky.logger.info(f"Mobile Mode loaded (uid={os.getuid()})")
        # Unmerge sysext first: while merged, /usr/ is overlayfs and the
        # bind-mount at /usr/local/ is hidden (read-only). Unmerge restores
        # writability so _install_session_files() can write mobile.desktop.
        self._sysext_unmerge()
        # Normalize state on every Gaming Mode start.
        # Handles the case where user returned via KDE "Return to Gaming" button
        # (which bypasses disable_mobile) — cleans kwinrc and resets default session.
        self._restore_kwinrc()
        self._restore_plasmashellrc()
        self._set_default_session("plasma.desktop")
        self._install_session_files()
        self._clear_state()

    async def _unload(self):
        decky.logger.info("Mobile Mode unloaded")

    async def _uninstall(self):
        decky.logger.info("Mobile Mode uninstalled")
        self._remove_session_files()

    async def _migration(self):
        decky.migrate_logs(os.path.join(MOBILE_CFG, "session.log"))

    # ------------------------------------------------------------------
    # steamosctl helpers
    # ------------------------------------------------------------------

    def _deck_env(self) -> dict:
        """Env with the deck user's D-Bus session bus.

        steamosctl talks to steamos-manager via the session bus, not the system bus.
        When running as root, DBUS_SESSION_BUS_ADDRESS is not set, so we point it
        at the deck user's socket under XDG_RUNTIME_DIR.
        """
        env = dict(_SYS_ENV)
        deck_uid = os.stat(decky.DECKY_USER_HOME).st_uid
        bus = f"/run/user/{deck_uid}/bus"
        if os.path.exists(bus):
            env["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={bus}"
        return env

    def _set_default_session(self, session_name: str):
        """Set the default Wayland session, with fallbacks for root context."""
        env = self._deck_env()

        # Direct steamosctl (works if D-Bus is accessible from this process)
        try:
            subprocess.run(
                ["steamosctl", "set-default-desktop-session", session_name],
                check=True, env=env, capture_output=True,
            )
            decky.logger.info(f"Mobile Mode: default session → {session_name} ✓")
            return
        except Exception:
            pass

        # Fallback: sudo -u deck (root can sudo to deck without password)
        try:
            subprocess.run(
                ["sudo", "-u", decky.DECKY_USER,
                 "--preserve-env=DBUS_SESSION_BUS_ADDRESS",
                 "steamosctl", "set-default-desktop-session", session_name],
                check=True, env=env, capture_output=True,
            )
            decky.logger.info(f"Mobile Mode: default session → {session_name} (sudo -u {decky.DECKY_USER}) ✓")
            return
        except Exception:
            pass

        # Last resort: write AccountsService config directly (root-only, no D-Bus needed)
        session_key = session_name.removesuffix(".desktop")
        cfg_path = f"/var/lib/AccountsService/users/{decky.DECKY_USER}"
        cfg = configparser.ConfigParser()
        cfg.read(cfg_path)
        if not cfg.has_section("User"):
            cfg.add_section("User")
        cfg.set("User", "Session", session_key)
        cfg.set("User", "XSession", session_key)
        with open(cfg_path, "w") as f:
            cfg.write(f)
        decky.logger.info(f"Mobile Mode: default session → {session_key} (AccountsService) ✓")

    def _switch_to_game(self):
        """Switch to Gaming Mode.

        Broken pipe (rc=-13) is treated as success: when the switch works,
        the current KDE session is torn down and breaks the subprocess pipe.
        """
        env = self._deck_env()
        result = subprocess.run(
            ["steamosctl", "switch-to-game-mode"], env=env, capture_output=True
        )
        if result.returncode not in (0, 1, -13):
            raise subprocess.CalledProcessError(result.returncode, "steamosctl switch-to-game-mode")
        decky.logger.info(f"Mobile Mode: switch-to-game-mode rc={result.returncode} ✓")

    # ------------------------------------------------------------------
    # systemd-sysext helpers
    # ------------------------------------------------------------------

    def _sysext_env(self) -> dict:
        """Clean env for systemd-sysext — strips Decky/PyInstaller library paths.

        Decky bundles Python via PyInstaller which sets LD_LIBRARY_PATH to its
        temp dir. systemd-sysext then loads the wrong libcrypto.so.3 and crashes.
        """
        env = dict(_SYS_ENV)
        env.pop("LD_LIBRARY_PATH", None)
        env.pop("LD_PRELOAD", None)
        return env

    def _sysext_merge(self):
        """Merge /var/lib/extensions into /usr (idempotent)."""
        result = subprocess.run(
            ["systemd-sysext", "merge"],
            env=self._sysext_env(), capture_output=True, text=True,
        )
        if result.returncode == 0:
            decky.logger.info("Mobile Mode: sysext merged ✓")
        elif "already merged" in result.stderr.lower():
            decky.logger.info("Mobile Mode: sysext already merged")
        else:
            raise RuntimeError(f"systemd-sysext merge failed (rc={result.returncode}): {result.stderr.strip()}")

    def _sysext_unmerge(self):
        """Unmerge sysext extensions from /usr (idempotent, ignores 'not merged')."""
        result = subprocess.run(
            ["systemd-sysext", "unmerge"],
            env=self._sysext_env(), capture_output=True, text=True,
        )
        if result.returncode == 0:
            decky.logger.info("Mobile Mode: sysext unmerged ✓")
        elif "not merged" in result.stderr.lower():
            decky.logger.info("Mobile Mode: sysext was not merged")
        else:
            decky.logger.warning(f"Mobile Mode: sysext unmerge rc={result.returncode}: {result.stderr.strip()}")

    # ------------------------------------------------------------------
    # File management
    # ------------------------------------------------------------------

    def _install_session_files(self):
        """Copy session assets to their target locations."""
        deck_uid = os.stat(decky.DECKY_USER_HOME).st_uid
        deck_gid = os.stat(decky.DECKY_USER_HOME).st_gid

        for d in (MOBILE_CFG, AUTOSTART, APPS_DIR):
            os.makedirs(d, exist_ok=True)
            os.chown(d, deck_uid, deck_gid)

        for src_name, dst_path, mode in [
            ("startplasma-mobile.sh",    os.path.join(MOBILE_CFG, "startplasma-mobile.sh"),      0o755),
            ("mobile-mode-init.sh",      os.path.join(MOBILE_CFG, "mobile-mode-init.sh"),        0o755),
            ("mobile-mode-init.desktop", os.path.join(AUTOSTART,  "mobile-mode-init.desktop"),   0o644),
            ("return-to-gaming.sh",      os.path.join(MOBILE_CFG, "return-to-gaming.sh"),        0o755),
            ("return-to-gaming.desktop", os.path.join(APPS_DIR,   "return-to-gaming.desktop"),   0o644),
        ]:
            shutil.copy(os.path.join(ASSETS_DIR, src_name), dst_path)
            os.chmod(dst_path, mode)
            os.chown(dst_path, deck_uid, deck_gid)

        os.makedirs(LOCAL_SESSIONS_DIR, exist_ok=True)
        shutil.copy(os.path.join(ASSETS_DIR, "mobile.desktop"), LOCAL_MOBILE_DESKTOP)

        decky.logger.info("Mobile Mode: session files installed")

    def _remove_session_files(self):
        """Clean up installed files on uninstall."""
        for path in [
            LOCAL_MOBILE_DESKTOP,
            os.path.join(AUTOSTART, "mobile-mode-init.desktop"),
            os.path.join(APPS_DIR,  "return-to-gaming.desktop"),
        ]:
            try:
                os.remove(path)
            except FileNotFoundError:
                pass
        shutil.rmtree(MOBILE_CFG, ignore_errors=True)
        decky.logger.info("Mobile Mode: session files removed")

    def _restore_kwinrc(self):
        """Remove the InputMethod line we wrote to kwinrc during mobile session."""
        kwinrc = os.path.join(decky.DECKY_USER_HOME, ".config", "kwinrc")
        if not os.path.exists(kwinrc):
            return
        try:
            with open(kwinrc) as f:
                lines = f.readlines()
            cleaned = [l for l in lines if not l.strip().startswith("InputMethod=")]
            with open(kwinrc, "w") as f:
                f.writelines(cleaned)
            deck_uid = os.stat(decky.DECKY_USER_HOME).st_uid
            deck_gid = os.stat(decky.DECKY_USER_HOME).st_gid
            os.chown(kwinrc, deck_uid, deck_gid)
            decky.logger.info("Mobile Mode: kwinrc restored")
        except Exception as e:
            decky.logger.warning(f"Mobile Mode: kwinrc restore failed — {e}")

    def _set_mobile_shell_config(self):
        """Write plasmashellrc to use the mobile shell package.

        Done from Python (not from startplasma-mobile.sh) to guarantee the file
        is written before the KDE session starts reading it.
        """
        plasmashellrc = os.path.join(decky.DECKY_USER_HOME, ".config", "plasmashellrc")
        deck_uid = os.stat(decky.DECKY_USER_HOME).st_uid
        deck_gid = os.stat(decky.DECKY_USER_HOME).st_gid
        cfg = configparser.ConfigParser()
        cfg.read(plasmashellrc)
        if not cfg.has_section("General"):
            cfg.add_section("General")
        cfg.set("General", "ShellPackage", "org.kde.plasma.mobileshell")
        with open(plasmashellrc, "w") as f:
            cfg.write(f)
        os.chown(plasmashellrc, deck_uid, deck_gid)
        decky.logger.info("Mobile Mode: plasmashellrc → org.kde.plasma.mobileshell ✓")

    def _restore_plasmashellrc(self):
        """Reset ShellPackage in plasmashellrc to default (plasma-desktop).

        startplasma-mobile.sh sets ShellPackage=org.kde.plasma.mobileshell.
        We must restore it on Gaming Mode start so next Desktop Mode session
        gets the normal plasma-desktop shell, not the mobile one.
        """
        plasmashellrc = os.path.join(decky.DECKY_USER_HOME, ".config", "plasmashellrc")
        if not os.path.exists(plasmashellrc):
            return
        try:
            subprocess.run(
                ["kwriteconfig6", "--file", plasmashellrc,
                 "--group", "General", "--key", "ShellPackage", "org.kde.plasma.desktoppackage"],
                env=_SYS_ENV, check=True, capture_output=True,
            )
            deck_uid = os.stat(decky.DECKY_USER_HOME).st_uid
            deck_gid = os.stat(decky.DECKY_USER_HOME).st_gid
            os.chown(plasmashellrc, deck_uid, deck_gid)
            decky.logger.info("Mobile Mode: plasmashellrc restored")
        except Exception as e:
            decky.logger.warning(f"Mobile Mode: plasmashellrc restore failed — {e}")

    def _write_state(self, state: str):
        os.makedirs(MOBILE_CFG, exist_ok=True)
        with open(MODE_STATE_FILE, "w") as f:
            f.write(state)
        deck_uid = os.stat(decky.DECKY_USER_HOME).st_uid
        deck_gid = os.stat(decky.DECKY_USER_HOME).st_gid
        os.chown(MODE_STATE_FILE, deck_uid, deck_gid)

    def _clear_state(self):
        try:
            os.remove(MODE_STATE_FILE)
        except FileNotFoundError:
            pass

    def _read_state(self) -> str:
        try:
            with open(MODE_STATE_FILE) as f:
                return f.read().strip()
        except FileNotFoundError:
            return ""
