// src/components/admin/inventory/BarcodeScannerPage.tsx
// Full barcode scanner page for inventory management.
// Supports USB/Bluetooth scanners (keyboard input), manual entry, and camera scanning.

import { useState, useEffect, useRef, useCallback } from "react";
import {
  ScanBarcode,
  Package,
  Plus,
  Minus,
  Check,
  X,
  Camera,
  CameraOff,
  PackagePlus,
  ClipboardList,
  AlertTriangle,
  Loader2,
  ArrowRight,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@scalius/shared/utils";

// ─── Types ───

interface VariantResult {
  id: string;
  sku: string;
  size: string | null;
  color: string | null;
  price: number;
  stock: number;
  reservedStock: number;
  available: number;
  barcode: string | null;
  barcodeType: string | null;
  lowStockThreshold: number | null;
}

interface ProductResult {
  id: string;
  name: string;
  slug: string;
  price: number;
  isActive: boolean;
  imageUrl: string | null;
}

interface LookupResult {
  variant: VariantResult;
  product: ProductResult;
}

interface ScanLogEntry {
  id: string;
  timestamp: Date;
  barcode: string;
  productName: string;
  sku: string;
  action: string;
  delta: number;
  previousStock: number;
  newStock: number;
  success: boolean;
  error?: string;
}

interface BulkReceiveEntry {
  variantId: string;
  productName: string;
  sku: string;
  size: string | null;
  color: string | null;
  count: number;
  originalStock: number;
}

// ─── Audio Feedback ───

const audioCtxRef = { current: null as AudioContext | null };

function getAudioContext(): AudioContext {
  if (!audioCtxRef.current) {
    audioCtxRef.current = new AudioContext();
  }
  return audioCtxRef.current;
}

function playSuccessBeep() {
  try {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 1200;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.15);
  } catch {
    // Audio not available
  }
}

function playErrorBuzz() {
  try {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 200;
    osc.type = "square";
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch {
    // Audio not available
  }
}

// ─── Stock Badge Helper ───

function getStockBadge(available: number, threshold: number | null) {
  if (available <= 0)
    return {
      label: "Out of Stock",
      className:
        "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-400 border-red-200 dark:border-red-900",
    };
  if (threshold && available <= threshold)
    return {
      label: "Low Stock",
      className:
        "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400 border-amber-200 dark:border-amber-900",
    };
  return {
    label: "In Stock",
    className:
      "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900",
  };
}

// ─── Main Component ───

export function BarcodeScannerPage() {
  // Scanner input
  const [scanInput, setScanInput] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Lookup result
  const [lookupResult, setLookupResult] = useState<LookupResult | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  // Adjustment mode
  const [adjustMode, setAdjustMode] = useState<"adjust" | "set">("adjust");
  const [adjustValue, setAdjustValue] = useState<number>(0);
  const [setStockValue, setSetStockValue] = useState<string>("");
  const [adjustReason, setAdjustReason] = useState("");
  const [isAdjusting, setIsAdjusting] = useState(false);
  const [adjustFeedback, setAdjustFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // Bulk receiving mode
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkEntries, setBulkEntries] = useState<Map<string, BulkReceiveEntry>>(
    new Map(),
  );
  const [isBulkCommitting, setIsBulkCommitting] = useState(false);
  const [bulkComplete, setBulkComplete] = useState(false);

  // Camera scanning
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraSupported, setCameraSupported] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Scan log
  const [scanLog, setScanLog] = useState<ScanLogEntry[]>([]);

  // Check BarcodeDetector support on mount
  useEffect(() => {
    setCameraSupported(
      typeof window !== "undefined" && "BarcodeDetector" in window,
    );
  }, []);

  // Auto-focus the input
  useEffect(() => {
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 100);
    return () => clearTimeout(timer);
  }, [lookupResult, adjustFeedback]);

  // Keep focus on the input (re-focus if clicked elsewhere)
  useEffect(() => {
    const refocusHandler = () => {
      // Don't steal focus from other interactive elements (buttons, selects, textareas)
      const active = document.activeElement;
      const tag = active?.tagName?.toLowerCase();
      if (
        tag === "button" ||
        tag === "select" ||
        tag === "textarea" ||
        (tag === "input" && active !== inputRef.current)
      ) {
        return;
      }
      setTimeout(() => inputRef.current?.focus(), 50);
    };
    document.addEventListener("click", refocusHandler);
    return () => document.removeEventListener("click", refocusHandler);
  }, []);

  // ─── Camera Scanner ───

  const startCamera = useCallback(async () => {
    if (!cameraSupported) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      // Start barcode detection loop
      const detector = new (window as any).BarcodeDetector({
        formats: [
          "ean_13",
          "ean_8",
          "upc_a",
          "upc_e",
          "code_128",
          "code_39",
          "qr_code",
        ],
      });

      detectorIntervalRef.current = setInterval(async () => {
        if (!videoRef.current || videoRef.current.readyState !== 4) return;
        try {
          const barcodes = await detector.detect(videoRef.current);
          if (barcodes.length > 0) {
            const code = barcodes[0].rawValue;
            if (code) {
              handleScan(code);
            }
          }
        } catch {
          // Detection frame error, ignore
        }
      }, 500);

      setCameraActive(true);
    } catch (err) {
      console.error("Camera access error:", err);
      setCameraActive(false);
    }
  }, [cameraSupported]);

  const stopCamera = useCallback(() => {
    if (detectorIntervalRef.current) {
      clearInterval(detectorIntervalRef.current);
      detectorIntervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
  }, []);

  useEffect(() => {
    return () => stopCamera();
  }, [stopCamera]);

  // ─── Barcode Lookup ───

  const handleScan = useCallback(
    async (code: string) => {
      const trimmed = code.trim();
      if (!trimmed) return;

      setIsScanning(true);
      setLookupError(null);
      setAdjustFeedback(null);
      setAdjustValue(0);
      setSetStockValue("");
      setAdjustReason("");

      try {
        const res = await fetch(
          `/api/v1/admin/inventory/scanner/lookup?code=${encodeURIComponent(trimmed)}`,
        );

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          const msg =
            errData?.error?.message ||
            errData?.message ||
            "No product found for this barcode/SKU";
          setLookupResult(null);
          setLookupError(msg);
          playErrorBuzz();

          // In bulk mode, still log the miss
          if (bulkMode) {
            addScanLog(trimmed, "Unknown", trimmed, "Not found", 0, 0, 0, false, msg);
          }
          return;
        }

        const data = await res.json();
        // Admin proxy unwraps { success, data } to { success, ...data }
        const result: LookupResult = {
          variant: data.variant,
          product: data.product,
        };
        setLookupResult(result);
        setSetStockValue(String(result.variant.stock));
        playSuccessBeep();

        // In bulk mode, auto-add +1
        if (bulkMode) {
          await handleBulkAdd(result, trimmed);
        }
      } catch (err) {
        setLookupResult(null);
        setLookupError("Network error. Please try again.");
        playErrorBuzz();
      } finally {
        setIsScanning(false);
        setScanInput("");
        inputRef.current?.focus();
      }
    },
    [bulkMode],
  );

  // ─── Bulk Add ───

  const handleBulkAdd = async (result: LookupResult, barcode: string) => {
    const { variant, product } = result;

    setBulkEntries((prev) => {
      const next = new Map(prev);
      const existing = next.get(variant.id);
      if (existing) {
        next.set(variant.id, {
          ...existing,
          count: existing.count + 1,
        });
      } else {
        next.set(variant.id, {
          variantId: variant.id,
          productName: product.name,
          sku: variant.sku,
          size: variant.size,
          color: variant.color,
          count: 1,
          originalStock: variant.stock,
        });
      }
      return next;
    });

    addScanLog(
      barcode,
      product.name,
      variant.sku,
      "Bulk +1",
      1,
      variant.stock,
      variant.stock + 1,
      true,
    );
  };

  // ─── Commit Bulk ───

  const commitBulkReceive = async () => {
    setIsBulkCommitting(true);
    const entries = Array.from(bulkEntries.values());
    let successCount = 0;
    let failCount = 0;

    for (const entry of entries) {
      try {
        const res = await fetch("/api/v1/admin/inventory/stock-adjust", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            variantId: entry.variantId,
            adjustment: entry.count,
            reason: `Bulk receive: +${entry.count} units`,
          }),
        });
        if (res.ok) {
          successCount++;
        } else {
          failCount++;
        }
      } catch {
        failCount++;
      }
    }

    setIsBulkCommitting(false);
    setBulkComplete(true);

    addScanLog(
      "BULK_COMMIT",
      "Bulk Receive Complete",
      "-",
      `${successCount} succeeded, ${failCount} failed`,
      entries.reduce((sum, e) => sum + e.count, 0),
      0,
      0,
      failCount === 0,
      failCount > 0 ? `${failCount} items failed` : undefined,
    );
  };

  const resetBulkMode = () => {
    setBulkEntries(new Map());
    setBulkComplete(false);
    setLookupResult(null);
    setLookupError(null);
    inputRef.current?.focus();
  };

  // ─── Stock Adjust ───

  const handleStockAdjust = async (delta: number) => {
    if (!lookupResult || delta === 0) return;
    setIsAdjusting(true);
    setAdjustFeedback(null);

    try {
      const res = await fetch("/api/v1/admin/inventory/stock-adjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          variantId: lookupResult.variant.id,
          adjustment: delta,
          reason: adjustReason || (delta > 0 ? "Stock received" : "Stock removed"),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error?.message || data?.message || "Failed to adjust stock");
      }

      const newStock = data.newStock ?? lookupResult.variant.stock + delta;
      const prevStock = data.previousStock ?? lookupResult.variant.stock;

      // Update local state
      setLookupResult((prev) =>
        prev
          ? {
              ...prev,
              variant: {
                ...prev.variant,
                stock: newStock,
                available: newStock - prev.variant.reservedStock,
              },
            }
          : null,
      );

      setAdjustFeedback({
        type: "success",
        message: `Stock ${delta > 0 ? "increased" : "decreased"} by ${Math.abs(delta)}. New stock: ${newStock}`,
      });
      playSuccessBeep();

      addScanLog(
        lookupResult.variant.barcode || lookupResult.variant.sku,
        lookupResult.product.name,
        lookupResult.variant.sku,
        delta > 0 ? `+${delta}` : String(delta),
        delta,
        prevStock,
        newStock,
        true,
      );

      setAdjustValue(0);
      setAdjustReason("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to adjust stock";
      setAdjustFeedback({ type: "error", message: msg });
      playErrorBuzz();
    } finally {
      setIsAdjusting(false);
    }
  };

  // ─── Stock Set ───

  const handleStockSet = async () => {
    if (!lookupResult) return;
    const newVal = parseInt(setStockValue, 10);
    if (isNaN(newVal) || newVal < 0) return;

    setIsAdjusting(true);
    setAdjustFeedback(null);

    try {
      const res = await fetch("/api/v1/admin/inventory/stock-set", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          variantId: lookupResult.variant.id,
          newStock: newVal,
          reason: adjustReason || "Stocktake",
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error?.message || data?.message || "Failed to set stock");
      }

      const newStock = data.newStock ?? newVal;
      const prevStock = data.previousStock ?? lookupResult.variant.stock;

      setLookupResult((prev) =>
        prev
          ? {
              ...prev,
              variant: {
                ...prev.variant,
                stock: newStock,
                available: newStock - prev.variant.reservedStock,
              },
            }
          : null,
      );

      setAdjustFeedback({
        type: "success",
        message: `Stock set to ${newStock} (was ${prevStock})`,
      });
      playSuccessBeep();

      addScanLog(
        lookupResult.variant.barcode || lookupResult.variant.sku,
        lookupResult.product.name,
        lookupResult.variant.sku,
        `Set to ${newStock}`,
        newStock - prevStock,
        prevStock,
        newStock,
        true,
      );

      setAdjustReason("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to set stock";
      setAdjustFeedback({ type: "error", message: msg });
      playErrorBuzz();
    } finally {
      setIsAdjusting(false);
    }
  };

  // ─── Scan Log ───

  const addScanLog = (
    barcode: string,
    productName: string,
    sku: string,
    action: string,
    delta: number,
    previousStock: number,
    newStock: number,
    success: boolean,
    error?: string,
  ) => {
    setScanLog((prev) => [
      {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        barcode,
        productName,
        sku,
        action,
        delta,
        previousStock,
        newStock,
        success,
        error,
      },
      ...prev.slice(0, 99), // Keep last 100 entries
    ]);
  };

  // ─── Input Handler ───

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleScan(scanInput);
    }
  };

  // ─── Bulk totals ───

  const bulkTotalItems = Array.from(bulkEntries.values()).reduce(
    (sum, e) => sum + e.count,
    0,
  );
  const bulkTotalVariants = bulkEntries.size;

  // ─── Render ───

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Inventory Scanner
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Scan barcodes with a USB/Bluetooth scanner or type manually
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Camera toggle */}
          {cameraSupported && (
            <Button
              variant={cameraActive ? "default" : "outline"}
              size="sm"
              onClick={() => {
                if (cameraActive) {
                  stopCamera();
                } else {
                  startCamera();
                }
              }}
            >
              {cameraActive ? (
                <CameraOff className="h-4 w-4 mr-2" />
              ) : (
                <Camera className="h-4 w-4 mr-2" />
              )}
              {cameraActive ? "Stop Camera" : "Use Camera"}
            </Button>
          )}

          {/* Bulk receive toggle */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-card">
            <PackagePlus className="h-4 w-4 text-muted-foreground" />
            <Label htmlFor="bulk-mode" className="text-sm font-medium cursor-pointer">
              Receiving Mode
            </Label>
            <Switch
              id="bulk-mode"
              checked={bulkMode}
              onCheckedChange={(checked) => {
                setBulkMode(checked);
                if (!checked) {
                  resetBulkMode();
                }
              }}
            />
          </div>
        </div>
      </div>

      {/* Camera view */}
      {cameraActive && (
        <Card>
          <CardContent className="p-4">
            <div className="relative max-w-md mx-auto rounded-lg overflow-hidden bg-black">
              <video
                ref={videoRef}
                className="w-full"
                playsInline
                muted
              />
              <div className="absolute inset-0 border-2 border-dashed border-white/40 m-8 rounded-md pointer-events-none" />
              <div className="absolute bottom-2 left-0 right-0 text-center">
                <span className="text-xs text-white/80 bg-black/50 px-2 py-1 rounded">
                  Point camera at barcode
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Camera not supported message */}
      {!cameraSupported && (
        <div className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Camera className="h-3.5 w-3.5" />
          Camera scanning not supported in this browser. Use a USB scanner or type the barcode manually.
        </div>
      )}

      {/* Scanner Input */}
      <Card
        className={cn(
          "border-2 transition-colors",
          bulkMode
            ? "border-blue-300 dark:border-blue-700"
            : "border-border",
        )}
      >
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <div className="flex-shrink-0">
              <div
                className={cn(
                  "h-10 w-10 rounded-lg flex items-center justify-center",
                  bulkMode
                    ? "bg-blue-100 dark:bg-blue-900/30"
                    : "bg-muted",
                )}
              >
                <ScanBarcode
                  className={cn(
                    "h-5 w-5",
                    bulkMode
                      ? "text-blue-600 dark:text-blue-400"
                      : "text-muted-foreground",
                  )}
                />
              </div>
            </div>
            <div className="flex-1 relative">
              <Input
                ref={inputRef}
                value={scanInput}
                onChange={(e) => setScanInput(e.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder={
                  bulkMode
                    ? "Scan items to receive (auto +1 per scan)..."
                    : "Scan barcode or type SKU..."
                }
                className="h-12 text-lg pr-20"
                autoFocus
                autoComplete="off"
                disabled={isScanning}
              />
              {isScanning && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              )}
              {!isScanning && scanInput && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="absolute right-1 top-1/2 -translate-y-1/2"
                  onClick={() => handleScan(scanInput)}
                >
                  <ArrowRight className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
          {bulkMode && (
            <div className="mt-2 flex items-center gap-4 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Package className="h-3.5 w-3.5" />
                Scanned {bulkTotalItems} items across {bulkTotalVariants}{" "}
                variants
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Lookup Error */}
      {lookupError && !bulkMode && (
        <Card className="border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20">
          <CardContent className="p-4 flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-red-500 flex-shrink-0" />
            <div>
              <p className="font-medium text-red-700 dark:text-red-400">
                {lookupError}
              </p>
              <p className="text-sm text-red-600/70 dark:text-red-400/70 mt-0.5">
                Check the barcode and try again, or type the SKU manually
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto text-red-500"
              onClick={() => {
                setLookupError(null);
                inputRef.current?.focus();
              }}
            >
              <X className="h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Bulk Receive Panel */}
      {bulkMode && bulkEntries.size > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  <PackagePlus className="h-5 w-5" />
                  Receiving Summary
                </CardTitle>
                <CardDescription>
                  {bulkTotalItems} items across {bulkTotalVariants} variants
                </CardDescription>
              </div>
              {!bulkComplete && (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={resetBulkMode}
                  >
                    <X className="h-4 w-4 mr-1" />
                    Clear
                  </Button>
                  <Button
                    size="sm"
                    onClick={commitBulkReceive}
                    disabled={isBulkCommitting}
                  >
                    {isBulkCommitting ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <Check className="h-4 w-4 mr-1" />
                    )}
                    Finish Receiving
                  </Button>
                </div>
              )}
              {bulkComplete && (
                <Button size="sm" onClick={resetBulkMode}>
                  Start New Session
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border rounded-lg border overflow-hidden">
              {Array.from(bulkEntries.values()).map((entry) => (
                <div
                  key={entry.variantId}
                  className="flex items-center justify-between px-4 py-2.5 bg-card"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {entry.productName}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      SKU: {entry.sku}
                      {entry.size && ` / ${entry.size}`}
                      {entry.color && ` / ${entry.color}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 ml-4">
                    <Badge variant="secondary" className="text-sm font-mono">
                      +{entry.count}
                    </Badge>
                    {bulkComplete && (
                      <span className="text-xs text-muted-foreground">
                        {entry.originalStock} &rarr;{" "}
                        {entry.originalStock + entry.count}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Product/Variant Result Card */}
      {lookupResult && !bulkMode && (
        <Card>
          <CardContent className="p-4">
            <div className="flex flex-col md:flex-row gap-6">
              {/* Product Info */}
              <div className="flex gap-4 flex-1 min-w-0">
                {/* Image */}
                <div className="flex-shrink-0">
                  {lookupResult.product.imageUrl ? (
                    <img
                      src={lookupResult.product.imageUrl}
                      alt={lookupResult.product.name}
                      className="h-20 w-20 rounded-lg object-cover border"
                    />
                  ) : (
                    <div className="h-20 w-20 rounded-lg bg-muted flex items-center justify-center border">
                      <Package className="h-8 w-8 text-muted-foreground" />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-lg truncate">
                    {lookupResult.product.name}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    SKU: {lookupResult.variant.sku}
                    {lookupResult.variant.barcode &&
                      ` | Barcode: ${lookupResult.variant.barcode}`}
                  </p>
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {lookupResult.variant.size && (
                      <Badge variant="outline" className="text-xs">
                        {lookupResult.variant.size}
                      </Badge>
                    )}
                    {lookupResult.variant.color && (
                      <Badge variant="outline" className="text-xs">
                        {lookupResult.variant.color}
                      </Badge>
                    )}
                    <Badge
                      variant="outline"
                      className={
                        getStockBadge(
                          lookupResult.variant.available,
                          lookupResult.variant.lowStockThreshold,
                        ).className
                      }
                    >
                      {
                        getStockBadge(
                          lookupResult.variant.available,
                          lookupResult.variant.lowStockThreshold,
                        ).label
                      }
                    </Badge>
                    {!lookupResult.product.isActive && (
                      <Badge variant="destructive" className="text-xs">
                        Inactive
                      </Badge>
                    )}
                  </div>
                </div>
              </div>

              {/* Stock Numbers */}
              <div className="flex-shrink-0 grid grid-cols-3 gap-4 text-center">
                <div className="px-3 py-2 rounded-lg bg-muted">
                  <p className="text-2xl font-bold tabular-nums">
                    {lookupResult.variant.stock}
                  </p>
                  <p className="text-xs text-muted-foreground">On Hand</p>
                </div>
                <div className="px-3 py-2 rounded-lg bg-muted">
                  <p className="text-2xl font-bold tabular-nums">
                    {lookupResult.variant.reservedStock}
                  </p>
                  <p className="text-xs text-muted-foreground">Reserved</p>
                </div>
                <div
                  className={cn(
                    "px-3 py-2 rounded-lg",
                    lookupResult.variant.available <= 0
                      ? "bg-red-50 dark:bg-red-950/30"
                      : "bg-emerald-50 dark:bg-emerald-950/30",
                  )}
                >
                  <p
                    className={cn(
                      "text-2xl font-bold tabular-nums",
                      lookupResult.variant.available <= 0
                        ? "text-red-600 dark:text-red-400"
                        : "text-emerald-600 dark:text-emerald-400",
                    )}
                  >
                    {lookupResult.variant.available}
                  </p>
                  <p className="text-xs text-muted-foreground">Available</p>
                </div>
              </div>
            </div>

            {/* Adjustment Feedback */}
            {adjustFeedback && (
              <div
                className={cn(
                  "mt-4 px-4 py-2.5 rounded-lg text-sm flex items-center gap-2",
                  adjustFeedback.type === "success"
                    ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400"
                    : "bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400",
                )}
              >
                {adjustFeedback.type === "success" ? (
                  <Check className="h-4 w-4 flex-shrink-0" />
                ) : (
                  <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                )}
                {adjustFeedback.message}
              </div>
            )}

            {/* Stock Adjustment Controls */}
            <div className="mt-4 border-t pt-4">
              <div className="flex items-center gap-2 mb-3">
                <Button
                  variant={adjustMode === "adjust" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setAdjustMode("adjust")}
                >
                  <ArrowRight className="h-3.5 w-3.5 mr-1" />
                  Quick Adjust
                </Button>
                <Button
                  variant={adjustMode === "set" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setAdjustMode("set")}
                >
                  <ClipboardList className="h-3.5 w-3.5 mr-1" />
                  Set Stock
                </Button>
              </div>

              {adjustMode === "adjust" && (
                <div className="flex flex-wrap items-end gap-3">
                  {/* Quick buttons */}
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-9 w-9 p-0"
                      disabled={isAdjusting}
                      onClick={() => handleStockAdjust(-1)}
                    >
                      <Minus className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-9 w-9 p-0"
                      disabled={isAdjusting}
                      onClick={() => handleStockAdjust(1)}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>

                  {/* Custom amount */}
                  <div className="flex-1 min-w-[200px]">
                    <Label className="text-xs text-muted-foreground mb-1 block">
                      Custom amount (negative to remove)
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        type="number"
                        value={adjustValue || ""}
                        onChange={(e) =>
                          setAdjustValue(parseInt(e.target.value, 10) || 0)
                        }
                        placeholder="e.g. 10 or -5"
                        className="h-9"
                      />
                      <Button
                        size="sm"
                        className="h-9"
                        disabled={adjustValue === 0 || isAdjusting}
                        onClick={() => handleStockAdjust(adjustValue)}
                      >
                        {isAdjusting ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          "Apply"
                        )}
                      </Button>
                    </div>
                  </div>

                  {/* Reason */}
                  <div className="min-w-[160px]">
                    <Label className="text-xs text-muted-foreground mb-1 block">
                      Reason (optional)
                    </Label>
                    <Input
                      value={adjustReason}
                      onChange={(e) => setAdjustReason(e.target.value)}
                      placeholder="e.g. Shipment received"
                      className="h-9"
                    />
                  </div>
                </div>
              )}

              {adjustMode === "set" && (
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-[160px]">
                    <Label className="text-xs text-muted-foreground mb-1 block">
                      New stock count
                    </Label>
                    <Input
                      type="number"
                      min={0}
                      value={setStockValue}
                      onChange={(e) => setSetStockValue(e.target.value)}
                      placeholder="Enter new count"
                      className="h-9"
                    />
                  </div>
                  <div className="flex-1 min-w-[160px]">
                    <Label className="text-xs text-muted-foreground mb-1 block">
                      Reason (optional)
                    </Label>
                    <Input
                      value={adjustReason}
                      onChange={(e) => setAdjustReason(e.target.value)}
                      placeholder="e.g. Physical count reconciliation"
                      className="h-9"
                    />
                  </div>
                  <Button
                    size="sm"
                    className="h-9"
                    disabled={
                      setStockValue === "" ||
                      parseInt(setStockValue, 10) < 0 ||
                      isNaN(parseInt(setStockValue, 10)) ||
                      isAdjusting
                    }
                    onClick={handleStockSet}
                  >
                    {isAdjusting ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <Check className="h-4 w-4 mr-1" />
                    )}
                    Set Stock
                  </Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Scan Log */}
      {scanLog.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <ClipboardList className="h-4 w-4" />
                Scan History
              </CardTitle>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs"
                onClick={() => setScanLog([])}
              >
                Clear
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="divide-y divide-border max-h-64 overflow-y-auto rounded-lg border">
              {scanLog.map((entry) => (
                <div
                  key={entry.id}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 text-sm",
                    entry.success
                      ? "bg-card"
                      : "bg-red-50/50 dark:bg-red-950/10",
                  )}
                >
                  <div
                    className={cn(
                      "h-2 w-2 rounded-full flex-shrink-0",
                      entry.success ? "bg-emerald-500" : "bg-red-500",
                    )}
                  />
                  <span className="text-xs text-muted-foreground tabular-nums w-14 flex-shrink-0">
                    {entry.timestamp.toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  <span className="font-medium truncate min-w-0 flex-1">
                    {entry.productName}
                  </span>
                  <span className="text-xs text-muted-foreground flex-shrink-0">
                    {entry.sku}
                  </span>
                  <Badge
                    variant={entry.success ? "secondary" : "destructive"}
                    className="text-xs flex-shrink-0"
                  >
                    {entry.action}
                  </Badge>
                  {entry.success && entry.barcode !== "BULK_COMMIT" && (
                    <span className="text-xs text-muted-foreground flex-shrink-0 tabular-nums">
                      {entry.previousStock} &rarr; {entry.newStock}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {!lookupResult && !lookupError && scanLog.length === 0 && !bulkMode && (
        <Card className="border-dashed">
          <CardContent className="py-16 flex flex-col items-center text-center">
            <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
              <ScanBarcode className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="font-semibold text-lg">Ready to scan</h3>
            <p className="text-sm text-muted-foreground max-w-md mt-1">
              Use a USB or Bluetooth barcode scanner to scan product barcodes, or
              type a barcode/SKU manually and press Enter. You can also toggle
              Receiving Mode for bulk shipment intake.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
