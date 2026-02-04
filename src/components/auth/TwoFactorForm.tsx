// src/components/auth/TwoFactorForm.tsx
// Two-factor verification form for login - supports TOTP, Email OTP, and backup codes
// Auto-detects user's preferred 2FA method
import { useState, useEffect } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Loader2, AlertCircle, KeyRound, Mail, Smartphone, Shield, ArrowLeft } from "lucide-react";
import { toast } from "sonner";

type VerifyMethod = "totp" | "email" | "backup";

interface TwoFactorFormProps {
  defaultMethod?: "totp" | "email";
}

export function TwoFactorForm({ defaultMethod }: TwoFactorFormProps) {
  const [method, setMethod] = useState<VerifyMethod>(defaultMethod || "email");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [isInitializing, setIsInitializing] = useState(!defaultMethod);
  const [userEmail, setUserEmail] = useState<string>("");

  // Fetch user's preferred 2FA method on mount if not provided
  useEffect(() => {
    if (defaultMethod) {
      if (defaultMethod === "email") {
        sendEmailOtp();
      }
      return;
    }

    async function fetchTwoFactorInfo() {
      try {
        const response = await fetch("/api/auth/get-2fa-info");
        if (response.ok) {
          const data = await response.json();
          if (data.success && data.method) {
            setMethod(data.method);
            setUserEmail(data.email || "");
            if (data.method === "email") {
              await sendEmailOtp();
            }
          }
        }
      } catch {
        // Fall back to default (email)
      } finally {
        setIsInitializing(false);
      }
    }

    fetchTwoFactorInfo();
  }, [defaultMethod]);

  const sendEmailOtp = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await authClient.twoFactor.sendOtp();
      setEmailSent(true);
      toast.success("Verification code sent to your email");
    } catch {
      setError("Failed to send verification code");
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      let verifyResult;
      if (method === "backup") {
        verifyResult = await authClient.twoFactor.verifyBackupCode({ code });
      } else if (method === "email") {
        verifyResult = await authClient.twoFactor.verifyOtp({ code, trustDevice: true });
      } else {
        verifyResult = await authClient.twoFactor.verifyTotp({ code, trustDevice: true });
      }

      if (verifyResult.error) {
        setError(verifyResult.error.message || "Invalid verification code");
        setIsLoading(false);
        return;
      }

      // Mark the session as 2FA verified in our database
      await fetch("/api/auth/mark-2fa-verified", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      window.location.href = "/admin";
    } catch {
      setError("Verification failed. Please try again.");
      setIsLoading(false);
    }
  };

  const handleSignOut = async () => {
    await authClient.signOut();
    window.location.href = "/auth/login";
  };

  const switchMethod = (newMethod: VerifyMethod) => {
    setMethod(newMethod);
    setCode("");
    setError(null);
    setEmailSent(false);
  };

  // Loading state while fetching 2FA info
  if (isInitializing) {
    return (
      <Card className="w-full border-0 shadow-none bg-transparent">
        <CardContent className="py-16">
          <div className="flex flex-col items-center justify-center gap-4">
            <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center">
              <Shield className="h-8 w-8 text-muted-foreground animate-pulse" />
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Preparing verification...</span>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full border-0 shadow-none bg-transparent">
      <CardHeader className="space-y-4 text-center px-0 pt-0">
        <div className="mx-auto w-16 h-16 bg-muted rounded-full flex items-center justify-center">
          {method === "email" ? (
            <Mail className="h-8 w-8 text-foreground" />
          ) : method === "backup" ? (
            <KeyRound className="h-8 w-8 text-foreground" />
          ) : (
            <Smartphone className="h-8 w-8 text-foreground" />
          )}
        </div>
        <div className="space-y-2">
          <CardTitle className="text-2xl font-semibold tracking-tight">
            {method === "email"
              ? "Check your email"
              : method === "backup"
              ? "Enter backup code"
              : "Enter verification code"}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {method === "email"
              ? emailSent
                ? `We sent a code to ${userEmail || "your email"}`
                : "We'll send a verification code to your email"
              : method === "backup"
              ? "Enter one of your saved backup codes"
              : "Enter the 6-digit code from your authenticator app"}
          </CardDescription>
        </div>
      </CardHeader>

      <CardContent className="px-0 pb-0">
        <form onSubmit={handleVerify} className="space-y-6">
          {error && (
            <div className="flex items-center gap-2 p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {method === "email" && !emailSent ? (
            <Button
              type="button"
              onClick={sendEmailOtp}
              className="w-full h-11"
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : (
                "Send verification code"
              )}
            </Button>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="code" className="sr-only">
                  {method === "backup" ? "Backup Code" : "Verification Code"}
                </Label>
                <Input
                  id="code"
                  type="text"
                  inputMode={method === "backup" ? "text" : "numeric"}
                  placeholder={method === "backup" ? "Enter backup code" : "000000"}
                  value={code}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (method === "backup") {
                      setCode(val);
                    } else {
                      setCode(val.replace(/\D/g, ""));
                    }
                  }}
                  className="text-center text-2xl tracking-[0.5em] font-mono h-14"
                  maxLength={method === "backup" ? 12 : 6}
                  required
                  disabled={isLoading}
                  autoFocus
                  autoComplete="one-time-code"
                />
              </div>

              <Button
                type="submit"
                className="w-full h-11"
                disabled={isLoading || (method !== "backup" && code.length !== 6)}
              >
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  "Verify"
                )}
              </Button>

              {method === "email" && (
                <button
                  type="button"
                  onClick={sendEmailOtp}
                  disabled={isLoading}
                  className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  Didn't receive the code? <span className="underline">Resend</span>
                </button>
              )}
            </>
          )}

          <div className="pt-4 border-t">
            <p className="text-xs text-muted-foreground text-center mb-4">
              Or use a different method
            </p>
            <div className="flex gap-2">
              {method !== "totp" && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => switchMethod("totp")}
                  disabled={isLoading}
                  className="flex-1 h-10"
                  size="sm"
                >
                  <Smartphone className="h-4 w-4 mr-2" />
                  Authenticator
                </Button>
              )}
              {method !== "email" && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => switchMethod("email")}
                  disabled={isLoading}
                  className="flex-1 h-10"
                  size="sm"
                >
                  <Mail className="h-4 w-4 mr-2" />
                  Email
                </Button>
              )}
              {method !== "backup" && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => switchMethod("backup")}
                  disabled={isLoading}
                  className="flex-1 h-10"
                  size="sm"
                >
                  <KeyRound className="h-4 w-4 mr-2" />
                  Backup
                </Button>
              )}
            </div>
          </div>

          <div className="pt-2">
            <button
              type="button"
              onClick={handleSignOut}
              disabled={isLoading}
              className="w-full flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to sign in
            </button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
