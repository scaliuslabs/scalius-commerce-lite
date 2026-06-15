import { useState, useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import QRCode from "qrcode";
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

  // Generate QR code locally as data URI
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (totpUri) {
      QRCode.toDataURL(totpUri, { width: 200, margin: 2 })
        .then(setQrDataUrl)
        .catch(() => setQrDataUrl(null));
    } else {
      setQrDataUrl(null);
    }
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
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            {setupMode === "disable"
              ? "Disable Two-Factor Authentication"
              : setupMode === "change"
                ? "Change Verification Method"
                : "Enable Two-Factor Authentication"}
          </CardTitle>
          <CardDescription>
            {setupMode === "disable"
              ? "Enter your password to confirm"
              : setupMode === "change"
                ? "Choose your preferred verification method"
                : "Add an extra layer of security to your account"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="flex items-center gap-2 p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg mb-4">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {step === "method" && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setSelectedMethod("totp")}
                  className={`p-4 border rounded-xl text-left transition-all ${selectedMethod === "totp"
                    ? "border-primary bg-primary/5 ring-1 ring-primary"
                    : "hover:bg-muted/50 hover:border-muted-foreground/20"
                    }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-12 h-12 rounded-full flex items-center justify-center ${selectedMethod === "totp" ? "bg-primary/10" : "bg-muted"
                      }`}>
                      <Smartphone className={`h-6 w-6 ${selectedMethod === "totp" ? "text-primary" : "text-muted-foreground"}`} />
                    </div>
                    <div>
                      <p className="font-medium">Authenticator App</p>
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
                  className={`p-4 border rounded-xl text-left transition-all ${selectedMethod === "email"
                    ? "border-primary bg-primary/5 ring-1 ring-primary"
                    : "hover:bg-muted/50 hover:border-muted-foreground/20"
                    }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-12 h-12 rounded-full flex items-center justify-center ${selectedMethod === "email" ? "bg-primary/10" : "bg-muted"
                      }`}>
                      <Mail className={`h-6 w-6 ${selectedMethod === "email" ? "text-primary" : "text-muted-foreground"}`} />
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
              <div className="flex gap-2 pt-2">
                <Button
                  onClick={() => {
                    if (setupMode === "change" && selectedMethod === "email") {
                      handleChangeToEmail();
                    } else {
                      setStep("password");
                    }
                  }}
                  disabled={isLoading}
                  className="flex-1"
                >
                  {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Continue
                </Button>
                <Button
                  variant="outline"
                  onClick={() => { setShowSetup(false); resetState(); }}
                  disabled={isLoading}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {step === "password" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="2fa-password">Confirm Your Password</Label>
                <Input
                  id="2fa-password"
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
                  onClick={() => {
                    if (setupMode === "disable") handleDisable2FA();
                    else if (setupMode === "change" && selectedMethod === "totp") handleSetupTotpForChange();
                    else handleEnable2FA();
                  }}
                  disabled={isLoading || !password}
                  variant={setupMode === "disable" ? "destructive" : "default"}
                  className="flex-1"
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
                  <div className="bg-white p-4 rounded-xl shadow-sm">
                    {qrDataUrl ? (
                      <img
                        src={qrDataUrl}
                        alt="2FA QR Code"
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
              <Button onClick={() => setStep("verify")} className="w-full">
                I've Scanned the Code
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
                  disabled={isLoading}
                  autoFocus
                />
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    if (setupMode === "change" && selectedMethod === "totp") handleVerifyTotpForChange();
                    else handleVerify2FA();
                  }}
                  disabled={isLoading || verificationCode.length !== 6}
                  className="flex-1"
                >
                  {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Verify
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setStep(selectedMethod === "totp" ? "qr" : "password")}
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
              <div className="flex items-center gap-2 p-3 text-sm text-green-700 bg-green-50 dark:bg-green-950/30 dark:text-green-400 border border-green-200 dark:border-green-900 rounded-lg">
                <Check className="h-4 w-4 flex-shrink-0" />
                <span>Two-factor authentication is now enabled!</span>
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>Recovery Codes</Label>
                  <Button variant="ghost" size="sm" onClick={copyBackupCodes}>
                    <Copy className="h-4 w-4 mr-1" />
                    Copy
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">
                  Save these codes securely. Each code can only be used once.
                </p>
                <div className="bg-muted/50 p-4 rounded-lg border">
                  <div className="grid grid-cols-2 gap-2 font-mono text-sm">
                    {backupCodes.map((code, index) => (
                      <div key={index} className="text-center py-1 bg-background rounded">
                        {code}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <Button onClick={() => { setShowSetup(false); resetState(); }} className="w-full">
                Done
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {isEnabled ? (
            <ShieldCheck className="h-5 w-5 text-green-500" />
          ) : (
            <ShieldOff className="h-5 w-5 text-muted-foreground" />
          )}
          Two-Factor Authentication
        </CardTitle>
        <CardDescription>
          {isEnabled
            ? "Your account is protected with an extra layer of security"
            : "Protect your account with two-factor authentication"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isEnabled ? (
          <div className="space-y-4">
            <div className="flex items-center gap-4 p-4 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-900 rounded-xl">
              <div className="w-12 h-12 rounded-full bg-green-100 dark:bg-green-900/50 flex items-center justify-center">
                {currentMethod === "totp" ? (
                  <Smartphone className="h-6 w-6 text-green-600 dark:text-green-400" />
                ) : (
                  <Mail className="h-6 w-6 text-green-600 dark:text-green-400" />
                )}
              </div>
              <div className="flex-1">
                <p className="font-medium text-green-700 dark:text-green-400">
                  {currentMethod === "totp" ? "Authenticator App" : "Email Verification"}
                </p>
                <p className="text-sm text-green-600 dark:text-green-500">
                  {currentMethod === "totp"
                    ? "Using authenticator app for verification"
                    : `Codes sent to ${user.email}`}
                </p>
              </div>
              <ShieldCheck className="h-6 w-6 text-green-500" />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => startSetup("change")} className="flex-1">
                Change Method
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
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-xl">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/50 flex items-center justify-center">
                <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              </div>
              <div>
                <p className="font-medium text-amber-700 dark:text-amber-400">2FA Required</p>
                <p className="text-sm text-amber-600 dark:text-amber-500">
                  Two-factor authentication is required for admin accounts
                </p>
              </div>
            </div>
            <Button onClick={() => startSetup("enable")} className="shrink-0">
              Enable 2FA
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
