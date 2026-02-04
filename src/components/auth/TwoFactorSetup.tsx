// src/components/auth/TwoFactorSetup.tsx
// Simple email-based 2FA setup - sends code to email automatically
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
import { Loader2, Mail, AlertCircle, Check, Copy } from "lucide-react";
import { toast } from "sonner";

type SetupStep = "password" | "verify" | "backup";

interface TwoFactorSetupProps {
  userEmail: string;
}

export function TwoFactorSetup({ userEmail }: TwoFactorSetupProps) {
  const [step, setStep] = useState<SetupStep>("password");
  const [password, setPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleEnable2FA = async () => {
    setError(null);
    setIsLoading(true);

    try {
      const result = await authClient.twoFactor.enable({ password });

      if (result.error) {
        setError(result.error.message || "Incorrect password");
        setIsLoading(false);
        return;
      }

      if (result.data) {
        setBackupCodes(result.data.backupCodes || []);
        // Send email OTP immediately
        await authClient.twoFactor.sendOtp();
        setStep("verify");
        toast.success("Verification code sent to your email");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerify = async () => {
    setError(null);
    setIsLoading(true);

    try {
      const result = await authClient.twoFactor.verifyOtp({ code: verificationCode });

      if (result.error) {
        setError(result.error.message || "Invalid code");
        setIsLoading(false);
        return;
      }

      // Set email as the default 2FA method
      await fetch("/api/auth/update-2fa-method", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "email" }),
      });

      // Mark session as 2FA verified
      await fetch("/api/auth/mark-2fa-verified", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      setStep("backup");
    } catch {
      setError("Verification failed. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleResendOtp = async () => {
    setIsLoading(true);
    try {
      await authClient.twoFactor.sendOtp();
      toast.success("New code sent to your email");
    } catch {
      toast.error("Failed to send code");
    } finally {
      setIsLoading(false);
    }
  };

  const copyBackupCodes = () => {
    navigator.clipboard.writeText(backupCodes.join("\n"));
    toast.success("Backup codes copied");
  };

  const handleComplete = () => {
    window.location.href = "/admin";
  };

  // Password confirmation
  if (step === "password") {
    return (
      <Card className="w-full border-0 shadow-none bg-transparent">
        <CardHeader className="space-y-4 text-center px-0 pt-0">
          <div className="mx-auto w-16 h-16 bg-muted rounded-full flex items-center justify-center">
            <Mail className="h-8 w-8 text-foreground" />
          </div>
          <div className="space-y-2">
            <CardTitle className="text-2xl font-semibold tracking-tight">
              Verify your email
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              We'll send a verification code to {userEmail}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <form onSubmit={(e) => { e.preventDefault(); handleEnable2FA(); }} className="space-y-6">
            {error && (
              <div className="flex items-center gap-2 p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="password">Confirm your password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                className="h-11"
                disabled={isLoading}
                autoFocus
              />
            </div>

            <Button type="submit" disabled={isLoading || !password} className="w-full h-11">
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending code...
                </>
              ) : (
                "Send verification code"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    );
  }

  // Email verification
  if (step === "verify") {
    return (
      <Card className="w-full border-0 shadow-none bg-transparent">
        <CardHeader className="space-y-4 text-center px-0 pt-0">
          <div className="mx-auto w-16 h-16 bg-muted rounded-full flex items-center justify-center">
            <Mail className="h-8 w-8 text-foreground" />
          </div>
          <div className="space-y-2">
            <CardTitle className="text-2xl font-semibold tracking-tight">
              Check your email
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              Enter the 6-digit code sent to {userEmail}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <form onSubmit={(e) => { e.preventDefault(); handleVerify(); }} className="space-y-6">
            {error && (
              <div className="flex items-center gap-2 p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="code" className="sr-only">Verification Code</Label>
              <Input
                id="code"
                type="text"
                inputMode="numeric"
                value={verificationCode}
                onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, ""))}
                placeholder="000000"
                className="text-center text-2xl tracking-[0.5em] font-mono h-14"
                maxLength={6}
                disabled={isLoading}
                autoFocus
              />
            </div>

            <Button type="submit" disabled={isLoading || verificationCode.length !== 6} className="w-full h-11">
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Verifying...
                </>
              ) : (
                "Verify"
              )}
            </Button>

            <button
              type="button"
              onClick={handleResendOtp}
              disabled={isLoading}
              className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Didn't receive the code? <span className="underline">Resend</span>
            </button>
          </form>
        </CardContent>
      </Card>
    );
  }

  // Backup codes
  if (step === "backup") {
    return (
      <Card className="w-full border-0 shadow-none bg-transparent">
        <CardHeader className="space-y-4 text-center px-0 pt-0">
          <div className="mx-auto w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center">
            <Check className="h-8 w-8 text-green-600 dark:text-green-400" />
          </div>
          <div className="space-y-2">
            <CardTitle className="text-2xl font-semibold tracking-tight">
              You're all set!
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              Save these backup codes in case you lose access to your email.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0 space-y-6">
          <div className="bg-muted p-4 rounded-lg">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium">Backup codes</span>
              <Button variant="ghost" size="sm" onClick={copyBackupCodes} className="h-8">
                <Copy className="h-4 w-4 mr-1" />
                Copy
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2 font-mono text-sm">
              {backupCodes.map((code, index) => (
                <div key={index} className="text-center py-1">{code}</div>
              ))}
            </div>
          </div>

          <Button onClick={handleComplete} className="w-full h-11">
            Continue to dashboard
          </Button>
        </CardContent>
      </Card>
    );
  }

  return null;
}
