// src/components/auth/TwoFactorForm.tsx
// Two-factor verification form for login - supports TOTP, Email OTP, and backup codes
import { useState } from "react";
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
import { Loader2, AlertCircle, KeyRound, Mail, Smartphone } from "lucide-react";
import { toast } from "sonner";

type VerifyMethod = "totp" | "email" | "backup";

export function TwoFactorForm() {
  const [method, setMethod] = useState<VerifyMethod>("totp");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [emailSent, setEmailSent] = useState(false);

  const handleSendEmailOtp = async () => {
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
      // Verify with Better Auth to properly set session cookies
      let verifyResult;
      if (method === "backup") {
        verifyResult = await authClient.twoFactor.verifyBackupCode({
          code,
        });
      } else if (method === "email") {
        verifyResult = await authClient.twoFactor.verifyOtp({
          code,
          trustDevice: true,
        });
      } else {
        verifyResult = await authClient.twoFactor.verifyTotp({
          code,
          trustDevice: true,
        });
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

      // Redirect to admin on success
      window.location.href = "/admin";
    } catch (err) {
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

  const getMethodIcon = () => {
    switch (method) {
      case "email":
        return <Mail className="h-6 w-6 text-primary" />;
      case "backup":
        return <KeyRound className="h-6 w-6 text-primary" />;
      default:
        return <Smartphone className="h-6 w-6 text-primary" />;
    }
  };

  const getMethodDescription = () => {
    switch (method) {
      case "email":
        return emailSent
          ? "Enter the code sent to your email"
          : "We'll send a verification code to your email";
      case "backup":
        return "Enter one of your backup codes";
      default:
        return "Enter the code from your authenticator app";
    }
  };

  return (
    <Card className="w-full shadow-lg border-border/50 bg-card/95 backdrop-blur-sm">
      <CardHeader className="space-y-1 text-center">
        <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-2">
          {getMethodIcon()}
        </div>
        <CardTitle className="text-2xl font-bold tracking-tight">
          Two-Factor Authentication
        </CardTitle>
        <CardDescription>{getMethodDescription()}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleVerify} className="space-y-4">
          {error && (
            <div className="flex items-center gap-2 p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {method === "email" && !emailSent ? (
            <Button
              type="button"
              onClick={handleSendEmailOtp}
              className="w-full"
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Mail className="mr-2 h-4 w-4" />
                  Send Verification Code
                </>
              )}
            </Button>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="code">
                  {method === "backup" ? "Backup Code" : "Verification Code"}
                </Label>
                <Input
                  id="code"
                  type="text"
                  placeholder={
                    method === "backup" ? "Enter backup code" : "Enter 6-digit code"
                  }
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="text-center text-lg tracking-widest"
                  maxLength={method === "backup" ? 10 : 6}
                  required
                  disabled={isLoading}
                  autoFocus
                />
              </div>

              <Button type="submit" className="w-full" disabled={isLoading}>
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
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleSendEmailOtp}
                  disabled={isLoading}
                  className="w-full text-sm"
                >
                  Didn't receive the code? Resend
                </Button>
              )}
            </>
          )}

          <div className="flex flex-col gap-2 pt-2 border-t">
            <p className="text-xs text-muted-foreground text-center pt-2">
              Or use a different method:
            </p>
            <div className="flex gap-2">
              {method !== "totp" && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => switchMethod("totp")}
                  disabled={isLoading}
                  className="flex-1 text-sm"
                >
                  <Smartphone className="mr-2 h-4 w-4" />
                  Authenticator
                </Button>
              )}
              {method !== "email" && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => switchMethod("email")}
                  disabled={isLoading}
                  className="flex-1 text-sm"
                >
                  <Mail className="mr-2 h-4 w-4" />
                  Email
                </Button>
              )}
              {method !== "backup" && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => switchMethod("backup")}
                  disabled={isLoading}
                  className="flex-1 text-sm"
                >
                  <KeyRound className="mr-2 h-4 w-4" />
                  Backup
                </Button>
              )}
            </div>

            <Button
              type="button"
              variant="link"
              onClick={handleSignOut}
              disabled={isLoading}
              className="text-sm text-muted-foreground"
            >
              Sign in with a different account
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
