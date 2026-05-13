import { useState, useCallback, useRef, useEffect } from "react";
import { useWebHaptics } from "web-haptics/react";
import {
  Menu,
  ClipboardList,
  X,
  Volume2,
  VolumeOff,
  Smartphone,
  User,
  Clock,
} from "lucide-react";
import { BarcodeScanner } from "./BarcodeScanner";
import { ManualSheet } from "./ManualSheet";
import { ScanFlash, type FlashState } from "./ScanFlash";
import { ScanHistory } from "./ScanHistory";
import { LastScanBar } from "./LastScanBar";
import { unwrapEnvelope } from "@/lib/api-helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScannerMode = "quick-receive" | "quick-deduct" | "manual";

export interface ScannedProduct {
  productName: string;
  variantId: string;
  sku: string;
  barcode: string;
  stock: number;
  reserved: number;
  productImage: string | null;
  size: string | null;
  color: string | null;
  weight: number | null;
}

export interface ScanResult {
  id: string;
  timestamp: number;
  barcode: string;
  product: {
    name: string;
    variantId: string;
    sku: string;
    image?: string;
    size?: string;
    color?: string;
  } | null;
  action: "add" | "deduct" | "set" | "error";
  quantity: number;
  oldStock: number;
  newStock: number;
  reason: string;
}

interface ScannerAppProps {
  token: string;
}

// ---------------------------------------------------------------------------
// Audio feedback
// ---------------------------------------------------------------------------

function playBeep(type: "success" | "error" | "scan") {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.value = 0.15;

    if (type === "success") {
      osc.frequency.value = 880;
      osc.start();
      setTimeout(() => osc.stop(), 100);
      setTimeout(() => {
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        gain2.gain.value = 0.15;
        osc2.frequency.value = 1100;
        osc2.start();
        setTimeout(() => {
          osc2.stop();
          ctx.close();
        }, 100);
      }, 120);
    } else if (type === "error") {
      osc.frequency.value = 220;
      osc.start();
      setTimeout(() => {
        osc.stop();
        ctx.close();
      }, 300);
    } else {
      osc.frequency.value = 660;
      osc.start();
      setTimeout(() => {
        osc.stop();
        ctx.close();
      }, 80);
    }
  } catch {
    // Audio not available
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;
function nextId(): string {
  return `scan-${Date.now()}-${++idCounter}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ScannerApp({ token }: ScannerAppProps) {
  // ---- Auth ----
  const [authState, setAuthState] = useState<"verifying" | "error" | "ready">("verifying");
  const [authError, setAuthError] = useState("");
  const [adminName, setAdminName] = useState("Admin");
  const sessionStart = useRef(Date.now());

  useEffect(() => {
    const verificationUrl = token
      ? `/api/scanner-token?token=${encodeURIComponent(token)}`
      : "/api/scanner-token";

    fetch(verificationUrl)
      .then((res) => {
        if (!res.ok) throw new Error("Invalid or expired scanner session");
        return res.json();
      })
      .then((json) => {
        const data = unwrapEnvelope<Record<string, string>>(json);
        setAdminName(data.adminName || "Admin");
        setAuthState("ready");
        if (token) {
          const url = new URL(window.location.href);
          url.searchParams.delete("token");
          window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
        }
      })
      .catch((err: unknown) => {
        setAuthState("error");
        setAuthError(
          err instanceof Error
            ? err.message
            : "Scanner verification failed. Ask an admin to generate a new QR code.",
        );
      });
  }, [token]);

  // ---- Core state ----
  const [mode, setMode] = useState<ScannerMode>("quick-receive");
  const [history, setHistory] = useState<ScanResult[]>([]);
  const [lastResult, setLastResult] = useState<ScanResult | null>(null);
  const [flash, setFlash] = useState<FlashState | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // Manual mode state
  const [manualProduct, setManualProduct] = useState<ScannedProduct | null>(null);
  const [manualBarcode, setManualBarcode] = useState("");
  const [cameraPaused, setCameraPaused] = useState(false);

  // Settings
  const [defaultQuantity, setDefaultQuantity] = useState(1);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [hapticsEnabled, setHapticsEnabled] = useState(true);

  // ---- Haptics ----
  const { trigger: hapticTrigger } = useWebHaptics();
  const hapticRef = useRef(hapticTrigger);
  hapticRef.current = hapticTrigger;

  const haptic = useCallback(
    (type: "success" | "error" | "light" | "warning" | "selection" | "medium") => {
      if (!hapticsEnabled) return;
      hapticRef.current(type);
    },
    [hapticsEnabled],
  );

  const beep = useCallback(
    (type: "success" | "error" | "scan") => {
      if (!soundEnabled) return;
      playBeep(type);
    },
    [soundEnabled],
  );

  // ---- Flash management ----
  const showFlash = useCallback((state: FlashState) => {
    setFlash(state);
    setTimeout(() => setFlash(null), 500);
  }, []);

  // ---- Barcode lookup ----
  const lookupBarcode = useCallback(
    async (code: string): Promise<ScannedProduct | null> => {
      const url = `/api/v1/admin/inventory/scanner/lookup?code=${encodeURIComponent(code)}`;
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 404) return null;
        const body = await res.json().catch(() => null);
        throw new Error(
          body?.error?.message ?? body?.error ?? `Lookup failed: ${res.status}`,
        );
      }
      const json = await res.json();
      const raw = unwrapEnvelope(json);
      const v = raw.variant;
      const p = raw.product;
      if (!v || !p) return null;
      return {
        productName: p.name,
        variantId: v.id,
        sku: v.sku ?? "",
        barcode: v.barcode ?? "",
        stock: v.stock ?? 0,
        reserved: v.reservedStock ?? 0,
        productImage: p.imageUrl ?? null,
        size: v.size ?? null,
        color: v.color ?? null,
        weight: null,
      } satisfies ScannedProduct;
    },
    [],
  );

  // ---- Quick mode stock adjust (fire-and-forget with optimistic feedback) ----
  const quickAdjust = useCallback(
    async (product: ScannedProduct, quantity: number) => {
      const oldStock = product.stock;
      const newStock = oldStock + quantity;
      const isAdd = quantity > 0;

      // Optimistic feedback — instant
      const result: ScanResult = {
        id: nextId(),
        timestamp: Date.now(),
        barcode: product.barcode,
        product: {
          name: product.productName,
          variantId: product.variantId,
          sku: product.sku,
          image: product.productImage ?? undefined,
          size: product.size ?? undefined,
          color: product.color ?? undefined,
        },
        action: isAdd ? "add" : "deduct",
        quantity: Math.abs(quantity),
        oldStock,
        newStock,
        reason: isAdd ? "Quick Receive" : "Quick Deduct",
      };

      setLastResult(result);
      setHistory((prev) => [result, ...prev].slice(0, 50));

      showFlash({
        type: "success",
        action: `${quantity > 0 ? "+" : ""}${quantity} ${isAdd ? "Added" : "Deducted"}`,
        productName: product.productName,
        oldStock,
        newStock,
      });
      beep("success");
      haptic("success");

      // Fire API call — correct on failure
      try {
        const res = await fetch("/api/v1/admin/inventory/stock-adjust", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            variantId: product.variantId,
            adjustment: quantity,
            reason: isAdd ? "Quick Receive" : "Quick Deduct",
          }),
        });
        if (!res.ok) {
          // Mark result as failed in history
          setHistory((prev) =>
            prev.map((r) =>
              r.id === result.id
                ? { ...r, action: "error" as const, reason: "API call failed" }
                : r,
            ),
          );
        }
      } catch {
        setHistory((prev) =>
          prev.map((r) =>
            r.id === result.id
              ? { ...r, action: "error" as const, reason: "Network error" }
              : r,
          ),
        );
      }
    },
    [showFlash, beep, haptic],
  );

  // ---- Handle scan from camera or keyboard wedge ----
  const handleScan = useCallback(
    async (code: string, _format: string) => {
      beep("scan");

      try {
        const product = await lookupBarcode(code);

        if (!product) {
          // Not found
          showFlash({ type: "error", barcode: code });
          beep("error");
          haptic("error");

          const errorResult: ScanResult = {
            id: nextId(),
            timestamp: Date.now(),
            barcode: code,
            product: null,
            action: "error",
            quantity: 0,
            oldStock: 0,
            newStock: 0,
            reason: "Barcode not found",
          };
          setLastResult(errorResult);
          setHistory((prev) => [errorResult, ...prev].slice(0, 50));
          return;
        }

        if (mode === "quick-receive") {
          await quickAdjust(product, defaultQuantity);
        } else if (mode === "quick-deduct") {
          await quickAdjust(product, -defaultQuantity);
        } else {
          // Manual mode — pause camera, show product sheet
          setCameraPaused(true);
          setManualProduct(product);
          setManualBarcode(code);
          haptic("selection");
          beep("success");
        }
      } catch (err) {
        showFlash({
          type: "error",
          barcode: code,
        });
        beep("error");
        haptic("error");

        const errorResult: ScanResult = {
          id: nextId(),
          timestamp: Date.now(),
          barcode: code,
          product: null,
          action: "error",
          quantity: 0,
          oldStock: 0,
          newStock: 0,
          reason: err instanceof Error ? err.message : "Lookup failed",
        };
        setLastResult(errorResult);
        setHistory((prev) => [errorResult, ...prev].slice(0, 50));
      }
    },
    [mode, lookupBarcode, quickAdjust, defaultQuantity, showFlash, beep, haptic],
  );

  // ---- Manual mode submit ----
  const handleManualSubmit = useCallback(
    async (opts: {
      variantId: string;
      adjustment: number;
      reason: string;
      isAbsolute: boolean;
      product: ScannedProduct;
    }) => {
      const { variantId, adjustment, reason, isAbsolute, product } = opts;

      try {
        const url = isAbsolute
          ? "/api/v1/admin/inventory/stock-set"
          : "/api/v1/admin/inventory/stock-adjust";

        const body = isAbsolute
          ? { variantId, newStock: adjustment, reason }
          : { variantId, adjustment, reason };

        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errBody = await res.json().catch(() => null);
          throw new Error(
            errBody?.error?.message ?? errBody?.error ?? `API error: ${res.status}`,
          );
        }

        const json = await res.json();
        const data = unwrapEnvelope(json);
        const newStock = data.stock ?? (isAbsolute ? adjustment : product.stock + adjustment);
        const oldStock = product.stock;

        const result: ScanResult = {
          id: nextId(),
          timestamp: Date.now(),
          barcode: manualBarcode,
          product: {
            name: product.productName,
            variantId: product.variantId,
            sku: product.sku,
            image: product.productImage ?? undefined,
            size: product.size ?? undefined,
            color: product.color ?? undefined,
          },
          action: isAbsolute ? "set" : adjustment > 0 ? "add" : "deduct",
          quantity: Math.abs(isAbsolute ? newStock - oldStock : adjustment),
          oldStock,
          newStock,
          reason,
        };

        setLastResult(result);
        setHistory((prev) => [result, ...prev].slice(0, 50));

        showFlash({
          type: "success",
          action: isAbsolute
            ? `Set to ${newStock}`
            : `${adjustment > 0 ? "+" : ""}${adjustment} ${adjustment > 0 ? "Added" : "Deducted"}`,
          productName: product.productName,
          oldStock,
          newStock,
        });
        beep("success");
        haptic("success");

        // Resume camera
        setManualProduct(null);
        setCameraPaused(false);
      } catch (err) {
        beep("error");
        haptic("error");
        throw err; // Let ManualSheet display the error
      }
    },
    [manualBarcode, showFlash, beep, haptic],
  );

  // ---- Manual mode cancel ----
  const handleManualCancel = useCallback(() => {
    setManualProduct(null);
    setCameraPaused(false);
    haptic("light");
  }, [haptic]);

  // ---- Undo ----
  const handleUndo = useCallback(
    async (item: ScanResult) => {
      if (!item.product) return;

      try {
        const res = await fetch("/api/v1/admin/inventory/stock-set", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            variantId: item.product.variantId,
            newStock: item.oldStock,
            reason: "Undo scanner adjustment",
          }),
        });
        if (!res.ok) throw new Error("Undo failed");

        haptic("medium");
        beep("success");

        // Remove undone entry
        setHistory((prev) => prev.filter((h) => h.id !== item.id));

        // Update lastResult if same variant
        if (lastResult?.product?.variantId === item.product.variantId) {
          setLastResult(null);
        }
      } catch {
        beep("error");
        haptic("error");
      }
    },
    [lastResult, haptic, beep],
  );

  // ---- Camera active ----
  const isCameraActive = !cameraPaused;

  // ---- Mode switch ----
  const handleModeSwitch = useCallback(
    (newMode: ScannerMode) => {
      setMode(newMode);
      setManualProduct(null);
      setCameraPaused(false);
      haptic("selection");
      setMenuOpen(false);
    },
    [haptic],
  );

  // ---- Auth gates ----
  if (authState === "verifying") {
    return (
      <div className="flex h-dvh items-center justify-center bg-zinc-950 text-white">
        <div className="text-center">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-zinc-600 border-t-white" />
          <p className="text-sm text-zinc-400">Verifying scanner session...</p>
        </div>
      </div>
    );
  }

  if (authState === "error") {
    return (
      <div className="flex h-dvh items-center justify-center bg-zinc-950 text-white p-6">
        <div className="text-center max-w-sm">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-500/10">
            <X className="h-8 w-8 text-red-400" />
          </div>
          <h1 className="text-lg font-semibold mb-2">Access Required</h1>
          <p className="text-sm text-zinc-400 mb-6">{authError}</p>
          <p className="text-xs text-zinc-500">
            Ask an admin to generate a new scanner QR code from Settings.
          </p>
        </div>
      </div>
    );
  }

  // ---- History view ----
  if (historyOpen) {
    return (
      <ScanHistory
        items={history}
        onUndo={handleUndo}
        onClear={() => setHistory([])}
        onClose={() => setHistoryOpen(false)}
      />
    );
  }

  const MODE_PILLS: { key: ScannerMode; label: string }[] = [
    { key: "quick-receive", label: "Quick Receive" },
    { key: "quick-deduct", label: "Quick Deduct" },
    { key: "manual", label: "Manual" },
  ];

  return (
    <div className="flex h-dvh flex-col bg-zinc-950 text-white select-none">
      {/* ---- Flash overlay ---- */}
      {flash && <ScanFlash flash={flash} />}

      {/* ---- Header ---- */}
      <div className="flex shrink-0 items-center justify-between bg-zinc-900 px-3 py-2 border-b border-zinc-800">
        <button
          type="button"
          onClick={() => setMenuOpen(!menuOpen)}
          className="flex h-10 w-10 items-center justify-center rounded-lg active:bg-zinc-800"
          aria-label="Menu"
        >
          <Menu className="h-5 w-5 text-zinc-300" />
        </button>

        <span className="text-sm font-bold tracking-wide text-zinc-200">
          SCALIUS SCANNER
        </span>

        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          className="relative flex h-10 w-10 items-center justify-center rounded-lg active:bg-zinc-800"
          aria-label="History"
        >
          <ClipboardList className="h-5 w-5 text-zinc-300" />
          {history.length > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-600 text-[10px] font-bold text-white">
              {history.length > 9 ? "9+" : history.length}
            </span>
          )}
        </button>
      </div>

      {/* ---- Mode selector ---- */}
      <div className="flex shrink-0 gap-1.5 bg-zinc-900/80 px-3 py-2">
        {MODE_PILLS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => handleModeSwitch(key)}
            className={`flex h-9 flex-1 items-center justify-center rounded-lg text-xs font-semibold transition-colors ${
              mode === key
                ? key === "quick-deduct"
                  ? "bg-orange-600 text-white"
                  : key === "manual"
                    ? "bg-blue-600 text-white"
                    : "bg-emerald-600 text-white"
                : "bg-zinc-800 text-zinc-400 active:bg-zinc-700"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ---- Camera viewfinder ---- */}
      <div className="relative flex-1 min-h-0">
        <BarcodeScanner
          onScan={handleScan}
          isActive={isCameraActive}
          showTorchButton
        />

        {/* Dim overlay when camera paused in manual mode */}
        {cameraPaused && (
          <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
            <p className="text-sm text-zinc-400">Camera paused</p>
          </div>
        )}
      </div>

      {/* ---- Last scan bar ---- */}
      <LastScanBar result={lastResult} mode={mode} />

      {/* ---- Manual mode bottom sheet ---- */}
      {manualProduct && (
        <ManualSheet
          product={manualProduct}
          onSubmit={handleManualSubmit}
          onCancel={handleManualCancel}
          onHaptic={haptic}
        />
      )}

      {/* ---- Hamburger menu ---- */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-40 flex"
          onClick={() => setMenuOpen(false)}
        >
          <div
            className="w-72 bg-zinc-900 border-r border-zinc-800 h-full flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-zinc-800">
              <span className="text-sm font-bold text-zinc-200">Settings</span>
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-lg active:bg-zinc-800"
              >
                <X className="h-4 w-4 text-zinc-400" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-6">
              {/* Current mode */}
              <div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">
                  Current Mode
                </div>
                <div className={`inline-block rounded-full px-3 py-1 text-xs font-semibold ${
                  mode === "quick-receive"
                    ? "bg-emerald-600/20 text-emerald-400"
                    : mode === "quick-deduct"
                      ? "bg-orange-600/20 text-orange-400"
                      : "bg-blue-600/20 text-blue-400"
                }`}>
                  {mode === "quick-receive" ? "Quick Receive" : mode === "quick-deduct" ? "Quick Deduct" : "Manual"}
                </div>
              </div>

              {/* Default quantity */}
              <div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">
                  Default Quantity (Quick modes)
                </div>
                <div className="flex gap-2">
                  {[1, 5, 10].map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => setDefaultQuantity(q)}
                      className={`flex h-10 w-14 items-center justify-center rounded-lg text-sm font-bold ${
                        defaultQuantity === q
                          ? "bg-emerald-600 text-white"
                          : "bg-zinc-800 text-zinc-400 active:bg-zinc-700"
                      }`}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>

              {/* Sound toggle */}
              <button
                type="button"
                onClick={() => setSoundEnabled(!soundEnabled)}
                className="flex w-full items-center justify-between rounded-lg bg-zinc-800 px-4 py-3 active:bg-zinc-700"
              >
                <div className="flex items-center gap-3">
                  {soundEnabled ? (
                    <Volume2 className="h-4 w-4 text-zinc-400" />
                  ) : (
                    <VolumeOff className="h-4 w-4 text-zinc-500" />
                  )}
                  <span className="text-sm text-zinc-300">Sound</span>
                </div>
                <div
                  className={`h-6 w-10 rounded-full p-0.5 transition-colors ${
                    soundEnabled ? "bg-emerald-600" : "bg-zinc-700"
                  }`}
                >
                  <div
                    className={`h-5 w-5 rounded-full bg-white transition-transform ${
                      soundEnabled ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </div>
              </button>

              {/* Haptics toggle */}
              <button
                type="button"
                onClick={() => setHapticsEnabled(!hapticsEnabled)}
                className="flex w-full items-center justify-between rounded-lg bg-zinc-800 px-4 py-3 active:bg-zinc-700"
              >
                <div className="flex items-center gap-3">
                  <Smartphone className="h-4 w-4 text-zinc-400" />
                  <span className="text-sm text-zinc-300">Haptics</span>
                </div>
                <div
                  className={`h-6 w-10 rounded-full p-0.5 transition-colors ${
                    hapticsEnabled ? "bg-emerald-600" : "bg-zinc-700"
                  }`}
                >
                  <div
                    className={`h-5 w-5 rounded-full bg-white transition-transform ${
                      hapticsEnabled ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </div>
              </button>
            </div>

            {/* Footer */}
            <div className="border-t border-zinc-800 p-4 space-y-2">
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <User className="h-3.5 w-3.5" />
                <span>{adminName}</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-zinc-600">
                <Clock className="h-3.5 w-3.5" />
                <span>
                  Session started{" "}
                  {new Date(sessionStart.current).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            </div>
          </div>

          {/* Click-away backdrop */}
          <div className="flex-1" />
        </div>
      )}
    </div>
  );
}
