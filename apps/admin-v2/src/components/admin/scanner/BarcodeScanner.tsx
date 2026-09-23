import { useState, useEffect, useRef, useCallback } from "react";
import { CameraOff, Flashlight, FlashlightOff, Keyboard, Search, Camera } from "lucide-react";
import type { Html5Qrcode as Html5QrcodeInstance } from "html5-qrcode";
import { useMessages } from "~/i18n";
import { scannerMessages } from "~/i18n/scanner";

interface BarcodeScannerProps {
  onScan: (code: string, format: string) => void;
  isActive: boolean;
  showTorchButton?: boolean;
}

const SCAN_CONFIG = {
  fps: 15,
  qrbox: { width: 280, height: 90 },
  aspectRatio: 1.777778,
  disableFlip: true,
};

const DEBOUNCE_MS = 2000;
const READER_ID = "barcode-scanner-reader";

export function BarcodeScanner({
  onScan,
  isActive,
  showTorchButton = true,
}: BarcodeScannerProps) {
  const t = useMessages(scannerMessages);
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
    <div className="relative flex h-full flex-col bg-background">
      <div className="relative min-h-0 flex-1">
        <div
          id={READER_ID}
          className="h-full w-full [&_video]:h-full [&_video]:w-full [&_video]:object-cover"
        />

        {cameraReady ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="relative h-24 w-72 rounded-lg border-2 border-primary/40">
              <div className="absolute inset-x-2 top-1/2 h-0.5 animate-pulse bg-primary" />
            </div>
          </div>
        ) : null}

        {cameraError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-card p-6 text-center">
            <CameraOff className="mb-3 size-12 text-muted-foreground" />
            <p className="text-body text-muted-foreground">{cameraError}</p>
            <p className="mt-2 text-body text-muted-foreground">{t("cameraHelp")}</p>
          </div>
        ) : null}

        {!isActive && !cameraError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-card text-muted-foreground">
            <Camera className="mb-2 size-8" />
            <p className="text-body">{t("cameraPaused")}</p>
          </div>
        ) : null}

        {cameraReady && isActive ? (
          <>
            <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between">
              {showTorchButton && torchSupported ? (
                <button
                  type="button"
                  onClick={toggleTorch}
                  className="flex h-12 items-center gap-2 rounded-full bg-background/60 px-4 text-body backdrop-blur-sm active:bg-background/80"
                  aria-label={t(torchOn ? "torchOff" : "torchOn")}
                >
                  {torchOn ? <FlashlightOff className="size-5" /> : <Flashlight className="size-5" />}
                  <span>{t("torch")}</span>
                </button>
              ) : (
                <div />
              )}
              <button
                type="button"
                onClick={() => setShowManual(!showManual)}
                className="flex h-12 items-center gap-2 rounded-full bg-background/60 px-4 text-body backdrop-blur-sm active:bg-background/80"
              >
                <Keyboard className="size-5" />
                <span>{t("typeCode")}</span>
              </button>
            </div>
            <div className="absolute right-3 top-3 flex items-center gap-2 rounded-full bg-background/60 px-3 py-1 backdrop-blur-sm">
              <span className="size-2 animate-pulse rounded-full bg-primary" />
              <span className="text-body font-medium">{t("scanning")}</span>
            </div>
          </>
        ) : null}
      </div>

      {showManual ? (
        <form method="post" onSubmit={handleManualSubmit} className="flex items-center gap-2 bg-card px-3 py-3" noValidate>
          <input
            type="text"
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
            placeholder={t("codePlaceholder")}
            aria-label={t("codePlaceholder")}
            autoFocus
            className="h-12 flex-1 rounded-lg border bg-muted px-4 text-body placeholder:text-muted-foreground focus:border-ring focus:outline-none"
          />
          <button
            type="submit"
            disabled={manualInput.trim().length === 0}
            aria-label={t("find")}
            className="flex size-12 items-center justify-center rounded-lg bg-primary text-primary-foreground active:opacity-80 disabled:opacity-40"
          >
            <Search className="size-5" />
          </button>
        </form>
      ) : null}
    </div>
  );
}
