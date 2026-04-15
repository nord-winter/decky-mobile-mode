import os
import shutil
import subprocess

import decky

PLUGIN_DIR   = os.path.dirname(os.path.abspath(__file__))
ASSETS_DIR   = os.path.join(PLUGIN_DIR, "assets")
SESSIONS_DIR = "/usr/share/wayland-sessions"
MOBILE_CFG   = os.path.expanduser("~/.config/mobile-mode")
AUTOSTART    = os.path.expanduser("~/.config/autostart-scripts")
APPS_DIR     = os.path.expanduser("~/.local/share/applications")

MOBILE_DESKTOP  = os.path.join(SESSIONS_DIR, "mobile.desktop")
MODE_STATE_FILE = os.path.join(MOBILE_CFG, "active_mode")  # "mobile" | absent


class Plugin:

    # ------------------------------------------------------------------
    # Public API (callable from TypeScript via @decky/api)
    # ------------------------------------------------------------------

    async def enable_mobile(self) -> dict:
        """Install session files and switch to Mobile Mode."""
        try:
            self._install_session_files()
            self._write_state("mobile")
            subprocess.run(["steamosctl", "switch-to-desktop-mode"], check=True)
            decky.logger.info("Mobile Mode: switched to mobile session")
            return {"success": True}
        except Exception as e:
            decky.logger.error(f"Mobile Mode: enable failed — {e}")
            return {"success": False, "error": str(e)}

    async def disable_mobile(self) -> dict:
        """Switch back to Gaming Mode."""
        try:
            self._clear_state()
            subprocess.run(["steamosctl", "switch-to-game-mode"], check=True)
            decky.logger.info("Mobile Mode: returned to gaming mode")
            return {"success": True}
        except Exception as e:
            decky.logger.error(f"Mobile Mode: disable failed — {e}")
            return {"success": False, "error": str(e)}

    async def get_status(self) -> dict:
        """Return whether Mobile Mode is currently active.

        The plugin only runs inside Gaming Mode (Gamescope/Decky context),
        so is_mobile is always False on a fresh load. We persist a state
        file so the QAM can reflect intent even across restarts.
        """
        try:
            is_mobile = self._read_state() == "mobile"
            return {"success": True, "is_mobile": is_mobile}
        except Exception as e:
            decky.logger.error(f"Mobile Mode: get_status failed — {e}")
            return {"success": False, "is_mobile": False, "error": str(e)}

    async def ensure_files_installed(self) -> dict:
        """Re-install session files. Called on plugin load to survive SteamOS updates."""
        try:
            self._install_session_files()
            return {"success": True}
        except Exception as e:
            decky.logger.error(f"Mobile Mode: ensure_files_installed failed — {e}")
            return {"success": False, "error": str(e)}

    # ------------------------------------------------------------------
    # Decky lifecycle
    # ------------------------------------------------------------------

    async def _main(self):
        decky.logger.info("Mobile Mode plugin loaded")
        # Re-install session files on every load so SteamOS updates don't break us
        self._install_session_files()

    async def _unload(self):
        decky.logger.info("Mobile Mode plugin unloaded")

    async def _uninstall(self):
        decky.logger.info("Mobile Mode plugin uninstalled — cleaning up session files")
        self._remove_session_files()

    async def _migration(self):
        decky.logger.info("Mobile Mode: running migration")
        decky.migrate_logs(
            os.path.join(decky.DECKY_USER_HOME, ".config", "mobile-mode", "session.log")
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _install_session_files(self):
        """Copy all session assets to their target locations."""
        os.makedirs(MOBILE_CFG, exist_ok=True)
        os.makedirs(AUTOSTART, exist_ok=True)
        os.makedirs(APPS_DIR, exist_ok=True)

        # Session launcher
        src = os.path.join(ASSETS_DIR, "startplasma-mobile.sh")
        dst = os.path.join(MOBILE_CFG, "startplasma-mobile.sh")
        shutil.copy(src, dst)
        os.chmod(dst, 0o755)

        # KDE autostart (rotation + maliit)
        src = os.path.join(ASSETS_DIR, "mobile-mode-init.sh")
        dst = os.path.join(AUTOSTART, "mobile-mode-init.sh")
        shutil.copy(src, dst)
        os.chmod(dst, 0o755)

        # Return to Gaming helper
        src = os.path.join(ASSETS_DIR, "return-to-gaming.sh")
        dst = os.path.join(MOBILE_CFG, "return-to-gaming.sh")
        shutil.copy(src, dst)
        os.chmod(dst, 0o755)

        src = os.path.join(ASSETS_DIR, "return-to-gaming.desktop")
        dst = os.path.join(APPS_DIR, "return-to-gaming.desktop")
        shutil.copy(src, dst)

        # mobile.desktop goes to /usr/share/wayland-sessions/ which is read-only on SteamOS.
        # Install it once manually via SSH:
        #   sudo cp <plugin>/assets/mobile.desktop /usr/share/wayland-sessions/
        if not os.path.exists(MOBILE_DESKTOP):
            decky.logger.warning(
                "Mobile Mode: mobile.desktop not found at "
                f"{MOBILE_DESKTOP} — install manually via SSH"
            )

        decky.logger.info("Mobile Mode: session files installed")

    def _remove_session_files(self):
        """Clean up all installed files on uninstall."""
        for path in [
            MOBILE_DESKTOP,
            os.path.join(AUTOSTART, "mobile-mode-init.sh"),
            os.path.join(APPS_DIR, "return-to-gaming.desktop"),
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
