import { useState } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Loader2, AlertCircle, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { getServerFnError } from "~/lib/api-helpers";
import { changePassword } from "~/lib/api-functions/auth-management";
import { useHydrated } from "~/hooks/use-hydrated";
import { UnsavedChangesGuard } from "~/components/admin/shared/UnsavedChangesGuard";
import { FieldError, InlineHelp, SettingsSection } from "~/components/admin/shell";

function getPasswordStrength(password: string) {
  if (!password) return { strength: 0, label: "", tone: "bg-muted" };
  let strength = 0;
  if (password.length >= 8) strength++;
  if (password.length >= 12) strength++;
  if (/[A-Z]/.test(password)) strength++;
  if (/[0-9]/.test(password)) strength++;
  if (/[^A-Za-z0-9]/.test(password)) strength++;

  if (strength <= 2) return { strength, label: "Weak", tone: "bg-destructive" };
  if (strength <= 3) return { strength, label: "Fair", tone: "bg-foreground/55" };
  if (strength <= 4) return { strength, label: "Good", tone: "bg-foreground/75" };
  return { strength, label: "Strong", tone: "bg-primary" };
}

export function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const isHydrated = useHydrated();

  const passwordStrength = getPasswordStrength(newPassword);
  const mismatch = Boolean(confirmPassword) && newPassword !== confirmPassword;

  const handleSubmit = async (e: React.SyntheticEvent) => {
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
      await changePassword({ data: { currentPassword, newPassword } });
      toast.success("Password updated");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setShowCurrentPassword(false);
      setShowNewPassword(false);
      setShowConfirmPassword(false);
    } catch (err) {
      setError(getServerFnError(err, "Failed to change password"));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <UnsavedChangesGuard
        isDirty={Boolean(currentPassword || newPassword || confirmPassword)}
        isSubmitting={isLoading}
      />
      <SettingsSection
        title="Password"
        description="Changing the password signs this account out of nothing else; two-factor authentication still applies at the next sign-in."
      >
        <form
          method="post"
          action="/admin/settings/account"
          onSubmit={handleSubmit}
          className="space-y-4"
          noValidate
        >
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="currentPassword">Current password</Label>
            <div className="relative">
              <Input
                id="currentPassword"
                type={showCurrentPassword ? "text" : "password"}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                autoComplete="current-password"
                disabled={!isHydrated || isLoading}
                className="min-h-11 pr-11 sm:min-h-9"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-0 top-0 h-full min-w-11 px-3 hover:bg-transparent sm:min-w-9"
                onClick={() => setShowCurrentPassword((s) => !s)}
                aria-label={showCurrentPassword ? "Hide current password" : "Show current password"}
              >
                {showCurrentPassword ? (
                  <EyeOff className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <Eye className="h-4 w-4 text-muted-foreground" />
                )}
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="newPassword">New password</Label>
            <div className="relative">
              <Input
                id="newPassword"
                type={showNewPassword ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                autoComplete="new-password"
                disabled={!isHydrated || isLoading}
                minLength={12}
                aria-describedby="newPassword-help"
                className="min-h-11 pr-11 sm:min-h-9"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-0 top-0 h-full min-w-11 px-3 hover:bg-transparent sm:min-w-9"
                onClick={() => setShowNewPassword((s) => !s)}
                aria-label={showNewPassword ? "Hide new password" : "Show new password"}
              >
                {showNewPassword ? (
                  <EyeOff className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <Eye className="h-4 w-4 text-muted-foreground" />
                )}
              </Button>
            </div>
            {newPassword ? (
              <div className="space-y-1.5">
                <div
                  className="flex gap-1"
                  role="progressbar"
                  aria-label={`Password strength: ${passwordStrength.label}`}
                  aria-valuemin={0}
                  aria-valuemax={5}
                  aria-valuenow={passwordStrength.strength}
                >
                  {[1, 2, 3, 4, 5].map((i) => (
                    <div
                      key={i}
                      className={`h-1 flex-1 rounded-full transition-colors ${i <= passwordStrength.strength
                        ? passwordStrength.tone
                        : "bg-muted"
                        }`}
                    />
                  ))}
                </div>
                <InlineHelp id="newPassword-help">
                  Password strength: {passwordStrength.label}
                </InlineHelp>
              </div>
            ) : (
              <InlineHelp id="newPassword-help">
                Use at least 12 characters. Longer passphrases beat added symbols.
              </InlineHelp>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="confirmPassword">Confirm new password</Label>
            <div className="relative">
              <Input
                id="confirmPassword"
                type={showConfirmPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                autoComplete="new-password"
                disabled={!isHydrated || isLoading}
                minLength={12}
                aria-invalid={mismatch}
                aria-describedby="confirmPassword-help"
                className="min-h-11 pr-11 sm:min-h-9"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-0 top-0 h-full min-w-11 px-3 hover:bg-transparent sm:min-w-9"
                onClick={() => setShowConfirmPassword((shown) => !shown)}
                aria-label={showConfirmPassword ? "Hide confirmed password" : "Show confirmed password"}
              >
                {showConfirmPassword ? (
                  <EyeOff className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <Eye className="h-4 w-4 text-muted-foreground" />
                )}
              </Button>
            </div>
            <FieldError id="confirmPassword-help">
              {mismatch ? "Passwords do not match" : null}
            </FieldError>
          </div>

          <Button
            type="submit"
            disabled={
              !isHydrated ||
              isLoading ||
              !currentPassword ||
              !newPassword ||
              newPassword !== confirmPassword
            }
            className="min-h-11 w-full sm:min-h-9 sm:w-auto"
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Updating…
              </>
            ) : (
              "Update password"
            )}
          </Button>
        </form>
      </SettingsSection>
    </>
  );
}
