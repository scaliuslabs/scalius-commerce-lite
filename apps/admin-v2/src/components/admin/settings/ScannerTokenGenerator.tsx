import {
  SCANNER_SESSION_TTL_SECONDS,
  SCANNER_TOKEN_TTL_SECONDS,
} from "@scalius/shared/scanner-auth";
import {
  Check,
  Clock,
  Copy,
  Loader2,
  Plus,
  ScanBarcode,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { usePermissions } from "@/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "@/lib/admin-permissions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const TOKEN_LIFETIME_MS = SCANNER_TOKEN_TTL_SECONDS * 1000;
const TOKEN_LIFETIME_MINUTES = SCANNER_TOKEN_TTL_SECONDS / 60;
const SESSION_IDLE_HOURS = SCANNER_SESSION_TTL_SECONDS / (60 * 60);

export function ScannerTokenGenerator() {
  const { hasAllPermissions } = usePermissions();
  const canGenerate = hasAllPermissions([
    ADMIN_PERMISSIONS.PRODUCTS_VIEW,
    ADMIN_PERMISSIONS.PRODUCTS_EDIT,
  ]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [scannerUrl, setScannerUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [copied, setCopied] = useState(false);
  const [timeLeft, setTimeLeft] = useState("");

  useEffect(() => {
    if (!token) {
      setQrDataUrl(null);
      setScannerUrl(null);
      return;
    }

    const url = `${window.location.origin}/scanner?token=${token}`;
    setScannerUrl(url);
    setQrDataUrl(null);

    let active = true;
    void import("qrcode")
      .then(({ toDataURL }) => toDataURL(url, {
        width: 280,
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      }))
      .then((dataUrl) => {
        if (active) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!active) return;
        setQrDataUrl(null);
        toast.error("Scanner QR code could not be created");
      });

    return () => {
      active = false;
    };
  }, [token]);

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

      const totalMinutes = Math.ceil(remaining / 60_000);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      setTimeLeft(
        hours > 0
          ? `${hours}h ${minutes}m remaining`
          : `${minutes}m remaining`,
      );
    };

    update();
    const interval = window.setInterval(update, 30_000);
    return () => window.clearInterval(interval);
  }, [expiresAt]);

  async function handleGenerate() {
    if (!canGenerate) return;
    setIsGenerating(true);
    setCopied(false);

    try {
      const response = await fetch("/api/scanner-token", { method: "POST" });
      const json = (await response.json()) as {
        success: boolean;
        token?: string;
        expiresAt?: number;
        error?: string;
      };

      if (!response.ok || !json.success || !json.token) {
        toast.error(json.error || "Scanner link could not be created");
        return;
      }

      setToken(json.token);
      setExpiresAt(new Date(json.expiresAt ?? Date.now() + TOKEN_LIFETIME_MS));
      toast.success("Scanner link created");
    } catch {
      toast.error("Scanner link could not be created. Check the connection and try again.");
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleCopy() {
    if (!scannerUrl) return;
    try {
      await navigator.clipboard.writeText(scannerUrl);
      setCopied(true);
      toast.success("Scanner link copied");
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Scanner link could not be copied");
    }
  }

  return (
    <div className="max-w-2xl space-y-4">
      {!canGenerate && (
        <Alert>
          <AlertDescription>
            Product view and edit permissions are required to create scanner access.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ScanBarcode className="h-5 w-5" />
            Scanner access
          </CardTitle>
          <CardDescription>
            Create a one-time device link. It expires in {TOKEN_LIFETIME_MINUTES} minutes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {token ? (
            <div className="space-y-4">
              <div className="flex min-h-64 items-center justify-center">
                {qrDataUrl ? (
                  <div className="rounded-xl bg-white p-3 shadow-sm ring-1 ring-black/5">
                    <img
                      src={qrDataUrl}
                      alt="One-time warehouse scanner access QR code"
                      className="h-56 w-56"
                    />
                  </div>
                ) : (
                  <div className="flex h-56 w-56 items-center justify-center rounded-xl border bg-muted/20">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    <span className="sr-only">Creating QR code</span>
                  </div>
                )}
              </div>

              <div className="flex justify-center" aria-live="polite">
                <Badge variant="secondary" className="min-h-7 gap-1.5 px-3">
                  <Clock className="h-3.5 w-3.5" />
                  {timeLeft || "Calculating expiry…"}
                </Badge>
              </div>

              <Alert>
                <AlertDescription className="text-xs leading-5">
                  The first device to open this link claims it. Its scanner session stays active for up to {SESSION_IDLE_HOURS} hours after the latest check-in.
                </AlertDescription>
              </Alert>

              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 flex-1 sm:min-h-9"
                  disabled={!scannerUrl}
                  onClick={() => void handleCopy()}
                >
                  {copied ? (
                    <Check className="mr-2 h-4 w-4" />
                  ) : (
                    <Copy className="mr-2 h-4 w-4" />
                  )}
                  {copied ? "Copied" : "Copy link"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 flex-1 sm:min-h-9"
                  disabled={isGenerating || !canGenerate}
                  onClick={() => void handleGenerate()}
                >
                  {isGenerating ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="mr-2 h-4 w-4" />
                  )}
                  Create another link
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center space-y-4 py-6 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
                <ScanBarcode className="h-7 w-7 text-muted-foreground" />
              </div>
              <div className="max-w-sm space-y-1">
                <p className="text-sm font-medium">No active scanner link</p>
              </div>
              <Button
                type="button"
                className="min-h-11 w-full sm:min-h-9 sm:w-auto"
                disabled={isGenerating || !canGenerate}
                onClick={() => void handleGenerate()}
              >
                {isGenerating ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <ScanBarcode className="mr-2 h-4 w-4" />
                )}
                Create link
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
