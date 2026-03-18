import { useState, useEffect, useRef, useCallback } from "react";
import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";
import { Camera, CameraOff, Flashlight, FlashlightOff, Keyboard, Search } from "lucide-react";

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

const SUPPORTED_FORMATS = [
  Html5QrcodeSupportedFormats.CODE_128,
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
  Html5QrcodeSupportedFormats.QR_CODE,
  Html5QrcodeSupportedFormats.CODE_39,
  Html5QrcodeSupportedFormats.ITF,
  Html5QrcodeSupportedFormats.CODABAR,
];

const SCAN_CONFIG = {
  fps: 15,
  qrbox: { width: 300, height: 100 },
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

  const scannerRef = useRef<Html5Qrcode | null>(null);
  const lastScanRef = useRef<{ code: string; time: number }>({ code: "", time: 0 });
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  // ---- Debounced scan handler ----
  const handleDecodedText = useCallback(
    (decodedText: string, result: { result: { format?: { formatName: string } } }) => {
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
    if (!isActive) return;

    let cancelled = false;
    const scanner = new Html5Qrcode(READER_ID, {
      formatsToSupport: SUPPORTED_FORMATS,
      verbose: false,
    });
    scannerRef.current = scanner;

    scanner
      .start(
        { facingMode: "environment" },
        SCAN_CONFIG,
        (decodedText, result) => {
          if (!cancelled) handleDecodedText(decodedText, result);
        },
        () => {
          // Scan error (no code found in frame) — silent
        },
      )
      .then(() => {
        if (cancelled) return;
        setCameraReady(true);
        setCameraError(null);

        // Check torch support
        try {
          const caps = scanner.getRunningTrackCameraCapabilities();
          const torch = caps.torchFeature();
          setTorchSupported(torch.isSupported());
        } catch {
          setTorchSupported(false);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setCameraError(message);
        setCameraReady(false);
      });

    return () => {
      cancelled = true;
      setCameraReady(false);
      setTorchOn(false);
      setTorchSupported(false);
      if (scanner.isScanning) {
        scanner.stop().catch(() => {});
      }
      scannerRef.current = null;
    };
  }, [isActive, handleDecodedText]);

  // ---- USB/Bluetooth keyboard-wedge scanner ----
  useEffect(() => {
    let buffer = "";
    let timeout: ReturnType<typeof setTimeout>;

    const handler = (e: KeyboardEvent) => {
      // Ignore events when manual input is focused
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
      // Torch failed — ignore
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
    <div className="relative flex flex-col bg-black">
      {/* Camera viewfinder */}
      <div className="relative w-full" style={{ minHeight: "240px" }}>
        <div
          id={READER_ID}
          className="h-full w-full [&_video]:h-full [&_video]:w-full [&_video]:object-cover"
        />

        {/* Scanning overlay guides */}
        {cameraReady && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="border-2 border-white/40 rounded-lg" style={{ width: 300, height: 100 }}>
              <div className="absolute -top-0.5 -left-0.5 h-4 w-4 border-t-2 border-l-2 border-emerald-400 rounded-tl" />
              <div className="absolute -top-0.5 -right-0.5 h-4 w-4 border-t-2 border-r-2 border-emerald-400 rounded-tr" />
              <div className="absolute -bottom-0.5 -left-0.5 h-4 w-4 border-b-2 border-l-2 border-emerald-400 rounded-bl" />
              <div className="absolute -bottom-0.5 -right-0.5 h-4 w-4 border-b-2 border-r-2 border-emerald-400 rounded-br" />
            </div>
          </div>
        )}

        {/* Camera error state */}
        {cameraError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900 p-6 text-center">
            <CameraOff className="mb-3 h-10 w-10 text-zinc-500" />
            <p className="text-sm text-zinc-400">{cameraError}</p>
            <p className="mt-2 text-xs text-zinc-500">
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
      </div>

      {/* Controls bar */}
      <div className="flex items-center justify-between gap-2 bg-zinc-900 px-3 py-2">
        {/* Torch */}
        {showTorchButton && torchSupported && (
          <button
            type="button"
            onClick={toggleTorch}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-zinc-800 text-zinc-300 active:bg-zinc-700"
            aria-label={torchOn ? "Turn off flashlight" : "Turn on flashlight"}
          >
            {torchOn ? (
              <FlashlightOff className="h-5 w-5" />
            ) : (
              <Flashlight className="h-5 w-5" />
            )}
          </button>
        )}

        {/* Manual entry toggle */}
        <button
          type="button"
          onClick={() => setShowManual(!showManual)}
          className="flex h-11 items-center gap-1.5 rounded-full bg-zinc-800 px-4 text-sm text-zinc-300 active:bg-zinc-700"
          aria-label="Manual barcode input"
        >
          {showManual ? (
            <Camera className="h-4 w-4" />
          ) : (
            <Keyboard className="h-4 w-4" />
          )}
          <span>{showManual ? "Camera" : "Manual"}</span>
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Status indicator */}
        {cameraReady && isActive && (
          <div className="flex items-center gap-1.5 text-xs text-emerald-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
            Scanning
          </div>
        )}
      </div>

      {/* Manual input form */}
      {showManual && (
        <form
          onSubmit={handleManualSubmit}
          className="flex items-center gap-2 bg-zinc-900 px-3 pb-3"
        >
          <input
            type="text"
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
            placeholder="Type or paste barcode..."
            autoFocus
            className="h-11 flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 text-sm text-white placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={manualInput.trim().length === 0}
            className="flex h-11 w-11 items-center justify-center rounded-lg bg-emerald-600 text-white disabled:opacity-40 active:bg-emerald-700"
          >
            <Search className="h-5 w-5" />
          </button>
        </form>
      )}
    </div>
  );
}
