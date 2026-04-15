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

type WpRequire = ((id: string) => any) & { m: Record<string, (...a: any[]) => any> };

function getWpRequire(): WpRequire | null {
  let req: WpRequire | null = null;
  try {
    (window as any).webpackChunksteamui?.push?.([[Symbol()], {}, (r: WpRequire) => { req = r; }]);
  } catch { /* not available */ }
  return req;
}

// Find the module that exports showContextMenu, identified by unique content strings.
// Returns { mod: exports object, key: property name } so we can patch the property.
function findShowContextMenuExport(req: WpRequire): { mod: any; key: string } | null {
  for (const id of Object.keys(req.m)) {
    try {
      const src = req.m[id].toString();
      if (!src.includes('CreateContextMenuInstance') || !src.includes('GetContextMenuManagerFromWindow')) continue;
      const mod = req(id);
      for (const key of Object.keys(mod)) {
        const fn = mod[key];
        if (typeof fn === 'function' && fn.toString().includes('CreateContextMenuInstance')) {
          return { mod, key };
        }
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

  const { mod, key } = showCM;
  const orig = mod[key] as (...args: any[]) => any;
  let neUnpatch: (() => void) | null = null;
  let interceptDone = false;

  // Step 1: intercept showContextMenu to capture 'ne'
  mod[key] = function (...args: any[]) {
    if (!interceptDone && isPowerMenuElement(args[0])) {
      interceptDone = true;
      mod[key] = orig; // restore immediately

      const ne = args[0].type; // React.memo component

      // Step 2: patch ne.type to inject our button on every render
      neUnpatch = afterPatch(ne as Record<string, unknown>, "type", (_args: any[], ret: any) =>
        injectMobileButton(ret)
      ) as unknown as () => void;

      console.log("[MobileMode] Power Menu patched ✓");
    }
    return orig.apply(this, args);
  };

  // Cleanup: restore showContextMenu intercept if never triggered,
  // and remove the ne.type patch
  return () => {
    if (!interceptDone) mod[key] = orig;
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
