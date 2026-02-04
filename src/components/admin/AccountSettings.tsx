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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
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
  User,
  KeyRound,
  Eye,
  EyeOff,
  ShieldPlus,
} from "lucide-react";
import { toast } from "sonner";
import { MediaManager, type MediaFile } from "./MediaManager";
import { RolesManagement } from "./RolesManagement";
import { PermissionGate } from "./PermissionGate";
import { usePermissions } from "@/contexts/PermissionContext";
import { PERMISSIONS } from "@/lib/rbac/permissions";

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
  const { hasPermission } = usePermissions();
  const canManageRoles = hasPermission(PERMISSIONS.TEAM_MANAGE_ROLES);

  return (
    <div className="space-y-6">
      {/* Profile Header Card */}
      <ProfileHeaderCard user={user} />

      {/* Tabbed Settings */}
      <Tabs defaultValue="security" className="space-y-6">
        <TabsList className={`grid w-full ${canManageRoles ? "grid-cols-4" : "grid-cols-3"}`}>
          <TabsTrigger value="security" className="flex items-center gap-2">
            <Shield className="h-4 w-4" />
            <span className="hidden sm:inline">Security</span>
          </TabsTrigger>
          <TabsTrigger value="password" className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            <span className="hidden sm:inline">Password</span>
          </TabsTrigger>
          <TabsTrigger value="team" className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            <span className="hidden sm:inline">Team</span>
          </TabsTrigger>
          {canManageRoles && (
            <TabsTrigger value="roles" className="flex items-center gap-2">
              <ShieldPlus className="h-4 w-4" />
              <span className="hidden sm:inline">Roles</span>
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="security" className="space-y-6">
          <TwoFactorSection user={user} />
        </TabsContent>

        <TabsContent value="password" className="space-y-6">
          <ChangePasswordSection />
        </TabsContent>

        <TabsContent value="team" className="space-y-6">
          <AdminUsersSection currentUserId={user.id} />
        </TabsContent>

        {canManageRoles && (
          <TabsContent value="roles" className="space-y-6">
            <RolesManagement />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

// Profile Header Card - Prominent display of user info
function ProfileHeaderCard({ user }: { user: User }) {
  const [name, setName] = useState(user.name);
  const [image, setImage] = useState(user.image || "");
  const [isLoading, setIsLoading] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  const getInitials = (nameStr: string) => {
    return nameStr
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  const handleImageSelect = (file: MediaFile) => {
    setImage(file.url);
    setIsEditing(true);
  };

  const removeImage = () => {
    setImage("");
    setIsEditing(true);
  };

  const handleSave = async () => {
    if (name.trim().length < 2) {
      toast.error("Name must be at least 2 characters");
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch("/api/auth/update-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          image: image || null,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        toast.error(result.error || "Failed to update profile");
        return;
      }

      toast.success("Profile updated successfully");
      setIsEditing(false);
      // Reload to refresh header
      window.location.reload();
    } catch {
      toast.error("An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = () => {
    setName(user.name);
    setImage(user.image || "");
    setIsEditing(false);
  };

  const hasChanges = name !== user.name || image !== (user.image || "");

  return (
    <Card className="overflow-hidden">
      <div className="bg-gradient-to-r from-primary/10 via-primary/5 to-transparent h-24" />
      <CardContent className="relative pt-0 pb-6">
        <div className="flex flex-col sm:flex-row gap-6 items-start sm:items-end -mt-12">
          {/* Avatar */}
          <div className="relative group">
            <div className="h-24 w-24 rounded-full border-4 border-background bg-muted shadow-lg overflow-hidden">
              {image ? (
                <img
                  src={image}
                  alt={name}
                  className="h-full w-full object-cover"
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <div className="h-full w-full flex items-center justify-center bg-primary/10">
                  <span className="text-2xl font-semibold text-primary">
                    {getInitials(name)}
                  </span>
                </div>
              )}
            </div>
            {image && (
              <Button
                type="button"
                variant="destructive"
                size="icon"
                className="absolute -bottom-1 -right-1 h-7 w-7 rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={removeImage}
                title="Remove photo"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>

          {/* User Info */}
          <div className="flex-1 space-y-4 pt-2 sm:pt-0">
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="flex-1 space-y-1">
                {isEditing ? (
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="text-lg font-semibold h-auto py-1 px-2 -ml-2"
                    placeholder="Your name"
                  />
                ) : (
                  <h2 className="text-xl font-semibold">{name}</h2>
                )}
                <p className="text-sm text-muted-foreground">{user.email}</p>
              </div>

              <div className="flex items-center gap-2">
                {user.role === "admin" && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium bg-primary/10 text-primary px-2.5 py-1 rounded-full">
                    <Shield className="h-3 w-3" />
                    Admin
                  </span>
                )}
                {user.twoFactorEnabled && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 px-2.5 py-1 rounded-full">
                    <ShieldCheck className="h-3 w-3" />
                    2FA
                  </span>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2">
              <MediaManager
                onSelect={handleImageSelect}
                triggerLabel={image ? "Change Photo" : "Add Photo"}
              />
              {!isEditing && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsEditing(true)}
                >
                  Edit Profile
                </Button>
              )}
              {isEditing && hasChanges && (
                <>
                  <Button size="sm" onClick={handleSave} disabled={isLoading}>
                    {isLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-1" />
                    ) : null}
                    Save
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCancel}
                    disabled={isLoading}
                  >
                    Cancel
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Change Password Section
function ChangePasswordSection() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);

  const getPasswordStrength = (password: string) => {
    if (!password) return { strength: 0, label: "", color: "" };
    let strength = 0;
    if (password.length >= 8) strength++;
    if (password.length >= 12) strength++;
    if (/[A-Z]/.test(password)) strength++;
    if (/[0-9]/.test(password)) strength++;
    if (/[^A-Za-z0-9]/.test(password)) strength++;

    if (strength <= 2) return { strength, label: "Weak", color: "bg-red-500" };
    if (strength <= 3) return { strength, label: "Fair", color: "bg-yellow-500" };
    if (strength <= 4) return { strength, label: "Good", color: "bg-blue-500" };
    return { strength, label: "Strong", color: "bg-green-500" };
  };

  const passwordStrength = getPasswordStrength(newPassword);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError("New passwords do not match");
      return;
    }

    if (newPassword.length < 12) {
      setError("Password must be at least 12 characters");
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
          <KeyRound className="h-5 w-5" />
          Change Password
        </CardTitle>
        <CardDescription>
          Choose a strong password with at least 12 characters
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
            <div className="relative">
              <Input
                id="currentPassword"
                type={showCurrentPassword ? "text" : "password"}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                disabled={isLoading}
                className="pr-10"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                onClick={() => setShowCurrentPassword(!showCurrentPassword)}
              >
                {showCurrentPassword ? (
                  <EyeOff className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <Eye className="h-4 w-4 text-muted-foreground" />
                )}
              </Button>
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label htmlFor="newPassword">New Password</Label>
            <div className="relative">
              <Input
                id="newPassword"
                type={showNewPassword ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                disabled={isLoading}
                minLength={12}
                className="pr-10"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                onClick={() => setShowNewPassword(!showNewPassword)}
              >
                {showNewPassword ? (
                  <EyeOff className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <Eye className="h-4 w-4 text-muted-foreground" />
                )}
              </Button>
            </div>
            {newPassword && (
              <div className="space-y-1.5">
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <div
                      key={i}
                      className={`h-1 flex-1 rounded-full transition-colors ${
                        i <= passwordStrength.strength
                          ? passwordStrength.color
                          : "bg-muted"
                      }`}
                    />
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Password strength: {passwordStrength.label}
                </p>
              </div>
            )}
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
              minLength={12}
            />
            {confirmPassword && newPassword !== confirmPassword && (
              <p className="text-xs text-destructive">Passwords do not match</p>
            )}
          </div>

          <Button
            type="submit"
            disabled={isLoading || !currentPassword || !newPassword || newPassword !== confirmPassword}
            className="w-full sm:w-auto"
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Updating...
              </>
            ) : (
              "Update Password"
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

  const handleVerify2FA = async () => {
    setError(null);
    setIsLoading(true);

    try {
      const result = selectedMethod === "totp"
        ? await authClient.twoFactor.verifyTotp({ code: verificationCode })
        : await authClient.twoFactor.verifyOtp({ code: verificationCode });

      if (result.error) {
        setError(result.error.message || "Invalid verification code");
        return;
      }

      await fetch("/api/auth/update-2fa-method", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: selectedMethod }),
      });

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
      const result = await authClient.twoFactor.verifyTotp({ code: verificationCode });

      if (result.error) {
        setError(result.error.message || "Invalid verification code");
        return;
      }

      await fetch("/api/auth/update-2fa-method", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "totp" }),
      });

      await fetch("/api/auth/mark-2fa-verified", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      setCurrentMethod("totp");
      setStep("backup");
      toast.success("Authenticator app configured successfully");
    } catch {
      setError("Verification failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handleChangeToEmail = async () => {
    setError(null);
    setIsLoading(true);

    try {
      await fetch("/api/auth/update-2fa-method", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "email" }),
      });

      setCurrentMethod("email");
      setShowSetup(false);
      resetState();
      toast.success("Verification method changed to Email");
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
      const result = await authClient.twoFactor.disable({ password });

      if (result.error) {
        setError(result.error.message || "Failed to disable 2FA");
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
                  className={`p-4 border rounded-xl text-left transition-all ${
                    selectedMethod === "totp"
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : "hover:bg-muted/50 hover:border-muted-foreground/20"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-12 h-12 rounded-full flex items-center justify-center ${
                      selectedMethod === "totp" ? "bg-primary/10" : "bg-muted"
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
                  className={`p-4 border rounded-xl text-left transition-all ${
                    selectedMethod === "email"
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : "hover:bg-muted/50 hover:border-muted-foreground/20"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-12 h-12 rounded-full flex items-center justify-center ${
                      selectedMethod === "email" ? "bg-primary/10" : "bg-muted"
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
                    <img
                      src={getQrCodeUrl(totpUri)}
                      alt="2FA QR Code"
                      className="w-48 h-48"
                    />
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
      if (response.ok) setAdminUsers(result.users);
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
        return;
      }

      toast.success("Admin user created. An email has been sent with login instructions.");
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

  const getInitials = (name: string) => {
    return name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Team Members
            </CardTitle>
            <CardDescription>
              Manage administrator access to your store
            </CardDescription>
          </div>
          <Button onClick={() => setShowAddForm(true)} disabled={showAddForm}>
            <UserPlus className="h-4 w-4 mr-2" />
            Add Member
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {showAddForm && (
          <form onSubmit={handleAddUser} className="mb-6 p-5 bg-muted/30 rounded-xl border space-y-4">
            <h4 className="font-medium">Invite New Admin</h4>
            {error && (
              <div className="flex items-center gap-2 p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="newUserName">Full Name</Label>
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
                <Label htmlFor="newUserEmail">Email Address</Label>
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
            <p className="text-xs text-muted-foreground">
              A temporary password will be sent to their email. They'll be required to set up 2FA on first login.
            </p>
            <div className="flex gap-2">
              <Button type="submit" disabled={isAdding}>
                {isAdding && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Send Invite
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => { setShowAddForm(false); setNewUserName(""); setNewUserEmail(""); setError(null); }}
                disabled={isAdding}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : adminUsers.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Users className="h-12 w-12 mx-auto mb-3 opacity-20" />
            <p>No team members found</p>
          </div>
        ) : (
          <div className="divide-y divide-border rounded-xl border overflow-hidden">
            {adminUsers.map((adminUser) => (
              <div
                key={adminUser.id}
                className="flex items-center justify-between p-4 hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden">
                    {adminUser.image ? (
                      <img src={adminUser.image} alt={adminUser.name} className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-sm font-medium text-primary">{getInitials(adminUser.name)}</span>
                    )}
                  </div>
                  <div>
                    <p className="font-medium flex items-center gap-2">
                      {adminUser.name}
                      {adminUser.id === currentUserId && (
                        <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                          You
                        </span>
                      )}
                    </p>
                    <p className="text-sm text-muted-foreground">{adminUser.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {adminUser.twoFactorEnabled ? (
                    <span className="flex items-center gap-1 text-xs font-medium text-green-600 bg-green-50 dark:bg-green-900/30 dark:text-green-400 px-2 py-1 rounded-full">
                      <ShieldCheck className="h-3 w-3" />
                      2FA
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-xs font-medium text-amber-600 bg-amber-50 dark:bg-amber-900/30 dark:text-amber-400 px-2 py-1 rounded-full">
                      <AlertCircle className="h-3 w-3" />
                      No 2FA
                    </span>
                  )}
                  {adminUser.id !== currentUserId && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Remove Team Member</AlertDialogTitle>
                          <AlertDialogDescription>
                            Are you sure you want to remove <strong>{adminUser.name}</strong> from the team? They will lose access to the admin dashboard immediately.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => handleDeleteUser(adminUser.id)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            Remove
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
