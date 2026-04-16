import {
  PanelSection,
  PanelSectionRow,
  ToggleField,
  staticClasses,
} from "@decky/ui";
import {
  callable,
  definePlugin,
} from "@decky/api";
import { useState, useEffect } from "react";
import { FaMobileAlt } from "react-icons/fa";

// ------------------------------------------------------------------
// Backend callables
// ------------------------------------------------------------------

const enableMobile  = callable<[], { success: boolean; error?: string }>("enable_mobile");
const disableMobile = callable<[], { success: boolean; error?: string }>("disable_mobile");
const getStatus     = callable<[], { success: boolean; is_mobile: boolean; error?: string }>("get_status");

// ------------------------------------------------------------------
// Webpack helpers
// ------------------------------------------------------------------

type WpRequire = ((id: string) => any) & {
  m: Record<string, (...a: any[]) => any>;
};

function getWpRequire(): WpRequire | null {
  let req: WpRequire | null = null;
  try {
    (window as any).webpackChunksteamui?.push?.([[Symbol()], {}, (r: WpRequire) => { req = r; }]);
  } catch { /* not available */ }
  return req;
}

// Find the session-switching API (module 90389, export Bd in Steam Apr-2026 build).
// Identified by content: module exports an object with a SwitchToDesktop method.
// Same API the native "Switch to Desktop" button calls — update-resistant.
function findSessionSwitcher(): { SwitchToDesktop: (opts: object) => void } | null {
  const req = getWpRequire();
  if (!req) return null;
  // Search cached modules first — safe, no side effects.
  const cache: Record<string, { exports: any }> = (req as any).c ?? {};
  for (const id of Object.keys(cache)) {
    try {
      const mod = cache[id]?.exports;
      for (const key of Object.keys(mod || {})) {
        if (typeof mod[key]?.SwitchToDesktop === "function") {
          console.log(`[MobileMode] SwitchToDesktop: module ${id} export ${key}`);
          return mod[key];
        }
      }
    } catch { /* skip */ }
  }
  // Fallback: load module 90389 explicitly — known safe (just exports the API, no side effects).
  try {
    const mod = req("90389");
    for (const key of Object.keys(mod || {})) {
      if (typeof mod[key]?.SwitchToDesktop === "function") {
        console.log(`[MobileMode] SwitchToDesktop: module 90389 export ${key} (explicit load)`);
        return mod[key];
      }
    }
  } catch { /* skip */ }
  console.warn("[MobileMode] SwitchToDesktop not found");
  return null;
}

// ------------------------------------------------------------------
// QAM Panel
// ------------------------------------------------------------------

function Content() {
  const [isMobile, setIsMobile]   = useState<boolean>(false);
  const [loading, setLoading]     = useState<boolean>(true);
  const [switching, setSwitching] = useState<boolean>(false);
  const [error, setError]         = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const status = await getStatus();
      if (status.success) setIsMobile(status.is_mobile);
      setLoading(false);
    })();
  }, []);

  const handleToggle = async () => {
    if (switching) return;
    setSwitching(true);
    setError(null);
    try {
      if (isMobile) {
        const result = await disableMobile();
        if (!result.success) setError(result.error ?? "Unknown error");
      } else {
        const result = await enableMobile();
        if (result.success) {
          _sessionSwitcher?.SwitchToDesktop({});
        } else {
          setError(result.error ?? "Unknown error");
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSwitching(false);
    }
  };

  if (loading) {
    return (
      <PanelSection>
        <PanelSectionRow>
          <div style={{ textAlign: "center", opacity: 0.6 }}>Loading…</div>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  return (
    <PanelSection title="Mobile Mode">
      <PanelSectionRow>
        <ToggleField
          label={isMobile ? "Mobile Mode active" : "Switch to Mobile Mode"}
          description={
            switching
              ? (isMobile ? "Returning to Gaming Mode…" : "Closing Steam session…")
              : (isMobile
                  ? "Portrait · touch-first KDE session"
                  : "Portrait orientation · Maliit keyboard · touch UI")
          }
          checked={isMobile}
          onChange={handleToggle}
          disabled={loading || switching}
        />
      </PanelSectionRow>

      {!isMobile && !switching && (
        <PanelSectionRow>
          <div style={{ fontSize: "0.8em", opacity: 0.5, lineHeight: 1.4 }}>
            Steam will close to switch sessions. Use "Return to Gaming" inside KDE to come back.
          </div>
        </PanelSectionRow>
      )}

      {isMobile && !switching && (
        <PanelSectionRow>
          <div style={{ fontSize: "0.8em", opacity: 0.5, lineHeight: 1.4 }}>
            Use "Return to Gaming" inside KDE to switch back.
          </div>
        </PanelSectionRow>
      )}

      {error && (
        <PanelSectionRow>
          <div style={{ color: "#ff6b6b", fontSize: "0.85em" }}>⚠ {error}</div>
        </PanelSectionRow>
      )}
    </PanelSection>
  );
}

// ------------------------------------------------------------------
// Plugin entry point
// ------------------------------------------------------------------

let _sessionSwitcher: { SwitchToDesktop: (opts: object) => void } | null = null;

export default definePlugin(() => {
  console.log("[MobileMode] Plugin initialising");
  _sessionSwitcher = findSessionSwitcher();

  return {
    name: "Mobile Mode",
    titleView: <div className={staticClasses.Title}>Mobile Mode</div>,
    content: <Content />,
    icon: <FaMobileAlt />,
    onDismount() {
      console.log("[MobileMode] Plugin dismounting");
      _sessionSwitcher = null;
    },
  };
});
