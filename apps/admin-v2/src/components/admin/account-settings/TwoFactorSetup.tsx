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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
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

      setIsEnabled(true);
      setCurrentMethod(selectedMethod);
      if (backupCodes.length > 0) {
        setStep("backup");
      } else {
        setShowSetup(false);
        setStep("method");
        setPassword("");
        setVerificationCode("");
      }
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

  const handleSetupEmailForChange = async () => {
    setError(null);
    setIsLoading(true);

    try {
      const passwordResult = await authClient.twoFactor.enable({ password });
      if (passwordResult.error) {
        setError(passwordResult.error.message || "Password confirmation failed");
        return;
      }
      setBackupCodes(passwordResult.data?.backupCodes || []);

      const otpResult = await authClient.twoFactor.sendOtp();
      if (otpResult?.error) {
        setError(otpResult.error.message || "Failed to send verification code");
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

  const copyBackupCodes = async () => {
    try {
      await navigator.clipboard.writeText(backupCodes.join("\n"));
      toast.success("Recovery codes copied");
    } catch {
      toast.error("Could not copy recovery codes");
    }
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
              ? "Confirm your password before changing this security requirement."
              : setupMode === "change"
                ? "Verify a replacement method before the current method changes."
                : "Choose and verify the method used when you sign in."}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {error && (
            <div role="alert" className="mb-4 flex items-center gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {step === "method" && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="group" aria-label="Verification method">
                <button
                  type="button"
                  onClick={() => setSelectedMethod("totp")}
                  aria-pressed={selectedMethod === "totp"}
                  className={`min-h-16 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selectedMethod === "totp"
                    ? "border-foreground bg-muted/55"
                    : "hover:border-muted-foreground/40 hover:bg-muted/30"
                    }`}
                >
                  <div className="flex items-center gap-3">
                    <Smartphone className="h-5 w-5 shrink-0 text-muted-foreground" />
                    <div>
                      <p className="font-medium">Authenticator app</p>
                      <p className="text-xs text-muted-foreground">Time-based code; works offline</p>
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedMethod("email")}
                  aria-pressed={selectedMethod === "email"}
                  className={`min-h-16 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selectedMethod === "email"
                    ? "border-foreground bg-muted/55"
                    : "hover:border-muted-foreground/40 hover:bg-muted/30"
                    }`}
                >
                  <div className="flex items-center gap-3">
                    <Mail className="h-5 w-5 shrink-0 text-muted-foreground" />
                    <div>
                      <p className="font-medium">Email code</p>
                      <p className="break-all text-xs text-muted-foreground">Sent to {user.email}</p>
                    </div>
                  </div>
                </button>
              </div>
              <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
                <Button
                  onClick={() => {
                    setStep("password");
                  }}
                  disabled={isLoading}
                  className="min-h-11 sm:order-2 sm:min-h-9 sm:flex-none"
                >
                  {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Continue
                </Button>
                <Button
                  variant="outline"
                  onClick={() => { setShowSetup(false); resetState(); }}
                  disabled={isLoading}
                  className="min-h-11 sm:min-h-9"
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
                  className="min-h-11 sm:min-h-9"
                  autoFocus
                />
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                {setupMode === "disable" ? (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        type="button"
                        disabled={isLoading || !password}
                        variant="destructive"
                        className="min-h-11 sm:order-2 sm:min-h-9 sm:flex-none"
                      >
                        Turn off two-factor
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent className="max-w-sm">
                      <AlertDialogHeader>
                        <AlertDialogTitle>Turn off two-factor authentication?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This account will return to setup required. Admin access may be restricted until a method is verified again.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel className="min-h-11 sm:min-h-9">Keep enabled</AlertDialogCancel>
                        <AlertDialogAction
                          className="min-h-11 bg-destructive text-destructive-foreground hover:bg-destructive/90 sm:min-h-9"
                          onClick={() => void handleDisable2FA()}
                        >
                          Turn off two-factor
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                ) : (
                  <Button
                    onClick={() => {
                      if (setupMode === "change" && selectedMethod === "totp") {
                        handleSetupTotpForChange();
                      } else if (setupMode === "change") {
                        handleSetupEmailForChange();
                      } else {
                        handleEnable2FA();
                      }
                    }}
                    disabled={isLoading || !password}
                    className="min-h-11 sm:order-2 sm:min-h-9 sm:flex-none"
                  >
                    {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Continue
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={() => {
                    if (setupMode === "enable" || setupMode === "change") setStep("method");
                    else { setShowSetup(false); resetState(); }
                  }}
                  disabled={isLoading}
                  className="min-h-11 sm:min-h-9"
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
              <Button onClick={() => setStep("verify")} className="min-h-11 w-full sm:min-h-9">
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
                  className="min-h-11 sm:order-2 sm:min-h-9 sm:flex-none"
                >
                  {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Verify
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setStep(selectedMethod === "totp" ? "qr" : "password")}
                  className="min-h-11 sm:min-h-9"
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
                  className="min-h-11 w-full text-sm sm:min-h-9"
                >
                  Didn't receive the code? Resend
                </Button>
              )}
            </div>
          )}

          {step === "backup" && backupCodes.length > 0 && (
            <div className="space-y-4">
              <div role="status" className="flex items-center gap-2 rounded-lg border bg-muted/30 p-3 text-sm text-foreground">
                <Check className="h-4 w-4 flex-shrink-0" />
                <span>Two-factor authentication is enabled.</span>
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>Recovery codes</Label>
                  <Button variant="ghost" size="sm" className="min-h-11 sm:min-h-9" onClick={() => void copyBackupCodes()}>
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
              <Button onClick={() => { setShowSetup(false); resetState(); }} className="min-h-11 w-full sm:min-h-9">
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
            ? "A verified second step is required when this account signs in."
            : "Admin accounts must verify a second sign-in method."}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {isEnabled ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-background">
                {currentMethod === "totp" ? (
                  <Smartphone className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <Mail className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-foreground">
                  {currentMethod === "totp" ? "Authenticator app" : "Email verification"}
                </p>
                <p className="break-words text-sm text-muted-foreground">
                  {currentMethod === "totp"
                    ? "Time-based codes from an authenticator app"
                    : `Codes sent to ${user.email}`}
                </p>
              </div>
              <span className="shrink-0 text-xs font-medium text-muted-foreground">On</span>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button variant="outline" onClick={() => startSetup("change")} className="min-h-11 flex-1 sm:min-h-9">
                Change method
              </Button>
              <Button
                variant="outline"
                onClick={() => startSetup("disable")}
                className="min-h-11 text-destructive hover:bg-destructive/10 hover:text-destructive sm:min-h-9"
              >
                Turn off
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-start justify-between gap-3 rounded-lg border border-destructive/25 bg-destructive/5 p-3 sm:flex-row sm:items-center">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-destructive/25 bg-background">
                <AlertCircle className="h-4 w-4 text-destructive" />
              </div>
              <div>
                <p className="font-medium text-foreground">Setup required</p>
                <p className="text-sm text-muted-foreground">
                  Verify a method before this account is considered ready.
                </p>
              </div>
            </div>
            <Button onClick={() => startSetup("enable")} className="min-h-11 shrink-0 sm:min-h-9">
              Set up two-factor
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
