import {
  PanelSection,
  PanelSectionRow,
  ToggleField,
  staticClasses,
  afterPatch,
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
// Power Menu patch
//
// Power Menu component 'ne' (module 38258, Steam Apr-2026) is not exported.
// We capture it by wrapping React.createElement and jsx/jsxs and checking
// each element type for the 'ShutdownPC' + 'IN_GAMESCOPE' fingerprint.
// On first match: restore the originals, apply afterPatch(ne, 'type').
//
// ne.type is plain writable → afterPatch works.
// Identification is content-based → update-resistant (no hardcoded module IDs).
// ------------------------------------------------------------------

function injectMobileButton(ret: any): any {
  try {
    const children: any[] = ret?.props?.children;
    if (!Array.isArray(children)) return ret;

    for (const child of children) {
      const fragChildren: any[] = child?.props?.children;
      if (!Array.isArray(fragChildren)) continue;

      // "Switch to Desktop" button: feature=16, tone="destructive"
      const switchBtn = fragChildren.find(
        (c: any) => c?.props?.feature === 16 && c?.props?.tone === "destructive"
      );
      if (!switchBtn) continue;

      // Guard against double-injection on re-renders
      if (fragChildren.some((c: any) => c?.key === "mobile-mode-btn")) return ret;

      const mobileBtn = {
        ...switchBtn,
        key: "mobile-mode-btn",
        props: {
          ...switchBtn.props,
          onSelected: async () => {
            try {
              const result = await enableMobile();
              if (result.success) {
                _sessionSwitcher?.SwitchToDesktop({});
              } else {
                console.error("[MobileMode] enable failed:", result.error);
              }
            } catch (e) {
              console.error("[MobileMode]", e);
            }
          },
          children: "Switch to Mobile",
        },
      };

      child.props.children = [...fragChildren, mobileBtn];
      return ret;
    }
  } catch (e) {
    console.error("[MobileMode] injectMobileButton:", e);
  }
  return ret;
}

function patchPowerMenu(): () => void {
  const req = getWpRequire();

  let neUnpatch: (() => void) | null = null;
  let interceptDone = false;
  let domObserver: MutationObserver | null = null;

  const captureNe = (ne: any) => {
    if (interceptDone) return;
    interceptDone = true;
    domObserver?.disconnect(); domObserver = null;
    restoreJsx();
    neUnpatch = afterPatch(
      ne as Record<string, unknown>,
      "type",
      (_args: any[], ret: any) => injectMobileButton(ret)
    ) as unknown as () => void;
    console.log("[MobileMode] Power Menu patched ✓");
  };

  // Fingerprint: ne.type contains these strings (verified Apr-2026 Steam build).
  const isNe = (type: any): boolean => {
    try {
      const src: string = type?.type?.toString?.() ?? "";
      return src.includes("isKioskModeLocked") && src.includes("IsLockScreenActive");
    } catch { return false; }
  };

  // Strategy A (PRIMARY): DOM MutationObserver + React fiber ancestry walk.
  //
  // When the Power Menu context menu is rendered, React attaches a fiber key
  // (__reactFiber$...) to each DOM element. We observe any DOM additions,
  // get the fiber from the element, and walk UP via fiber.return until we
  // find the ne component (identified by its function body fingerprint).
  //
  // Update-resistant: no webpack module IDs, no jsx import pattern assumptions,
  // no DevTools hook requirement — works in production.
  const scanElement = (el: Element): boolean => {
    const fiberKey = Object.keys(el).find(k => k.startsWith("__reactFiber"));
    if (!fiberKey) return false;
    let fiber = (el as any)[fiberKey];
    while (fiber) {
      if (isNe(fiber.type)) { captureNe(fiber.type); return true; }
      fiber = fiber.return;
    }
    return false;
  };

  const scanSubtree = (root: Element): void => {
    if (interceptDone) return;
    if (scanElement(root)) return;
    for (const child of Array.from(root.querySelectorAll("*"))) {
      if (interceptDone) return;
      if (scanElement(child as Element)) return;
    }
  };

  domObserver = new MutationObserver((mutations) => {
    if (interceptDone) { domObserver?.disconnect(); return; }
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (interceptDone) return;
        if (node instanceof Element) scanSubtree(node);
      }
    }
  });
  // subtree: true — context menus may be portaled into nested containers, not directly into body.
  domObserver.observe(document.body, { childList: true, subtree: true });
  console.log("[MobileMode] DOM observer active");

  // Strategy B (BACKUP): jsx-runtime wrapping (cached modules only — avoids side effects).
  // Catches jsx(ne, ...) if the DOM observer misses for any reason.
  let jsxMod: any = null;
  let origJsx: any, origJsxs: any;
  if (req) {
    const cache: Record<string, { exports: any }> = (req as any).c ?? {};
    for (const id of Object.keys(cache)) {
      try {
        const m = cache[id]?.exports;
        // jsx-runtime exports jsx + jsxs; Fragment may or may not be present.
        if (typeof m?.jsx === "function" && typeof m?.jsxs === "function" && !m?.createElement) {
          jsxMod = m;
          console.log("[MobileMode] jsx-runtime: module", id);
          break;
        }
      } catch { /* skip */ }
    }
    if (!jsxMod) console.warn("[MobileMode] jsx-runtime not found in cache — DOM observer only");
  }

  const restoreJsx = () => {
    if (jsxMod) { try { jsxMod.jsx = origJsx; jsxMod.jsxs = origJsxs; } catch { /**/ } }
  };

  if (jsxMod) {
    origJsx = jsxMod.jsx; origJsxs = jsxMod.jsxs;
    const wrap = (orig: (...a: any[]) => any) =>
      function (this: unknown, type: any, ...rest: any[]): any {
        if (!interceptDone && isNe(type)) captureNe(type);
        return orig.call(this, type, ...rest);
      };
    try { jsxMod.jsx = wrap(origJsx); jsxMod.jsxs = wrap(origJsxs); }
    catch (e) { console.warn("[MobileMode] jsx-runtime wrap failed:", e); }
  }

  console.log("[MobileMode] interceptors active — open Power Menu once to complete patch");

  return () => {
    domObserver?.disconnect(); domObserver = null;
    restoreJsx();
    neUnpatch?.();
    console.log("[MobileMode] Power Menu patch removed");
  };
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
          label={isMobile ? "Mobile Mode active" : "Mobile Mode off"}
          description={
            isMobile
              ? "Running touch-optimised KDE session"
              : "Switch to vertical, touch-first KDE session"
          }
          checked={isMobile}
          onChange={handleToggle}
          disabled={loading || switching}
        />
      </PanelSectionRow>

      {switching && (
        <PanelSectionRow>
          <div style={{ textAlign: "center", opacity: 0.6 }}>
            {isMobile ? "Returning to Gaming Mode…" : "Switching to Mobile Mode…"}
          </div>
        </PanelSectionRow>
      )}

      {error && (
        <PanelSectionRow>
          <div style={{ color: "#ff6b6b", fontSize: "0.85em" }}>Error: {error}</div>
        </PanelSectionRow>
      )}

      <PanelSectionRow>
        <div style={{ fontSize: "0.8em", opacity: 0.5, lineHeight: 1.4 }}>
          {isMobile
            ? "Use 'Return to Gaming' inside KDE to switch back."
            : "Portrait orientation · Maliit keyboard · full Linux apps"}
        </div>
      </PanelSectionRow>
    </PanelSection>
  );
}

// ------------------------------------------------------------------
// Plugin entry point
// ------------------------------------------------------------------

let _unpatch: (() => void) | null = null;
let _sessionSwitcher: { SwitchToDesktop: (opts: object) => void } | null = null;

export default definePlugin(() => {
  console.log("[MobileMode] Plugin initialising");
  _unpatch = patchPowerMenu();
  _sessionSwitcher = findSessionSwitcher();

  return {
    name: "Mobile Mode",
    titleView: <div className={staticClasses.Title}>Mobile Mode</div>,
    content: <Content />,
    icon: <FaMobileAlt />,
    onDismount() {
      console.log("[MobileMode] Plugin dismounting");
      _unpatch?.();
      _unpatch = null;
      _sessionSwitcher = null;
    },
  };
});
