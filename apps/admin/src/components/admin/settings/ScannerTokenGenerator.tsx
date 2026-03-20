import { useState, useEffect } from "react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Loader2,
  ScanBarcode,
  Copy,
  Check,
  Clock,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

const TOKEN_LIFETIME_MS = 6 * 60 * 60 * 1000; // 6 hours

export function ScannerTokenGenerator() {
  const [isGenerating, setIsGenerating] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [scannerUrl, setScannerUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [copied, setCopied] = useState(false);
  const [timeLeft, setTimeLeft] = useState("");

  // Generate QR code when token changes
  useEffect(() => {
    if (!token) {
      setQrDataUrl(null);
      setScannerUrl(null);
      return;
    }

    const url = `${window.location.origin}/scanner?token=${token}`;
    setScannerUrl(url);

    QRCode.toDataURL(url, {
      width: 280,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then(setQrDataUrl)
      .catch(() => {
        setQrDataUrl(null);
        toast.error("Failed to generate QR code");
      });
  }, [token]);

  // Countdown timer
  useEffect(() => {
    if (!expiresAt) {
      setTimeLeft("");
      return;
    }

    const update = () => {
      const remaining = expiresAt.getTime() - Date.now();
      if (remaining <= 0) {
        setTimeLeft("Expired");
        setToken(null);
        setExpiresAt(null);
        return;
      }

      const hours = Math.floor(remaining / (1000 * 60 * 60));
      const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
      setTimeLeft(`${hours}h ${minutes}m remaining`);
    };

    update();
    const interval = setInterval(update, 60_000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  const handleGenerate = async () => {
    setIsGenerating(true);
    setCopied(false);

    try {
      // Astro API route at pages/api/scanner-token.ts — not an API worker /api/v1/ route
      const res = await fetch("/api/scanner-token", { method: "POST" });
      const json = (await res.json()) as {
        success: boolean;
        token?: string;
        error?: string;
      };

      if (json.success && json.token) {
        setToken(json.token);
        setExpiresAt(new Date(Date.now() + TOKEN_LIFETIME_MS));
        toast.success("Scanner token generated");
      } else {
        toast.error(json.error || "Failed to generate token");
      }
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopy = async () => {
    if (!scannerUrl) return;

    try {
      await navigator.clipboard.writeText(scannerUrl);
      setCopied(true);
      toast.success("Scanner link copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy link");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ScanBarcode className="h-5 w-5" />
          Warehouse Scanner
        </CardTitle>
        <CardDescription>
          Generate a QR code for warehouse staff to access the barcode scanner
          on their mobile device. Each token is valid for 6 hours and can only be
          used once.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {token && qrDataUrl ? (
          <div className="space-y-4">
            {/* QR Code */}
            <div className="flex justify-center">
              <div className="bg-white p-4 rounded-xl shadow-sm">
                <img
                  src={qrDataUrl}
                  alt="Scanner QR Code"
                  className="w-56 h-56"
                />
              </div>
            </div>

            {/* Expiry badge */}
            <div className="flex justify-center">
              <Badge
                variant="secondary"
                className="flex items-center gap-1.5 px-3 py-1"
              >
                <Clock className="h-3.5 w-3.5" />
                {timeLeft}
              </Badge>
            </div>

            {/* Actions */}
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={handleCopy}
              >
                {copied ? (
                  <Check className="mr-2 h-4 w-4" />
                ) : (
                  <Copy className="mr-2 h-4 w-4" />
                )}
                {copied ? "Copied" : "Copy Link"}
              </Button>
              <Button
                variant="outline"
                onClick={handleGenerate}
                disabled={isGenerating}
              >
                {isGenerating ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                New Token
              </Button>
            </div>

            <p className="text-xs text-muted-foreground text-center">
              Show this QR code to warehouse staff. They scan it with their
              phone camera to open the scanner.
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center py-6 space-y-4">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
              <ScanBarcode className="h-8 w-8 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground text-center max-w-xs">
              Generate a one-time QR code that warehouse staff can scan to
              access the barcode scanner app.
            </p>
            <Button onClick={handleGenerate} disabled={isGenerating}>
              {isGenerating ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ScanBarcode className="mr-2 h-4 w-4" />
              )}
              Generate Scanner Token
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
