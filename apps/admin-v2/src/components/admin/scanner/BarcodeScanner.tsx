import { useState, useEffect, useRef, useCallback } from "react";
import { CameraOff, Flashlight, FlashlightOff, Keyboard, Search, Camera } from "lucide-react";
import type { Html5Qrcode as Html5QrcodeInstance } from "html5-qrcode";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BarcodeScannerProps {
  onScan: (code: string, format: string) => void;
  isActive: boolean;
  showTorchButton?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCAN_CONFIG = {
  fps: 15,
  qrbox: { width: 280, height: 90 },
  aspectRatio: 1.777778,
  disableFlip: true,
};

const DEBOUNCE_MS = 2000;
const READER_ID = "barcode-scanner-reader";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BarcodeScanner({
  onScan,
  isActive,
  showTorchButton = true,
}: BarcodeScannerProps) {
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [manualInput, setManualInput] = useState("");
  const [showManual, setShowManual] = useState(false);

  const scannerRef = useRef<Html5QrcodeInstance | null>(null);
  const lastScanRef = useRef<{ code: string; time: number }>({ code: "", time: 0 });
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  // ---- Debounced scan handler ----
  const handleDecodedText = useCallback(
    (
      decodedText: string,
      result: { result: { format?: { formatName: string } } },
    ) => {
      const now = Date.now();
      if (
        decodedText === lastScanRef.current.code &&
        now - lastScanRef.current.time < DEBOUNCE_MS
      ) {
        return;
      }
      lastScanRef.current = { code: decodedText, time: now };
      const formatName = result?.result?.format?.formatName ?? "unknown";
      onScanRef.current(decodedText, formatName);
    },
    [],
  );

  // ---- Camera lifecycle ----
  useEffect(() => {
    if (import.meta.env.SSR || !isActive) return;

    let cancelled = false;
    let scanner: Html5QrcodeInstance | null = null;

    async function startScanner() {
      try {
        const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import(
          "html5-qrcode"
        );
        if (cancelled) return;

        scanner = new Html5Qrcode(READER_ID, {
          formatsToSupport: [
            Html5QrcodeSupportedFormats.CODE_128,
            Html5QrcodeSupportedFormats.EAN_13,
            Html5QrcodeSupportedFormats.EAN_8,
            Html5QrcodeSupportedFormats.UPC_A,
            Html5QrcodeSupportedFormats.UPC_E,
            Html5QrcodeSupportedFormats.QR_CODE,
            Html5QrcodeSupportedFormats.CODE_39,
            Html5QrcodeSupportedFormats.ITF,
            Html5QrcodeSupportedFormats.CODABAR,
          ],
          verbose: false,
        });
        scannerRef.current = scanner;

        await scanner.start(
          { facingMode: "environment" },
          SCAN_CONFIG,
          (decodedText, result) => {
            if (!cancelled) handleDecodedText(decodedText, result);
          },
          () => {
            // No code in frame — silent
          },
        );

        if (cancelled) return;
        setCameraReady(true);
        setCameraError(null);

        try {
          const caps = scanner.getRunningTrackCameraCapabilities();
          const torch = caps.torchFeature();
          setTorchSupported(torch.isSupported());
        } catch {
          setTorchSupported(false);
        }
      } catch (err: unknown) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setCameraError(message);
        setCameraReady(false);
      }
    }

    void startScanner();

    return () => {
      cancelled = true;
      setCameraReady(false);
      setTorchOn(false);
      setTorchSupported(false);
      const currentScanner = scanner ?? scannerRef.current;
      if (currentScanner?.isScanning) {
        currentScanner.stop().catch(() => {});
      }
      scannerRef.current = null;
    };
  }, [isActive, handleDecodedText]);

  // ---- USB/Bluetooth keyboard-wedge scanner ----
  useEffect(() => {
    let buffer = "";
    let timeout: ReturnType<typeof setTimeout>;

    const handler = (e: KeyboardEvent) => {
      if (showManual && (e.target as HTMLElement)?.tagName === "INPUT") return;

      if (e.key === "Enter" && buffer.length > 3) {
        onScanRef.current(buffer, "keyboard");
        buffer = "";
        return;
      }
      if (e.key.length === 1) {
        buffer += e.key;
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          buffer = "";
        }, 100);
      }
    };

    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      clearTimeout(timeout);
    };
  }, [showManual]);

  // ---- Torch toggle ----
  const toggleTorch = useCallback(async () => {
    const scanner = scannerRef.current;
    if (!scanner) return;
    try {
      const caps = scanner.getRunningTrackCameraCapabilities();
      const torch = caps.torchFeature();
      const next = !torchOn;
      await torch.apply(next);
      setTorchOn(next);
    } catch {
      // Torch failed
    }
  }, [torchOn]);

  // ---- Manual barcode submit ----
  const handleManualSubmit = (e: { preventDefault(): void }) => {
    e.preventDefault();
    const code = manualInput.trim();
    if (code.length > 0) {
      onScan(code, "manual");
      setManualInput("");
    }
  };

  return (
    <div className="relative h-full flex flex-col bg-black">
      {/* Camera viewfinder — fills available space */}
      <div className="relative flex-1 min-h-0">
        <div
          id={READER_ID}
          className="h-full w-full [&_video]:h-full [&_video]:w-full [&_video]:object-cover"
        />

        {/* Crosshair / scan frame overlay */}
        {cameraReady && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {/* Outer dim mask */}
            <div className="relative" style={{ width: 280, height: 90 }}>
              {/* Scan region border */}
              <div className="absolute inset-0 border-2 border-white/20 rounded-lg" />

              {/* Corner brackets */}
              <div className="absolute -top-0.5 -left-0.5 h-5 w-5 border-t-[3px] border-l-[3px] border-emerald-400 rounded-tl-md" />
              <div className="absolute -top-0.5 -right-0.5 h-5 w-5 border-t-[3px] border-r-[3px] border-emerald-400 rounded-tr-md" />
              <div className="absolute -bottom-0.5 -left-0.5 h-5 w-5 border-b-[3px] border-l-[3px] border-emerald-400 rounded-bl-md" />
              <div className="absolute -bottom-0.5 -right-0.5 h-5 w-5 border-b-[3px] border-r-[3px] border-emerald-400 rounded-br-md" />

              {/* Animated scan line */}
              <div
                className="absolute left-2 right-2 h-0.5 bg-emerald-400/60"
                style={{
                  animation: "scanline 2s ease-in-out infinite",
                  top: "50%",
                }}
              />
            </div>
          </div>
        )}

        {/* Camera error */}
        {cameraError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900 p-6 text-center">
            <CameraOff className="mb-3 h-12 w-12 text-zinc-500" />
            <p className="text-sm text-zinc-400">{cameraError}</p>
            <p className="mt-2 text-xs text-zinc-600">
              Use manual input or a USB scanner
            </p>
          </div>
        )}

        {/* Not active placeholder */}
        {!isActive && !cameraError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900">
            <Camera className="mb-2 h-8 w-8 text-zinc-600" />
            <p className="text-sm text-zinc-500">Camera paused</p>
          </div>
        )}

        {/* Action buttons overlaid on camera */}
        {cameraReady && isActive && (
          <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between">
            {/* Torch */}
            {showTorchButton && torchSupported ? (
              <button
                type="button"
                onClick={toggleTorch}
                className="flex h-12 items-center gap-2 rounded-full bg-black/60 px-4 text-sm text-white backdrop-blur-sm active:bg-black/80"
                aria-label={torchOn ? "Turn off flashlight" : "Turn on flashlight"}
              >
                {torchOn ? (
                  <FlashlightOff className="h-5 w-5" />
                ) : (
                  <Flashlight className="h-5 w-5" />
                )}
                <span>Torch</span>
              </button>
            ) : (
              <div />
            )}

            {/* Manual entry */}
            <button
              type="button"
              onClick={() => setShowManual(!showManual)}
              className="flex h-12 items-center gap-2 rounded-full bg-black/60 px-4 text-sm text-white backdrop-blur-sm active:bg-black/80"
              aria-label="Manual barcode input"
            >
              <Keyboard className="h-5 w-5" />
              <span>Manual</span>
            </button>
          </div>
        )}

        {/* Scanning indicator */}
        {cameraReady && isActive && (
          <div className="absolute top-3 right-3 flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 backdrop-blur-sm">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
            <span className="text-xs text-emerald-400 font-medium">Scanning</span>
          </div>
        )}
      </div>

      {/* Manual input form */}
      {showManual && (
        <form
          onSubmit={handleManualSubmit}
          className="flex items-center gap-2 bg-zinc-900 px-3 py-3"
        >
          <input
            type="text"
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
            placeholder="Type or paste barcode..."
            autoFocus
            className="h-12 flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-4 text-sm text-white placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={manualInput.trim().length === 0}
            className="flex h-12 w-12 items-center justify-center rounded-lg bg-emerald-600 text-white disabled:opacity-40 active:bg-emerald-700"
          >
            <Search className="h-5 w-5" />
          </button>
        </form>
      )}

      {/* Scanline animation keyframes */}
      <style>{`
        @keyframes scanline {
          0%, 100% { top: 20%; opacity: 0.4; }
          50% { top: 80%; opacity: 0.8; }
        }
      `}</style>
    </div>
  );
}
