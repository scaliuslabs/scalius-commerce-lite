import { useState, useCallback, useRef, useEffect, useMemo } from "react";
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
import { ReceiveMode, useReceiveSession } from "./ReceiveMode";
import {
  getApiV1AdminInventoryLocations,
  getApiV1AdminInventoryScannerLookup,
  postApiV1AdminInventoryStockAdjust,
  postApiV1AdminInventoryStockSet,
} from "@scalius/api-client/sdk";
import { apiData } from "@/lib/api";
import { AdminApiResponseError, isAdminApiNotFoundError } from "@/lib/admin-api-error";
import { withDashboardBasePath } from "@/lib/dashboard-base-path";
import { Label } from "~/components/ui/label";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Switch } from "~/components/ui/switch";
import { cn } from "@scalius/shared/utils";
import { formatDateTime, formatNumber, translate, useMessages } from "~/i18n";
import { scannerMessages } from "~/i18n/scanner";
import {
  pickScannerLocation,
  readRememberedScannerLocation,
  rememberScannerLocation,
  type ScannerLocation,
} from "./scanner-location";

/** "receive" books a purchase order or transfer by scan; the others change stock per scan. */
export type ScannerMode = "quick-receive" | "quick-deduct" | "manual" | "receive";

const MODES: readonly ScannerMode[] = ["quick-receive", "quick-deduct", "manual", "receive"];
const MODE_LABEL = {
  "quick-receive": "modeReceive",
  "quick-deduct": "modeDeduct",
  manual: "modeManual",
  receive: "modeReceiveDocument",
} as const;

/** Copy used inside callbacks (reads the current dashboard language). */
const tr = (key: keyof typeof scannerMessages.en, vars?: Record<string, string | number>) =>
  translate(scannerMessages, key, vars);

/** Where a scan counts stock: a location of a store with several, else null (one location holds everything). */
export type ScanLocation = Pick<ScannerLocation, "id" | "name"> | null;

export interface ScannedProduct {
  productName: string;
  variantId: string;
  sku: string;
  barcode: string;
  stock: number;
  reserved: number;
  /** The location the scan counts at, and the SKU's on-hand there. */
  location: ScanLocation;
  locationStock: number | null;
  productImage: string | null;
  optionLabel: string | null;
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
    optionLabel?: string;
  } | null;
  action: "add" | "deduct" | "set" | "error";
  quantity: number;
  /** On hand before and after: at `location` when the store has several. */
  oldStock: number;
  newStock: number;
  reason: string;
  /** Where the change happened; an undo reverses it there. */
  location?: ScanLocation;
  undoError?: string;
  /**
   * A purchase order or transfer receipt (Receive mode): booked on its
   * document, so it is never undone here; `title` names the supplier or route.
   */
  receipt?: { title: string | null };
}

interface ScannerAppProps {
  token: string | null;
}

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

let idCounter = 0;
function nextId(): string {
  return `scan-${Date.now()}-${++idCounter}`;
}

function createInventoryOperationKey(): string {
  return `invop_${crypto.randomUUID()}`;
}

/** Inventory writes are idempotent by operation key, so retry once unless the API rejected them. */
async function withOneRetry<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AdminApiResponseError && error.status < 500) throw error;
    return operation();
  }
}

const adjustStock = (body: {
  operationKey: string;
  variantId: string;
  adjustment: number;
  reason: string;
}, location: ScanLocation) => withOneRetry(() => apiData(postApiV1AdminInventoryStockAdjust({
  // A store with one location names none: the API uses the default.
  body: { ...body, ...(location ? { locationId: location.id } : {}) },
})));

/** The on-hand a change result reports: the location's when one was named. */
function resultStock(data: { newStock?: unknown; locationNewStock?: unknown }, location: ScanLocation): number | null {
  const value = location ? data.locationNewStock : data.newStock;
  return typeof value === "number" ? value : null;
}

export function ScannerApp({ token }: ScannerAppProps) {
  const t = useMessages(scannerMessages);
  // ---- Auth ----
  const [authState, setAuthState] = useState<"verifying" | "error" | "ready">("verifying");
  const [authError, setAuthError] = useState("");
  const [adminName, setAdminName] = useState("");
  const sessionStart = useRef(Date.now());
  const undoOperationKeysRef = useRef(new Map<string, string>());
  const verificationRequestRef = useRef<{
    token: string;
    promise: Promise<Record<string, string>>;
  } | null>(null);

  useEffect(() => {
    if (token === null) return;

    const verificationRequest: RequestInit | undefined = token
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        }
      : undefined;

    if (verificationRequestRef.current?.token !== token) {
      verificationRequestRef.current = {
        token,
        promise: fetch(withDashboardBasePath("/api/scanner-token"), verificationRequest)
          .then((res) => {
            if (!res.ok) {
              throw new Error(tr("accessInvalid"));
            }
            // This Worker route answers `{ success, valid, adminName }` unwrapped.
            return res.json() as Promise<Record<string, string>>;
          }),
      };
    }

    let active = true;
    void verificationRequestRef.current.promise
      .then((data) => {
        if (!active) return;
        setAdminName(data.adminName ?? "");
        setAuthState("ready");
      })
      .catch((err: unknown) => {
        if (!active) return;
        setAuthState("error");
        setAuthError(
          err instanceof Error
            ? err.message
            : tr("accessInvalid"),
        );
      });

    return () => {
      active = false;
    };
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

  // Locations: a store with several picks where this device counts (remembered per device).
  const [locations, setLocations] = useState<ScannerLocation[] | null>(null);
  const [locationsFailed, setLocationsFailed] = useState(false);
  const [locationId, setLocationId] = useState<string | null>(null);
  const location = useMemo<ScanLocation>(() => {
    const chosen = (locations?.length ?? 0) > 1 ? locations?.find((candidate) => candidate.id === locationId) : null;
    return chosen ? { id: chosen.id, name: chosen.name } : null;
  }, [locationId, locations]);
  const loadLocations = useCallback(() => {
    setLocationsFailed(false);
    apiData(getApiV1AdminInventoryLocations({ query: { includeArchived: "false" } }))
      .then(({ locations: rows }) => {
        const active = rows
          .filter((row) => row.status === "active")
          .map(({ id, name, isDefault }) => ({ id, name, isDefault }));
        setLocations(active);
        setLocationId(pickScannerLocation(active, readRememberedScannerLocation())?.id ?? null);
      })
      .catch(() => setLocationsFailed(true));
  }, []);
  useEffect(() => {
    if (authState === "ready") loadLocations();
  }, [authState, loadLocations]);
  const chooseLocation = useCallback((id: string) => {
    if (!locations?.some((candidate) => candidate.id === id)) return;
    setLocationId(id);
    rememberScannerLocation(id);
  }, [locations]);

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

  // ---- Receive mode (purchase orders and transfers) ----
  const receiveFeedback = useMemo(() => ({ flash: showFlash, beep, haptic }), [showFlash, beep, haptic]);
  const recordReceipt = useCallback((receipt: { number: string; title: string | null; units: number }) => {
    const entry: ScanResult = {
      id: nextId(),
      timestamp: Date.now(),
      barcode: receipt.number,
      product: { name: tr("receivedEntry", { number: receipt.number }), variantId: "", sku: "" },
      action: "add",
      quantity: receipt.units,
      oldStock: 0,
      newStock: 0,
      reason: "receipt",
      receipt: { title: receipt.title },
    };
    setHistory((prev) => [entry, ...prev].slice(0, 50));
  }, []);
  const receive = useReceiveSession({ locationId: location?.id ?? null, feedback: receiveFeedback, onReceived: recordReceipt });

  // ---- Barcode lookup ----
  const lookupBarcode = useCallback(
    async (code: string, at: ScanLocation): Promise<ScannedProduct | null> => {
      const raw = await apiData(getApiV1AdminInventoryScannerLookup({
        query: { code, ...(at ? { locationId: at.id } : {}) },
      }))
        .catch((error: unknown) => {
          if (isAdminApiNotFoundError(error)) return null;
          throw error;
        });
      if (!raw) return null;
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
        location: at,
        locationStock: at ? v.locationOnHand ?? 0 : null,
        productImage: p.imageUrl ?? null,
        optionLabel: v.optionLabel ?? null,
        weight: null,
      } satisfies ScannedProduct;
    },
    [],
  );

  // ---- Quick mode stock adjust (fire-and-forget with optimistic feedback) ----
  const quickAdjust = useCallback(
    async (product: ScannedProduct, quantity: number) => {
      const oldStock = product.locationStock ?? product.stock;
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
          optionLabel: product.optionLabel ?? undefined,
        },
        action: isAdd ? "add" : "deduct",
        quantity: Math.abs(quantity),
        oldStock,
        newStock,
        reason: isAdd ? "Quick Receive" : "Quick Deduct",
        location: product.location,
      };

      setLastResult(result);
      setHistory((prev) => [result, ...prev].slice(0, 50));

      showFlash({
        type: "success",
        action: tr(isAdd ? "added" : "removed", { count: Math.abs(quantity) }),
        productName: product.productName,
        oldStock,
        newStock,
      });
      beep("success");
      haptic("success");

      // Fire API call — correct on failure
      try {
        await adjustStock({
          operationKey: createInventoryOperationKey(),
          variantId: product.variantId,
          adjustment: quantity,
          reason: isAdd ? "Quick Receive" : "Quick Deduct",
        }, product.location);
      } catch {
        setHistory((prev) =>
          prev.map((r) =>
            r.id === result.id
              ? { ...r, action: "error" as const, reason: tr("notSaved") }
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
        // The location chosen when the code was read is where this scan counts.
        const product = await lookupBarcode(code, location);

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
            reason: tr("barcodeNotFound"),
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
          reason: err instanceof Error ? err.message : tr("lookupFailed"),
        };
        setLastResult(errorResult);
        setHistory((prev) => [errorResult, ...prev].slice(0, 50));
      }
    },
    [mode, location, lookupBarcode, quickAdjust, defaultQuantity, showFlash, beep, haptic],
  );

  // ---- Manual mode submit ----
  const handleManualSubmit = useCallback(
    async (opts: {
      variantId: string;
      adjustment: number;
      reason: string;
      isAbsolute: boolean;
      operationKey: string;
      product: ScannedProduct;
    }) => {
      const { variantId, adjustment, reason, isAbsolute, operationKey, product } = opts;
      const at = product.location;

      try {
        const data: { newStock?: unknown; locationNewStock?: unknown } = isAbsolute
          ? await withOneRetry(() => apiData(postApiV1AdminInventoryStockSet({
              // A count is the units at the location being counted.
              body: { operationKey, variantId, newStock: adjustment, reason, ...(at ? { locationId: at.id } : {}) },
            })))
          : await adjustStock({ operationKey, variantId, adjustment, reason }, at);
        const oldStock = product.locationStock ?? product.stock;
        const newStock = resultStock(data, at) ?? (isAbsolute ? adjustment : oldStock + adjustment);

        const result: ScanResult = {
          id: nextId(),
          timestamp: Date.now(),
          barcode: manualBarcode,
          product: {
            name: product.productName,
            variantId: product.variantId,
            sku: product.sku,
            image: product.productImage ?? undefined,
            optionLabel: product.optionLabel ?? undefined,
          },
          action: isAbsolute ? "set" : adjustment > 0 ? "add" : "deduct",
          quantity: Math.abs(isAbsolute ? newStock - oldStock : adjustment),
          oldStock,
          newStock,
          reason,
          location: at,
        };

        setLastResult(result);
        setHistory((prev) => [result, ...prev].slice(0, 50));

        showFlash({
          type: "success",
          action: isAbsolute
            ? tr("setTo", { count: newStock })
            : tr(adjustment > 0 ? "added" : "removed", { count: Math.abs(adjustment) }),
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
      const operationKey =
        undoOperationKeysRef.current.get(item.id) ??
        createInventoryOperationKey();
      undoOperationKeysRef.current.set(item.id, operationKey);

      try {
        await adjustStock({
          operationKey,
          variantId: item.product.variantId,
          adjustment: item.oldStock - item.newStock,
          reason: "Undo scanner adjustment",
        }, item.location ?? null);
        undoOperationKeysRef.current.delete(item.id);

        haptic("medium");
        beep("success");

        // Remove undone entry
        setHistory((prev) => prev.filter((h) => h.id !== item.id));

        // Update lastResult if same variant
        if (lastResult?.product?.variantId === item.product.variantId) {
          setLastResult(null);
        }
      } catch {
        setHistory((current) =>
          current.map((historyItem) =>
            historyItem.id === item.id
              ? {
                  ...historyItem,
                  undoError: tr("undoFailed"),
                }
              : historyItem,
          ),
        );
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
      <div className="flex h-dvh items-center justify-center bg-background text-foreground">
        <div className="text-center">
          <div className="mx-auto mb-4 size-8 animate-spin rounded-full border-2 border-muted border-t-foreground" />
          <p className="text-body text-muted-foreground">{t("verifying")}</p>
        </div>
      </div>
    );
  }

  if (authState === "error") {
    return (
      <div className="flex h-dvh items-center justify-center bg-background p-6 text-foreground">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-destructive/10">
            <X className="size-8 text-destructive" />
          </div>
          <h1 className="mb-2 text-heading-md font-semibold">{t("accessTitle")}</h1>
          <p className="mb-6 text-body text-muted-foreground">{authError}</p>
          <p className="text-body text-muted-foreground">{t("accessHelp")}</p>
        </div>
      </div>
    );
  }

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

  return (
    <div className="flex h-dvh select-none flex-col bg-background text-foreground">
      {flash ? <ScanFlash flash={flash} /> : null}

      <div className="flex shrink-0 items-center justify-between border-b bg-card px-3 py-2">
        <button
          type="button"
          onClick={() => setMenuOpen(!menuOpen)}
          className="flex size-11 items-center justify-center rounded-lg active:bg-accent"
          aria-label={t("menu")}
        >
          <Menu className="size-5" />
        </button>
        <span className="text-body font-semibold">{t("appTitle")}</span>
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          className="relative flex size-11 items-center justify-center rounded-lg active:bg-accent"
          aria-label={t("history")}
        >
          <ClipboardList className="size-5" />
          {history.length > 0 ? (
            <span className="absolute -inset-e-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-body font-medium text-primary-foreground">
              {history.length > 9 ? "9+" : formatNumber(history.length)}
            </span>
          ) : null}
        </button>
      </div>

      <div className="flex shrink-0 gap-2 bg-card px-3 py-2">
        {MODES.map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={mode === key}
            onClick={() => handleModeSwitch(key)}
            className={cn(
              "flex h-11 flex-1 items-center justify-center rounded-lg text-body font-semibold",
              mode === key ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground active:bg-accent",
            )}
          >
            {t(MODE_LABEL[key])}
          </button>
        ))}
      </div>

      {/* A receipt books at its document's destination: the picker is only needed to choose one. */}
      {location && locations && !(mode === "receive" && receive.receiving) ? (
        <div className="shrink-0 bg-card px-3 pb-2">
          <SearchableSelect
            triggerClassName="w-full"
            ariaLabel={t("location")}
            value={location.id}
            onValueChange={chooseLocation}
            options={locations.map((candidate) => ({
              value: candidate.id,
              label: candidate.isDefault ? t("locationDefault", { name: candidate.name }) : candidate.name,
            }))}
          />
        </div>
      ) : locationsFailed ? (
        <div role="alert" className="flex shrink-0 items-center justify-between gap-2 bg-destructive/10 px-3 py-2 text-body text-destructive">
          <span>{t("locationsFailed")}</span>
          <button type="button" onClick={loadLocations} className="flex h-11 shrink-0 items-center rounded-lg px-3 font-medium active:bg-accent">
            {t("retry")}
          </button>
        </div>
      ) : null}

      {mode === "receive" ? (
        <ReceiveMode session={receive} showDestination={!location && (locations?.length ?? 0) > 1} />
      ) : (
        <>
          <div className="relative min-h-0 flex-1">
            <BarcodeScanner onScan={handleScan} isActive={isCameraActive} showTorchButton />
          </div>

          <LastScanBar result={lastResult} mode={mode} />
        </>
      )}

      {manualProduct ? (
        <ManualSheet
          product={manualProduct}
          onSubmit={handleManualSubmit}
          onCancel={handleManualCancel}
          onHaptic={haptic}
        />
      ) : null}

      {menuOpen ? (
        <div className="fixed inset-0 z-40 flex" onClick={() => setMenuOpen(false)}>
          <div
            className="flex h-full w-72 flex-col border-e bg-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b p-4">
              <span className="text-body font-semibold">{t("settings")}</span>
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                aria-label={t("close")}
                className="flex size-11 items-center justify-center rounded-lg active:bg-accent"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="flex-1 space-y-6 overflow-y-auto p-4">
              <div>
                <p className="mb-2 text-body text-muted-foreground">{t("mode")}</p>
                <p className="text-body font-semibold">{t(MODE_LABEL[mode])}</p>
              </div>

              <div>
                <p className="mb-2 text-body text-muted-foreground">{t("quantityPerScan")}</p>
                <div className="flex gap-2">
                  {[1, 5, 10].map((quantity) => (
                    <button
                      key={quantity}
                      type="button"
                      aria-pressed={defaultQuantity === quantity}
                      onClick={() => setDefaultQuantity(quantity)}
                      className={cn(
                        "flex h-11 w-14 items-center justify-center rounded-lg text-body font-semibold",
                        defaultQuantity === quantity
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground active:bg-accent",
                      )}
                    >
                      {formatNumber(quantity)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between rounded-lg bg-muted px-4 py-3">
                <Label htmlFor="scanner-sound" className="flex items-center">
                  {soundEnabled ? <Volume2 className="me-3 size-4" /> : <VolumeOff className="me-3 size-4" />}
                  {t("sound")}
                </Label>
                <Switch id="scanner-sound" checked={soundEnabled} onCheckedChange={setSoundEnabled} />
              </div>
              <div className="flex items-center justify-between rounded-lg bg-muted px-4 py-3">
                <Label htmlFor="scanner-vibration" className="flex items-center">
                  <Smartphone className="me-3 size-4" />
                  {t("vibration")}
                </Label>
                <Switch id="scanner-vibration" checked={hapticsEnabled} onCheckedChange={setHapticsEnabled} />
              </div>
            </div>

            <div className="space-y-2 border-t p-4 text-body text-muted-foreground">
              {adminName ? (
                <div className="flex items-center gap-2">
                  <User className="size-4" />
                  <span>{adminName}</span>
                </div>
              ) : null}
              <div className="flex items-center gap-2">
                <Clock className="size-4" />
                <span>
                  {t("startedAt", { time: formatDateTime(new Date(sessionStart.current), { timeStyle: "short" }) })}
                </span>
              </div>
            </div>
          </div>
          <div className="flex-1" />
        </div>
      ) : null}
    </div>
  );
}
