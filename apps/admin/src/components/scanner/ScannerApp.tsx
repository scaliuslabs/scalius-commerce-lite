import { useState, useEffect, useCallback } from "react";
import { Loader2, ScanBarcode, ShieldAlert, CheckCircle2 } from "lucide-react";

interface ScannerAppProps {
  token: string;
}

type AuthState = "verifying" | "authenticated" | "error" | "no-token";

/**
 * ScannerApp — minimal shell for the warehouse barcode scanner.
 *
 * Handles QR-token verification on mount. Once authenticated the scanner
 * UI is rendered (placeholder — full implementation by dedicated agent).
 */
export default function ScannerApp({ token }: ScannerAppProps) {
  const [authState, setAuthState] = useState<AuthState>(
    token ? "verifying" : "no-token",
  );
  const [adminName, setAdminName] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const verifyToken = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/scanner-token?token=${encodeURIComponent(token)}`,
      );
      const json = (await res.json()) as {
        success: boolean;
        valid?: boolean;
        adminName?: string;
        error?: string;
      };

      if (json.success && json.valid) {
        setAdminName(json.adminName || "");
        setAuthState("authenticated");
      } else {
        setErrorMessage(json.error || "Invalid or expired token");
        setAuthState("error");
      }
    } catch {
      setErrorMessage("Network error. Please try again.");
      setAuthState("error");
    }
  }, [token]);

  useEffect(() => {
    if (token) {
      verifyToken();
    }
  }, [token, verifyToken]);

  // No token provided
  if (authState === "no-token") {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-6 text-center">
        <ShieldAlert className="h-16 w-16 text-muted-foreground mb-4" />
        <h1 className="text-xl font-semibold mb-2">Scanner Access Required</h1>
        <p className="text-muted-foreground max-w-sm">
          Scan the QR code provided by your admin to access the scanner.
        </p>
      </div>
    );
  }

  // Verifying token
  if (authState === "verifying") {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-6 text-center">
        <Loader2 className="h-12 w-12 animate-spin text-primary mb-4" />
        <p className="text-muted-foreground">Verifying access...</p>
      </div>
    );
  }

  // Token error
  if (authState === "error") {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-6 text-center">
        <ShieldAlert className="h-16 w-16 text-destructive mb-4" />
        <h1 className="text-xl font-semibold mb-2">Access Denied</h1>
        <p className="text-muted-foreground max-w-sm">{errorMessage}</p>
        <p className="text-sm text-muted-foreground mt-4">
          Ask your admin to generate a new scanner QR code.
        </p>
      </div>
    );
  }

  // Authenticated — scanner UI shell
  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-border bg-card">
        <div className="flex items-center gap-2">
          <ScanBarcode className="h-5 w-5 text-primary" />
          <span className="font-semibold text-sm">Scalius Scanner</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
          <span>{adminName}</span>
        </div>
      </header>

      {/* Main scanner area — placeholder for full scanner UI */}
      <main className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <ScanBarcode className="h-20 w-20 text-muted-foreground/30 mb-6" />
        <h2 className="text-lg font-medium mb-2">Scanner Ready</h2>
        <p className="text-sm text-muted-foreground max-w-xs">
          The barcode scanner interface will appear here. Point your device
          camera at a barcode to begin scanning.
        </p>
      </main>
    </div>
  );
}
