// src/components/auth/TwoFactorSetup.tsx
// Mandatory 2FA setup component - users choose between Authenticator App or Email
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
import {
  Loader2,
  Shield,
  AlertCircle,
  Smartphone,
  Mail,
  Check,
  Copy,
  ArrowLeft,
} from "lucide-react";
import { toast } from "sonner";

type SetupMethod = "choose" | "totp" | "email";
type SetupStep = "method" | "password" | "qr" | "verify" | "backup" | "complete";

interface TwoFactorSetupProps {
  userEmail: string;
}

export function TwoFactorSetup({ userEmail }: TwoFactorSetupProps) {
  const [method, setMethod] = useState<SetupMethod>("choose");
  const [step, setStep] = useState<SetupStep>("method");
  const [password, setPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleMethodSelect = (selectedMethod: SetupMethod) => {
    setMethod(selectedMethod);
    setStep("password");
    setError(null);
  };

  const handleEnable2FA = async () => {
    setError(null);
    setIsLoading(true);

    try {
      const result = await authClient.twoFactor.enable({
        password,
      });

      if (result.error) {
        setError(result.error.message || "Failed to enable 2FA");
        setIsLoading(false);
        return;
      }

      if (result.data) {
        setTotpUri(result.data.totpURI);
        setBackupCodes(result.data.backupCodes || []);

        if (method === "totp") {
          setStep("qr");
        } else {
          // For email method, send OTP and go to verify
          await authClient.twoFactor.sendOtp();
          setStep("verify");
        }
      }
    } catch {
      setError("Failed to enable 2FA");
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerify = async () => {
    setError(null);
    setIsLoading(true);

    try {
      let result;
      if (method === "totp") {
        result = await authClient.twoFactor.verifyTotp({
          code: verificationCode,
        });
      } else {
        result = await authClient.twoFactor.verifyOtp({
          code: verificationCode,
        });
      }

      if (result.error) {
        setError(result.error.message || "Invalid verification code");
        setIsLoading(false);
        return;
      }

      // Mark session as 2FA verified
      await fetch("/api/auth/mark-2fa-verified", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      setStep("backup");
      toast.success("Two-factor authentication enabled!");
    } catch {
      setError("Verification failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handleResendOtp = async () => {
    setIsLoading(true);
    try {
      await authClient.twoFactor.sendOtp();
      toast.success("Verification code sent to your email");
    } catch {
      toast.error("Failed to send verification code");
    } finally {
      setIsLoading(false);
    }
  };

  const copyBackupCodes = () => {
    navigator.clipboard.writeText(backupCodes.join("\n"));
    toast.success("Backup codes copied to clipboard");
  };

  const getQrCodeUrl = (uri: string) => {
    return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(uri)}`;
  };

  const handleComplete = () => {
    window.location.href = "/admin";
  };

  // Method selection screen
  if (step === "method") {
    return (
      <Card className="w-full shadow-lg border-border/50 bg-card/95 backdrop-blur-sm">
        <CardHeader className="space-y-1 text-center">
          <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-2">
            <Shield className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">
            Secure Your Account
          </CardTitle>
          <CardDescription>
            Two-factor authentication is required for admin accounts.
            <br />
            Choose your preferred verification method.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <button
            onClick={() => handleMethodSelect("totp")}
            className="w-full p-4 border rounded-lg hover:bg-muted/50 transition-colors text-left flex items-start gap-4"
          >
            <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center flex-shrink-0">
              <Smartphone className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h3 className="font-semibold">Authenticator App</h3>
              <p className="text-sm text-muted-foreground">
                Use Google Authenticator, Authy, or similar apps to generate codes.
                Works offline and is the most secure option.
              </p>
            </div>
          </button>

          <button
            onClick={() => handleMethodSelect("email")}
            className="w-full p-4 border rounded-lg hover:bg-muted/50 transition-colors text-left flex items-start gap-4"
          >
            <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center flex-shrink-0">
              <Mail className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h3 className="font-semibold">Email Verification</h3>
              <p className="text-sm text-muted-foreground">
                Receive verification codes via email at {userEmail}.
                Convenient but requires internet access.
              </p>
            </div>
          </button>
        </CardContent>
      </Card>
    );
  }

  // Password confirmation screen
  if (step === "password") {
    return (
      <Card className="w-full shadow-lg border-border/50 bg-card/95 backdrop-blur-sm">
        <CardHeader className="space-y-1 text-center">
          <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-2">
            {method === "totp" ? (
              <Smartphone className="h-6 w-6 text-primary" />
            ) : (
              <Mail className="h-6 w-6 text-primary" />
            )}
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">
            Confirm Your Password
          </CardTitle>
          <CardDescription>
            Enter your password to enable{" "}
            {method === "totp" ? "authenticator app" : "email"} verification
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="flex items-center gap-2 p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              disabled={isLoading}
              autoFocus
            />
          </div>

          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setStep("method");
                setMethod("choose");
                setPassword("");
                setError(null);
              }}
              disabled={isLoading}
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            <Button
              onClick={handleEnable2FA}
              disabled={isLoading || !password}
              className="flex-1"
            >
              {isLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Continue
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // QR code screen (TOTP only)
  if (step === "qr" && totpUri) {
    return (
      <Card className="w-full shadow-lg border-border/50 bg-card/95 backdrop-blur-sm">
        <CardHeader className="space-y-1 text-center">
          <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-2">
            <Smartphone className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">
            Scan QR Code
          </CardTitle>
          <CardDescription>
            Scan this code with your authenticator app
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex justify-center">
            <img
              src={getQrCodeUrl(totpUri)}
              alt="2FA QR Code"
              className="w-48 h-48 rounded-lg border bg-white p-2"
            />
          </div>
          <p className="text-sm text-muted-foreground text-center">
            Use Google Authenticator, Authy, 1Password, or any TOTP-compatible app
          </p>
          <Button onClick={() => setStep("verify")} className="w-full">
            I've Scanned the Code
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Verification screen
  if (step === "verify") {
    return (
      <Card className="w-full shadow-lg border-border/50 bg-card/95 backdrop-blur-sm">
        <CardHeader className="space-y-1 text-center">
          <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-2">
            {method === "totp" ? (
              <Smartphone className="h-6 w-6 text-primary" />
            ) : (
              <Mail className="h-6 w-6 text-primary" />
            )}
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">
            Enter Verification Code
          </CardTitle>
          <CardDescription>
            {method === "totp"
              ? "Enter the 6-digit code from your authenticator app"
              : `Enter the code sent to ${userEmail}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="flex items-center gap-2 p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="code">Verification Code</Label>
            <Input
              id="code"
              type="text"
              value={verificationCode}
              onChange={(e) => setVerificationCode(e.target.value)}
              placeholder="Enter 6-digit code"
              className="text-center text-lg tracking-widest"
              maxLength={6}
              disabled={isLoading}
              autoFocus
            />
          </div>

          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => setStep(method === "totp" ? "qr" : "password")}
              disabled={isLoading}
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            <Button
              onClick={handleVerify}
              disabled={isLoading || verificationCode.length !== 6}
              className="flex-1"
            >
              {isLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Verify
            </Button>
          </div>

          {method === "email" && (
            <Button
              type="button"
              variant="ghost"
              onClick={handleResendOtp}
              disabled={isLoading}
              className="w-full text-sm"
            >
              Didn't receive the code? Resend
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  // Backup codes screen
  if (step === "backup") {
    return (
      <Card className="w-full shadow-lg border-border/50 bg-card/95 backdrop-blur-sm">
        <CardHeader className="space-y-1 text-center">
          <div className="mx-auto w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mb-2">
            <Check className="h-6 w-6 text-green-600" />
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">
            Two-Factor Enabled!
          </CardTitle>
          <CardDescription>
            Save your backup codes in a safe place
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2 p-3 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg">
            <Check className="h-4 w-4 flex-shrink-0" />
            <span>Your account is now protected with two-factor authentication</span>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Backup Codes</Label>
              <Button variant="ghost" size="sm" onClick={copyBackupCodes}>
                <Copy className="h-4 w-4 mr-1" />
                Copy
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Use these codes to access your account if you lose your{" "}
              {method === "totp" ? "authenticator device" : "email access"}.
              Each code can only be used once.
            </p>
            <div className="bg-muted p-4 rounded-lg">
              <div className="grid grid-cols-2 gap-2 font-mono text-sm">
                {backupCodes.map((code, index) => (
                  <div key={index} className="text-center">
                    {code}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <Button onClick={handleComplete} className="w-full">
            Continue to Dashboard
          </Button>
        </CardContent>
      </Card>
    );
  }

  return null;
}
