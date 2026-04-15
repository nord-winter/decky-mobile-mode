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

# Explicit PATH — Decky's systemd unit has a restricted PATH.
_SYS_ENV = dict(os.environ, PATH="/usr/bin:/usr/local/bin:/bin:/usr/sbin:/sbin")


class Plugin:

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def enable_mobile(self) -> dict:
        """Install session files and set the default session to mobile.desktop.

        The frontend calls SwitchToDesktop() via the Steam webpack API after this
        returns — the same path the native 'Switch to Desktop' button uses.
        """
        try:
            self._install_session_files()
            self._set_default_session("mobile.desktop")
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
        self._install_session_files()

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
        if result.returncode not in (0, -13):
            raise subprocess.CalledProcessError(result.returncode, "steamosctl switch-to-game-mode")
        decky.logger.info(f"Mobile Mode: switch-to-game-mode rc={result.returncode} ✓")

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
