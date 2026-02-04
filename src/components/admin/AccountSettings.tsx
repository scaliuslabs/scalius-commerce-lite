// src/components/admin/AccountSettings.tsx
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
} from "@/components/ui/alert-dialog";
import {
  Loader2,
  Lock,
  Shield,
  ShieldCheck,
  ShieldOff,
  UserPlus,
  Trash2,
  AlertCircle,
  Check,
  Copy,
  Users,
  Smartphone,
  Mail,
} from "lucide-react";
import { toast } from "sonner";

interface User {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  role?: string | null;
  twoFactorEnabled?: boolean | null;
  twoFactorMethod?: string | null;
}

interface AdminUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  twoFactorEnabled?: boolean | null;
  createdAt: string;
}

interface AccountSettingsProps {
  user: User;
}

export function AccountSettings({ user }: AccountSettingsProps) {
  return (
    <div className="space-y-6">
      <ChangePasswordSection />
      <TwoFactorSection user={user} />
      <AdminUsersSection currentUserId={user.id} />
    </div>
  );
}

// Change Password Section
function ChangePasswordSection() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError("New passwords do not match");
      return;
    }

    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters");
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      const result = await response.json();

      if (!response.ok) {
        setError(result.message || "Failed to change password");
        setIsLoading(false);
        return;
      }

      toast.success("Password changed successfully");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch {
      setError("An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lock className="h-5 w-5" />
          Change Password
        </CardTitle>
        <CardDescription>
          Update your password to keep your account secure
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="flex items-center gap-2 p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="currentPassword">Current Password</Label>
            <Input
              id="currentPassword"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              disabled={isLoading}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="newPassword">New Password</Label>
            <Input
              id="newPassword"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              disabled={isLoading}
              minLength={8}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirmPassword">Confirm New Password</Label>
            <Input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              disabled={isLoading}
              minLength={8}
            />
          </div>

          <Button type="submit" disabled={isLoading}>
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Changing Password...
              </>
            ) : (
              "Change Password"
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// Two-Factor Authentication Section
function TwoFactorSection({ user }: { user: User }) {
  const [isEnabled, setIsEnabled] = useState(user.twoFactorEnabled ?? false);
  const [currentMethod, setCurrentMethod] = useState<"totp" | "email">(
    (user.twoFactorMethod as "totp" | "email") || "email"
  );
  const [isLoading, setIsLoading] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [setupMode, setSetupMode] = useState<"enable" | "disable" | "change">("enable");
  const [selectedMethod, setSelectedMethod] = useState<"totp" | "email">("email");
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [verificationCode, setVerificationCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<"method" | "password" | "qr" | "verify" | "backup">("method");
  const [emailSent, setEmailSent] = useState(false);

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

        if (selectedMethod === "totp") {
          setStep("qr");
        } else {
          // For email method, send OTP
          await authClient.twoFactor.sendOtp();
          setEmailSent(true);
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
      let result;
      if (selectedMethod === "totp") {
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

      // Save the user's preferred 2FA method
      await fetch("/api/auth/update-2fa-method", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: selectedMethod }),
      });

      // Mark the session as 2FA-verified
      await fetch("/api/auth/mark-2fa-verified", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      setStep("backup");
      setIsEnabled(true);
      setCurrentMethod(selectedMethod);
      toast.success("Two-factor authentication enabled");
    } catch {
      setError("Verification failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handleChangeMethod = async () => {
    setError(null);
    setIsLoading(true);

    try {
      // Save the new method preference
      await fetch("/api/auth/update-2fa-method", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: selectedMethod }),
      });

      setCurrentMethod(selectedMethod);
      setShowSetup(false);
      resetState();
      toast.success(`Verification method changed to ${selectedMethod === "totp" ? "Authenticator App" : "Email"}`);
    } catch {
      setError("Failed to change method");
    } finally {
      setIsLoading(false);
    }
  };

  const handleDisable2FA = async () => {
    setError(null);
    setIsLoading(true);

    try {
      const result = await authClient.twoFactor.disable({
        password,
      });

      if (result.error) {
        setError(result.error.message || "Failed to disable 2FA");
        setIsLoading(false);
        return;
      }

      setIsEnabled(false);
      setShowSetup(false);
      resetState();
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

  const resetState = () => {
    setStep("method");
    setPassword("");
    setVerificationCode("");
    setTotpUri(null);
    setBackupCodes([]);
    setError(null);
    setEmailSent(false);
    setSelectedMethod(currentMethod);
  };

  const startSetup = (mode: "enable" | "disable" | "change") => {
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
              ? "Enter your password to disable 2FA"
              : setupMode === "change"
              ? "Choose your preferred verification method"
              : "Secure your account with two-factor authentication"}
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
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => setSelectedMethod("totp")}
                  className={`p-4 border rounded-lg text-left transition-colors ${
                    selectedMethod === "totp"
                      ? "border-primary bg-primary/5"
                      : "hover:bg-muted/50"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                      selectedMethod === "totp" ? "bg-primary/10" : "bg-muted"
                    }`}>
                      <Smartphone className={`h-5 w-5 ${selectedMethod === "totp" ? "text-primary" : ""}`} />
                    </div>
                    <div>
                      <p className="font-medium text-sm">Authenticator App</p>
                      <p className="text-xs text-muted-foreground">More secure</p>
                    </div>
                  </div>
                </button>
                <button
                  onClick={() => setSelectedMethod("email")}
                  className={`p-4 border rounded-lg text-left transition-colors ${
                    selectedMethod === "email"
                      ? "border-primary bg-primary/5"
                      : "hover:bg-muted/50"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                      selectedMethod === "email" ? "bg-primary/10" : "bg-muted"
                    }`}>
                      <Mail className={`h-5 w-5 ${selectedMethod === "email" ? "text-primary" : ""}`} />
                    </div>
                    <div>
                      <p className="font-medium text-sm">Email</p>
                      <p className="text-xs text-muted-foreground">More convenient</p>
                    </div>
                  </div>
                </button>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    if (setupMode === "change") {
                      handleChangeMethod();
                    } else {
                      setStep("password");
                    }
                  }}
                  disabled={isLoading}
                  className="flex-1"
                >
                  {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {setupMode === "change" ? "Save Changes" : "Continue"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowSetup(false);
                    resetState();
                  }}
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
                  onClick={setupMode === "disable" ? handleDisable2FA : handleEnable2FA}
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
                    if (setupMode === "enable") {
                      setStep("method");
                    } else {
                      setShowSetup(false);
                      resetState();
                    }
                  }}
                  disabled={isLoading}
                >
                  {setupMode === "enable" ? "Back" : "Cancel"}
                </Button>
              </div>
            </div>
          )}

          {step === "qr" && totpUri && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.)
              </p>
              <div className="flex justify-center">
                <img
                  src={getQrCodeUrl(totpUri)}
                  alt="2FA QR Code"
                  className="w-48 h-48 rounded-lg border bg-white p-2"
                />
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
                    : "Enter the code from your authenticator app"}
                </Label>
                <Input
                  id="verification-code"
                  type="text"
                  value={verificationCode}
                  onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="000000"
                  className="text-center text-xl tracking-[0.5em] font-mono"
                  maxLength={6}
                  disabled={isLoading}
                  autoFocus
                />
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={handleVerify2FA}
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
                  variant="ghost"
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
              <div className="flex items-center gap-2 p-3 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg">
                <Check className="h-4 w-4 flex-shrink-0" />
                <span>Two-factor authentication is now enabled!</span>
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
                  Save these backup codes in a safe place. You can use them to access your account if you lose your {selectedMethod === "totp" ? "authenticator" : "email access"}.
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
              <Button
                onClick={() => {
                  setShowSetup(false);
                  resetState();
                }}
                className="w-full"
              >
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
            ? "Your account is protected with two-factor authentication"
            : "Add an extra layer of security to your account"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isEnabled ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-900 rounded-lg">
              <div className="flex items-center gap-3">
                {currentMethod === "totp" ? (
                  <Smartphone className="h-5 w-5 text-green-600" />
                ) : (
                  <Mail className="h-5 w-5 text-green-600" />
                )}
                <div>
                  <p className="font-medium text-green-700 dark:text-green-400">
                    {currentMethod === "totp" ? "Authenticator App" : "Email Verification"}
                  </p>
                  <p className="text-sm text-green-600 dark:text-green-500">
                    {currentMethod === "totp"
                      ? "Using authenticator app for verification"
                      : `Verification codes sent to ${user.email}`}
                  </p>
                </div>
              </div>
              <ShieldCheck className="h-5 w-5 text-green-500" />
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => startSetup("change")}
                className="flex-1"
              >
                Change Method
              </Button>
              <Button
                variant="outline"
                onClick={() => startSetup("disable")}
                className="text-destructive hover:text-destructive"
              >
                Disable
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Status: <span className="text-muted-foreground">Disabled</span></p>
              <p className="text-sm text-muted-foreground">
                Two-factor authentication is required for admin accounts
              </p>
            </div>
            <Button onClick={() => startSetup("enable")}>
              Enable 2FA
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Admin Users Management Section
function AdminUsersSection({ currentUserId }: { currentUserId: string }) {
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newUserName, setNewUserName] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAdminUsers = async () => {
    try {
      const response = await fetch("/api/auth/admin-users");
      const result = await response.json();

      if (response.ok) {
        setAdminUsers(result.users);
      }
    } catch {
      console.error("Failed to fetch admin users");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchAdminUsers();
  }, []);

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsAdding(true);

    try {
      const response = await fetch("/api/auth/admin-users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newUserName, email: newUserEmail }),
      });

      const result = await response.json();

      if (!response.ok) {
        setError(result.message || "Failed to create admin user");
        setIsAdding(false);
        return;
      }

      toast.success("Admin user created successfully");
      setShowAddForm(false);
      setNewUserName("");
      setNewUserEmail("");
      fetchAdminUsers();
    } catch {
      setError("An unexpected error occurred");
    } finally {
      setIsAdding(false);
    }
  };

  const handleDeleteUser = async (userId: string) => {
    try {
      const response = await fetch(`/api/auth/admin-users?id=${userId}`, {
        method: "DELETE",
      });

      const result = await response.json();

      if (!response.ok) {
        toast.error(result.message || "Failed to delete admin user");
        return;
      }

      toast.success("Admin user deleted successfully");
      fetchAdminUsers();
    } catch {
      toast.error("An unexpected error occurred");
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Admin Users
            </CardTitle>
            <CardDescription>
              Manage administrator accounts for your store
            </CardDescription>
          </div>
          <Button onClick={() => setShowAddForm(true)} disabled={showAddForm}>
            <UserPlus className="h-4 w-4 mr-2" />
            Add Admin
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {showAddForm && (
          <form onSubmit={handleAddUser} className="mb-6 p-4 bg-muted/50 rounded-lg space-y-4">
            <h4 className="font-medium">Add New Admin User</h4>
            {error && (
              <div className="flex items-center gap-2 p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="newUserName">Name</Label>
                <Input
                  id="newUserName"
                  value={newUserName}
                  onChange={(e) => setNewUserName(e.target.value)}
                  placeholder="John Doe"
                  required
                  disabled={isAdding}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="newUserEmail">Email</Label>
                <Input
                  id="newUserEmail"
                  type="email"
                  value={newUserEmail}
                  onChange={(e) => setNewUserEmail(e.target.value)}
                  placeholder="john@example.com"
                  required
                  disabled={isAdding}
                />
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              A temporary password will be generated and sent to their email address.
            </p>
            <div className="flex gap-2">
              <Button type="submit" disabled={isAdding}>
                {isAdding ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Create Admin User
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setShowAddForm(false);
                  setNewUserName("");
                  setNewUserEmail("");
                  setError(null);
                }}
                disabled={isAdding}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : adminUsers.length === 0 ? (
          <p className="text-center text-muted-foreground py-8">
            No admin users found
          </p>
        ) : (
          <div className="space-y-3">
            {adminUsers.map((adminUser) => (
              <div
                key={adminUser.id}
                className="flex items-center justify-between p-4 bg-muted/30 rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                    <span className="text-sm font-medium">
                      {adminUser.name.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div>
                    <p className="font-medium">
                      {adminUser.name}
                      {adminUser.id === currentUserId && (
                        <span className="ml-2 text-xs bg-primary/10 text-primary px-2 py-0.5 rounded">
                          You
                        </span>
                      )}
                    </p>
                    <p className="text-sm text-muted-foreground">{adminUser.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {adminUser.twoFactorEnabled && (
                    <span className="flex items-center gap-1 text-xs text-green-600 bg-green-50 px-2 py-1 rounded">
                      <ShieldCheck className="h-3 w-3" />
                      2FA
                    </span>
                  )}
                  {adminUser.id !== currentUserId && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete Admin User</AlertDialogTitle>
                          <AlertDialogDescription>
                            Are you sure you want to delete {adminUser.name}? This action cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => handleDeleteUser(adminUser.id)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
