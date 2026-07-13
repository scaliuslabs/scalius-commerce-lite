import { useState, useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import { authClient } from "~/lib/auth-client";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Loader2,
  Shield,
  ShieldCheck,
  ShieldOff,
  AlertCircle,
  Check,
  Copy,
  Smartphone,
  Mail,
} from "lucide-react";
import { toast } from "sonner";
import {
  set2faMethod,
} from "~/lib/api-functions/auth-management";
import { refreshAdminRouteContext } from "~/lib/admin-route-context";
import type { User } from "./AccountSettingsContainer";

type TwoFactorStep = "method" | "password" | "qr" | "verify" | "backup";
type TwoFactorMethod = "totp" | "email";
type SetupMode = "enable" | "disable" | "change";

interface TwoFactorSetupProps {
  user: User;
}

export function TwoFactorSetup({ user }: TwoFactorSetupProps) {
  const router = useRouter();
  const [isEnabled, setIsEnabled] = useState(user.twoFactorEnabled ?? false);
  const [currentMethod, setCurrentMethod] = useState<TwoFactorMethod>(
    (user.twoFactorMethod as TwoFactorMethod) || "email"
  );
  const [isLoading, setIsLoading] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [setupMode, setSetupMode] = useState<SetupMode>("enable");
  const [selectedMethod, setSelectedMethod] = useState<TwoFactorMethod>("email");
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [verificationCode, setVerificationCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<TwoFactorStep>("method");

  const setVerifiedMethod = async (method: TwoFactorMethod, code: string) => {
    if (method === "totp") {
      await set2faMethod({ data: { method, code } });
      return;
    }

    const result = await authClient.twoFactor.verifyOtp({
      code,
      trustDevice: false,
    });

    if (result.error) {
      throw new Error(result.error.message || "Invalid verification code");
    }

    const sessionToken = result.data?.token;
    if (!sessionToken) {
      throw new Error("Verification succeeded, but no session proof was returned.");
    }

    await set2faMethod({ data: { method, sessionToken } });
  };

  const refreshAdminContext = () => {
    void refreshAdminRouteContext(router);
  };

  const handleEnable2FA = async () => {
    setError(null);
    setIsLoading(true);

    try {
      const result = await authClient.twoFactor.enable({ password });

      if (result.error) {
        setError(result.error.message || "Failed to enable 2FA");
        return;
      }

      if (result.data) {
        setTotpUri(result.data.totpURI);
        setBackupCodes(result.data.backupCodes || []);

        if (selectedMethod === "totp") {
          setStep("qr");
        } else {
          const otpResult = await authClient.twoFactor.sendOtp();
          if (otpResult?.error) {
            setError(otpResult.error.message || "Failed to send verification code");
            return;
          }
          setStep("verify");
        }
      }
    } catch {
      setError("Failed to enable 2FA");
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerify2FA = async () => {
    setError(null);
    setIsLoading(true);

    try {
      await setVerifiedMethod(selectedMethod, verificationCode);

      setStep("backup");
      setIsEnabled(true);
      setCurrentMethod(selectedMethod);
      refreshAdminContext();
      toast.success(
        setupMode === "change"
          ? "Verification method changed successfully"
          : "Two-factor authentication enabled",
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSetupTotpForChange = async () => {
    setError(null);
    setIsLoading(true);

    try {
      const result = await authClient.twoFactor.enable({ password });

      if (result.error) {
        setError(result.error.message || "Failed to setup authenticator");
        return;
      }

      if (result.data) {
        setTotpUri(result.data.totpURI);
        setBackupCodes(result.data.backupCodes || []);
        setStep("qr");
      }
    } catch {
      setError("Failed to setup authenticator");
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerifyTotpForChange = async () => {
    setError(null);
    setIsLoading(true);

    try {
      await setVerifiedMethod("totp", verificationCode);

      setCurrentMethod("totp");
      setStep("backup");
      refreshAdminContext();
      toast.success("Authenticator app configured successfully");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handleChangeToEmail = async () => {
    setError(null);
    setIsLoading(true);

    try {
      const result = await authClient.twoFactor.sendOtp();
      if (result?.error) {
        setError(result.error.message || "Failed to send verification code");
        return;
      }
      setStep("verify");
      toast.success("Verification code sent to your email");
    } catch {
      setError("Failed to send verification code");
    } finally {
      setIsLoading(false);
    }
  };

  const handleDisable2FA = async () => {
    setError(null);
    setIsLoading(true);

    try {
      const result = await authClient.twoFactor.disable({ password });

      if (result.error) {
        setError(result.error.message || "Failed to disable 2FA");
        return;
      }

      setIsEnabled(false);
      setShowSetup(false);
      resetState();
      refreshAdminContext();
      toast.success("Two-factor authentication disabled");
    } catch {
      setError("Failed to disable 2FA");
    } finally {
      setIsLoading(false);
    }
  };

  const handleResendOtp = async () => {
    setIsLoading(true);
    try {
      const result = await authClient.twoFactor.sendOtp();
      if (result?.error) {
        toast.error(result.error.message || "Failed to send verification code");
        return;
      }
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

  // Generate QR code locally as data URI after the TOTP setup flow needs it.
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!totpUri) {
      setQrDataUrl(null);
      return;
    }

    let active = true;
    setQrDataUrl(null);

    void import("qrcode")
      .then(({ toDataURL }) => toDataURL(totpUri, { width: 200, margin: 2 }))
      .then((dataUrl) => {
        if (active) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (active) setQrDataUrl(null);
      });

    return () => {
      active = false;
    };
  }, [totpUri]);

  const resetState = () => {
    setStep("method");
    setPassword("");
    setVerificationCode("");
    setTotpUri(null);
    setBackupCodes([]);
    setError(null);
    setSelectedMethod(currentMethod);
  };

  const startSetup = (mode: SetupMode) => {
    setSetupMode(mode);
    setShowSetup(true);
    if (mode === "disable") {
      setStep("password");
    } else if (mode === "change") {
      setStep("method");
      setSelectedMethod(currentMethod === "totp" ? "email" : "totp");
    } else {
      setStep("method");
    }
  };

  if (showSetup) {
    return (
      <Card className="max-w-3xl rounded-xl shadow-none">
        <CardHeader className="p-4 pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-4 w-4" />
            {setupMode === "disable"
              ? "Disable two-factor authentication"
              : setupMode === "change"
                ? "Change verification method"
                : "Enable two-factor authentication"}
          </CardTitle>
          <CardDescription>
            {setupMode === "disable"
              ? "Enter your password to confirm"
              : setupMode === "change"
                ? "Choose your preferred verification method"
                : "Add an extra layer of security to your account"}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {error && (
            <div role="alert" className="mb-4 flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {step === "method" && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setSelectedMethod("totp")}
                  className={`min-h-24 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selectedMethod === "totp"
                    ? "border-primary bg-primary/5"
                    : "hover:bg-muted/50 hover:border-muted-foreground/20"
                    }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${selectedMethod === "totp" ? "bg-primary/10" : "bg-muted"
                      }`}>
                      <Smartphone className={`h-5 w-5 ${selectedMethod === "totp" ? "text-primary" : "text-muted-foreground"}`} />
                    </div>
                    <div>
                      <p className="font-medium">Authenticator app</p>
                      <p className="text-xs text-muted-foreground">Google Authenticator, Authy</p>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground mt-3">
                    More secure. Works offline.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedMethod("email")}
                  className={`min-h-24 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selectedMethod === "email"
                    ? "border-primary bg-primary/5"
                    : "hover:bg-muted/50 hover:border-muted-foreground/20"
                    }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${selectedMethod === "email" ? "bg-primary/10" : "bg-muted"
                      }`}>
                      <Mail className={`h-5 w-5 ${selectedMethod === "email" ? "text-primary" : "text-muted-foreground"}`} />
                    </div>
                    <div>
                      <p className="font-medium">Email</p>
                      <p className="text-xs text-muted-foreground">{user.email}</p>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground mt-3">
                    More convenient. No app needed.
                  </p>
                </button>
              </div>
              <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
                <Button
                  onClick={() => {
                    if (setupMode === "change" && selectedMethod === "email") {
                      handleChangeToEmail();
                    } else {
                      setStep("password");
                    }
                  }}
                  disabled={isLoading}
                  className="min-h-10 sm:order-2 sm:flex-none"
                >
                  {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Continue
                </Button>
                <Button
                  variant="outline"
                  onClick={() => { setShowSetup(false); resetState(); }}
                  disabled={isLoading}
                  className="min-h-10"
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {step === "password" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="2fa-password">Confirm your password</Label>
                <Input
                  id="2fa-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  disabled={isLoading}
                  autoFocus
                />
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  onClick={() => {
                    if (setupMode === "disable") handleDisable2FA();
                    else if (setupMode === "change" && selectedMethod === "totp") handleSetupTotpForChange();
                    else handleEnable2FA();
                  }}
                  disabled={isLoading || !password}
                  variant={setupMode === "disable" ? "destructive" : "default"}
                  className="min-h-10 sm:order-2 sm:flex-none"
                >
                  {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {setupMode === "disable" ? "Disable 2FA" : "Continue"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    if (setupMode === "enable" || setupMode === "change") setStep("method");
                    else { setShowSetup(false); resetState(); }
                  }}
                  disabled={isLoading}
                  className="min-h-10"
                >
                  Back
                </Button>
              </div>
            </div>
          )}

          {step === "qr" && totpUri && (
            <div className="space-y-4">
              <div className="text-center space-y-4">
                <p className="text-sm text-muted-foreground">
                  Scan this QR code with your authenticator app
                </p>
                <div className="flex justify-center">
                  <div className="rounded-lg bg-white p-3 shadow-sm">
                    {qrDataUrl ? (
                      <img
                        src={qrDataUrl}
                        alt="Authenticator setup QR code"
                        className="w-48 h-48"
                      />
                    ) : (
                      <div className="w-48 h-48 flex items-center justify-center">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <Button onClick={() => setStep("verify")} className="min-h-10 w-full">
                I scanned the code
              </Button>
            </div>
          )}

          {step === "verify" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="verification-code">
                  {selectedMethod === "email"
                    ? "Enter the code sent to your email"
                    : "Enter the 6-digit code from your app"}
                </Label>
                <Input
                  id="verification-code"
                  type="text"
                  value={verificationCode}
                  onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="000000"
                  className="text-center text-2xl tracking-[0.5em] font-mono h-14"
                  maxLength={6}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  disabled={isLoading}
                  autoFocus
                />
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  onClick={() => {
                    if (setupMode === "change" && selectedMethod === "totp") handleVerifyTotpForChange();
                    else handleVerify2FA();
                  }}
                  disabled={isLoading || verificationCode.length !== 6}
                  className="min-h-10 sm:order-2 sm:flex-none"
                >
                  {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Verify
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setStep(selectedMethod === "totp" ? "qr" : "password")}
                  className="min-h-10"
                >
                  Back
                </Button>
              </div>
              {selectedMethod === "email" && (
                <Button
                  type="button"
                  variant="link"
                  onClick={handleResendOtp}
                  disabled={isLoading}
                  className="w-full text-sm"
                >
                  Didn't receive the code? Resend
                </Button>
              )}
            </div>
          )}

          {step === "backup" && backupCodes.length > 0 && (
            <div className="space-y-4">
              <div role="status" className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-foreground">
                <Check className="h-4 w-4 flex-shrink-0" />
                <span>Two-factor authentication is enabled.</span>
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>Recovery codes</Label>
                  <Button variant="ghost" size="sm" onClick={copyBackupCodes}>
                    <Copy className="h-4 w-4 mr-1" />
                    Copy
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">
                  Save these codes securely. Each code can only be used once.
                </p>
                <div className="bg-muted/50 p-4 rounded-lg border">
                  <div className="grid grid-cols-1 gap-2 font-mono text-sm min-[420px]:grid-cols-2">
                    {backupCodes.map((code) => (
                      <div key={code} className="break-all rounded bg-background py-1 text-center">
                        {code}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <Button onClick={() => { setShowSetup(false); resetState(); }} className="min-h-10 w-full">
                Done
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="max-w-3xl rounded-xl shadow-none">
      <CardHeader className="p-4 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          {isEnabled ? (
            <ShieldCheck className="h-4 w-4 text-primary" />
          ) : (
            <ShieldOff className="h-4 w-4 text-muted-foreground" />
          )}
          Two-factor authentication
        </CardTitle>
        <CardDescription>
          {isEnabled
            ? "Your account is protected with an extra layer of security"
            : "Protect your account with two-factor authentication"}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {isEnabled ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
                {currentMethod === "totp" ? (
                  <Smartphone className="h-5 w-5 text-primary" />
                ) : (
                  <Mail className="h-5 w-5 text-primary" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-foreground">
                  {currentMethod === "totp" ? "Authenticator app" : "Email verification"}
                </p>
                <p className="break-words text-sm text-muted-foreground">
                  {currentMethod === "totp"
                    ? "Using authenticator app for verification"
                    : `Codes sent to ${user.email}`}
                </p>
              </div>
              <ShieldCheck className="h-5 w-5 shrink-0 text-primary" />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => startSetup("change")} className="flex-1">
                Change method
              </Button>
              <Button
                variant="outline"
                onClick={() => startSetup("disable")}
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
              >
                Disable
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-start justify-between gap-3 rounded-lg border border-destructive/25 bg-destructive/5 p-3 sm:flex-row sm:items-center">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
                <AlertCircle className="h-5 w-5 text-destructive" />
              </div>
              <div>
                <p className="font-medium text-foreground">2FA required</p>
                <p className="text-sm text-muted-foreground">
                  Two-factor authentication is required for admin accounts
                </p>
              </div>
            </div>
            <Button onClick={() => startSetup("enable")} className="min-h-10 shrink-0">
              Enable 2FA
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
