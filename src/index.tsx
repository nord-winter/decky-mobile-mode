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
// Power Menu patch
//
// Research (CEF DevTools, SteamOS 3.8.2, Steam build Apr 11 2026):
//
//   showContextMenu — module 31084, export 'lX'
//     Identified by: 'CreateContextMenuInstance' + 'GetContextMenuManagerFromWindow'
//     Verified unique: only one module matches → update-resistant
//
//   Power Menu component 'ne' — module 38258, NOT exported (closure variable)
//     d4 calls: T.lX(jsx(ne, {onCancel}), browserWindow, {onCancel})
//     ne = React.memo(fn), ne.type.writable = true → afterPatch works
//     Identified by: element.type.type.toString() contains 'ShutdownPC' + 'IN_GAMESCOPE'
//     Verified unique: only one module matches → update-resistant
//
//   "Switch to Desktop" button in ne's render:
//     Last child of Power Menu children array — a Fragment containing:
//       <Separator />
//       <MenuItem feature={16} tone="destructive">Switch to Desktop</MenuItem>
//     Only rendered when P = IN_GAMESCOPE && !kiosk && !lockScreen && ...
//
// Strategy (no hardcoded module IDs):
//   1. Find showContextMenu via content search
//   2. Intercept it — on first Power Menu call capture 'ne', restore immediately
//   3. afterPatch(ne, 'type') — inject 'Switch to Mobile' into the Fragment
// ------------------------------------------------------------------

// req.c is the webpack module cache: Record<id, { exports: any }>
type WpRequire = ((id: string) => any) & {
  m: Record<string, (...a: any[]) => any>;
  c: Record<string, { exports: any }>;
};

function getWpRequire(): WpRequire | null {
  let req: WpRequire | null = null;
  try {
    (window as any).webpackChunksteamui?.push?.([[Symbol()], {}, (r: WpRequire) => { req = r; }]);
  } catch { /* not available */ }
  return req;
}

// Find the module that exports showContextMenu, identified by unique content strings.
// Returns { id, mod, key } — id needed to access the module cache entry.
function findShowContextMenuExport(req: WpRequire): { id: string; mod: any; key: string } | null {
  for (const id of Object.keys(req.m)) {
    try {
      const src = req.m[id].toString();
      if (!src.includes('CreateContextMenuInstance') || !src.includes('GetContextMenuManagerFromWindow')) continue;
      const mod = req(id);
      for (const key of Object.keys(mod)) {
        try {
          const fn = mod[key];
          if (typeof fn === 'function' && fn.toString().includes('CreateContextMenuInstance')) {
            return { id, mod, key };
          }
        } catch { /* getter may throw */ }
      }
    } catch { /* skip broken modules */ }
  }
  return null;
}

// True when element is the Power Menu React element (ne wrapped in jsx).
// Uses content strings that are stable across Steam updates.
function isPowerMenuElement(element: any): boolean {
  try {
    const src: string =
      element?.type?.type?.toString?.() ??
      element?.type?.toString?.() ??
      "";
    return src.includes("ShutdownPC") && src.includes("IN_GAMESCOPE");
  } catch { return false; }
}

// Inject "Switch to Mobile" button into the rendered Power Menu JSX tree.
// The tree structure: <Dialog><children[]></Dialog>
// The last child (when visible) is a Fragment: [<Separator/>, <MenuItem feature=16>Switch to Desktop</MenuItem>]
// We add our button into that same Fragment.
function injectMobileButton(ret: any): any {
  try {
    const children: any[] = ret?.props?.children;
    if (!Array.isArray(children)) return ret;

    for (const child of children) {
      const fragChildren: any[] = child?.props?.children;
      if (!Array.isArray(fragChildren)) continue;

      // Find the Switch to Desktop button (feature=16, tone="destructive")
      const switchBtn = fragChildren.find(
        (c: any) => c?.props?.feature === 16 && c?.props?.tone === "destructive"
      );
      if (!switchBtn) continue;

      // Guard against double-injection on re-renders
      if (fragChildren.some((c: any) => c?.key === "mobile-mode-btn")) return ret;

      // Clone the Switch to Desktop button with our props
      const mobileBtn = {
        ...switchBtn,
        key: "mobile-mode-btn",
        props: {
          ...switchBtn.props,
          onSelected: async () => {
            try { await enableMobile(); } catch (e) { console.error("[MobileMode]", e); }
          },
          children: "Switch to Mobile",
        },
      };

      child.props.children = [...fragChildren, mobileBtn];
      return ret;
    }
  } catch (e) {
    console.error("[MobileMode] injectMobileButton error:", e);
  }
  return ret;
}

// Set up the Power Menu patch. Returns a cleanup function.
//
// lX (showContextMenu) is exported with configurable:false — cannot use defineProperty.
// Instead, replace the entire module cache entry (req.c[id].exports) with a Proxy.
// The Proxy intercepts reads of 'lX' and returns a wrapper that captures 'ne' on the
// first Power Menu call, then restores the original exports and applies afterPatch.
function patchPowerMenu(): () => void {
  const req = getWpRequire();
  if (!req) {
    console.warn("[MobileMode] webpackChunksteamui not available — Power Menu patch skipped");
    return () => {};
  }

  const showCM = findShowContextMenuExport(req);
  if (!showCM) {
    console.warn("[MobileMode] showContextMenu not found — Power Menu patch skipped");
    return () => {};
  }

  const { id, mod: origExports, key } = showCM;
  console.log("[MobileMode] found showCM id:", id, "key:", key,
    "req.c type:", typeof (req as any).c,
    "cacheEntry:", (req as any).c?.[id]);

  let neUnpatch: (() => void) | null = null;
  let interceptDone = false;

  const makeWrapper = (origFn: (...args: any[]) => any, onCapture: () => void) =>
    function (this: unknown, ...args: any[]) {
      if (!interceptDone && isPowerMenuElement(args[0])) {
        interceptDone = true;
        onCapture();
        const ne = args[0].type; // React.memo(fn)
        neUnpatch = afterPatch(ne as Record<string, unknown>, "type", (_args: any[], ret: any) =>
          injectMobileButton(ret)
        ) as unknown as () => void;
        console.log("[MobileMode] Power Menu patched ✓");
      }
      return origFn.apply(this, args);
    };

  // Strategy 1: Proxy via module cache (req.c)
  const cacheEntry = req.c?.[id];
  if (cacheEntry) {
    const origFn = origExports[key] as (...args: any[]) => any;
    const proxied = new Proxy(origExports, {
      get(target: any, prop: string) {
        if (prop === key && !interceptDone) {
          return makeWrapper(origFn, () => { cacheEntry.exports = origExports; });
        }
        return target[prop];
      },
    });
    cacheEntry.exports = proxied;
    console.log("[MobileMode] Using Proxy strategy");
    return () => {
      if (!interceptDone) cacheEntry.exports = origExports;
      neUnpatch?.();
      console.log("[MobileMode] Power Menu patch removed");
    };
  }

  // Strategy 2: Object.defineProperty (fallback when req.c unavailable)
  console.log("[MobileMode] req.c not accessible, trying defineProperty");
  const origFn = origExports[key] as (...args: any[]) => any;
  if (typeof origFn !== "function") {
    console.warn("[MobileMode] showContextMenu[key] is not a function — patch skipped");
    return () => {};
  }

  const wrapper = makeWrapper(origFn, () => {
    try {
      Object.defineProperty(origExports, key, { value: origFn, writable: true, configurable: true, enumerable: true });
    } catch { /* best-effort restore */ }
  });

  try {
    Object.defineProperty(origExports, key, { get: () => wrapper, configurable: true, enumerable: true });
    console.log("[MobileMode] Using defineProperty strategy");
  } catch (e) {
    console.warn("[MobileMode] defineProperty also failed:", e, "— patch skipped");
    return () => {};
  }

  return () => {
    if (!interceptDone) {
      try {
        Object.defineProperty(origExports, key, { value: origFn, writable: true, configurable: true, enumerable: true });
      } catch { /* best-effort */ }
    }
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
      const result = isMobile ? await disableMobile() : await enableMobile();
      if (!result.success) setError(result.error ?? "Unknown error");
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
          disabled={switching}
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
          <div style={{ color: "#ff6b6b", fontSize: "0.85em" }}>
            Error: {error}
          </div>
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

export default definePlugin(() => {
  console.log("[MobileMode] Plugin initialising");
  _unpatch = patchPowerMenu();

  return {
    name: "Mobile Mode",
    titleView: <div className={staticClasses.Title}>Mobile Mode</div>,
    content: <Content />,
    icon: <FaMobileAlt />,
    onDismount() {
      console.log("[MobileMode] Plugin dismounting");
      _unpatch?.();
      _unpatch = null;
    },
  };
});
