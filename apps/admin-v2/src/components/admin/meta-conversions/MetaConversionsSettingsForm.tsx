import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Info,
  Loader2,
  Eye,
  EyeOff,
  Save,
  RotateCcw,
} from "lucide-react";
import { useMetaConversionsSettings } from "./hooks/useMetaConversionsSettings";
import type { MetaPixelParityDiagnostics } from "~/types/api-responses";
import { OfficialProviderMark } from "~/components/admin/settings/provider-marks";
import { UnsavedChangesGuard } from "~/components/admin/shared/UnsavedChangesGuard";
import { usePermissions } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";

// Local types replacing @scalius/database/schema imports
export interface MetaConversionsSettings {
  id: string;
  singletonKey: string;
  pixelId: string | null;
  accessToken: string | null;
  testEventCode: string | null;
  isEnabled: boolean;
  logRetentionDays: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface FormData {
  pixelId: string;
  accessToken: string;
  testEventCode: string;
  isEnabled: boolean;
  logRetentionDays: number;
}

interface MetaConversionsSettingsFormProps {
  initialSettings?: MetaConversionsSettings;
  initialPixelParity?: MetaPixelParityDiagnostics | null;
}

function getParityTitle(pixelParity: MetaPixelParityDiagnostics): string {
  switch (pixelParity.status) {
    case "ok":
      return "Browser Pixel matches CAPI";
    case "not_configured":
      return "Pixel match check is waiting";
    case "invalid_capi_pixel_id":
      return "CAPI Pixel ID looks invalid";
    case "no_browser_pixel":
      return "Browser Pixel is not active";
    case "unreadable_browser_pixel":
      return "Browser Pixel ID could not be read";
    case "multiple_browser_pixels":
      return "Multiple browser Pixels are active";
    case "unavailable":
      return "Pixel match check is unavailable";
    case "mismatch":
      return "Browser Pixel does not match CAPI";
  }
}

function getParityClassName(pixelParity: MetaPixelParityDiagnostics): string {
  if (pixelParity.severity === "success") {
    return "border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100 [&_[data-slot=alert-description]]:text-emerald-800 dark:[&_[data-slot=alert-description]]:text-emerald-200";
  }

  if (pixelParity.severity === "warning") {
    return "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100 [&_[data-slot=alert-description]]:text-amber-800 dark:[&_[data-slot=alert-description]]:text-amber-200";
  }

  return "bg-muted/40";
}

function MetaPixelParityPanel({
  pixelParity,
}: {
  pixelParity: MetaPixelParityDiagnostics | null;
}) {
  if (!pixelParity) {
    return null;
  }

  const Icon =
    pixelParity.severity === "success"
      ? CheckCircle2
      : pixelParity.severity === "warning"
        ? AlertTriangle
        : Info;
  const hasBrowserPixelIds = pixelParity.activeBrowserPixelIds.length > 0;

  return (
    <Alert className={getParityClassName(pixelParity)}>
      <Icon className="h-4 w-4" />
      <AlertTitle>{getParityTitle(pixelParity)}</AlertTitle>
      <AlertDescription>
        <p>{pixelParity.message}</p>
        <div className="flex flex-wrap gap-2 text-xs">
          {pixelParity.capiPixelId ? (
            <span className="rounded-md bg-background/70 px-2 py-1 font-mono">
              CAPI {pixelParity.capiPixelId}
            </span>
          ) : null}
          {hasBrowserPixelIds ? (
            <span className="rounded-md bg-background/70 px-2 py-1 font-mono">
              Browser {pixelParity.activeBrowserPixelIds.join(", ")}
            </span>
          ) : (
            <span className="rounded-md bg-background/70 px-2 py-1">
              Active Pixel scripts {pixelParity.activeFacebookPixelScriptCount}
            </span>
          )}
        </div>
        {pixelParity.status !== "ok" ? (
          <Button asChild variant="outline" size="sm" className="mt-2 min-h-11 sm:min-h-9">
            <Link
              to="/admin/analytics"
              search={{
                page: 1,
                limit: 20,
                search: "",
                sort: "updatedAt",
                order: "desc",
                trashed: false,
                type: undefined,
                status: undefined,
              }}
            >
              Review browser Pixel
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

export function MetaConversionsSettingsForm({
  initialSettings,
  initialPixelParity,
}: MetaConversionsSettingsFormProps) {
  const {
    formData,
    isSettingsLoading,
    showAccessToken,
    setShowAccessToken,
    hasUnsavedChanges,
    settingsIssue,
    enableIssue,
    pixelParity,
    handleSaveSettings,
    handleResetForm,
    updateFormData,
  } = useMetaConversionsSettings(initialSettings, initialPixelParity);
  const { hasPermission } = usePermissions();
  const canEdit = hasPermission(ADMIN_PERMISSIONS.ANALYTICS_EDIT);
  const setupComplete = Boolean(
    formData.pixelId.trim() && formData.accessToken.trim() && !settingsIssue,
  );

  return (
    <>
      <UnsavedChangesGuard
        isDirty={hasUnsavedChanges}
        isSubmitting={isSettingsLoading}
      />
      <Card className="shadow-none">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <OfficialProviderMark provider="meta" />
            Server events
          </CardTitle>
          <CardDescription>
            Send supported storefront and purchase events to Meta.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="rounded-md border bg-muted/20 px-3 py-2">
              <dt className="text-xs text-muted-foreground">Setup</dt>
              <dd className="mt-1 text-sm font-medium">
                {setupComplete ? "Credentials saved" : "Setup required"}
              </dd>
            </div>
            <div className="rounded-md border bg-muted/20 px-3 py-2">
              <dt className="text-xs text-muted-foreground">Server events</dt>
              <dd className="mt-1 text-sm font-medium">
                {formData.isEnabled ? "Active" : "Inactive"}
              </dd>
            </div>
            <div className="rounded-md border bg-muted/20 px-3 py-2">
              <dt className="text-xs text-muted-foreground">Browser Pixel</dt>
              <dd className="mt-1 text-sm font-medium">
                {pixelParity?.status === "ok"
                  ? "Matched"
                  : pixelParity
                    ? "Needs review"
                    : "Unavailable"}
              </dd>
            </div>
          </dl>

          {!canEdit ? (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertTitle>Read-only access</AlertTitle>
              <AlertDescription>
                You can review settings and delivery activity, but you cannot
                change the integration.
              </AlertDescription>
            </Alert>
          ) : null}

        <form
          method="post"
          onSubmit={(e) => {
            e.preventDefault();
            handleSaveSettings();
          }}
          noValidate
        >
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="pixelId">Pixel ID</Label>
                <Input
                  id="pixelId"
                  placeholder="Enter your Meta Pixel ID"
                  value={formData.pixelId}
                  disabled={!canEdit || isSettingsLoading}
                  className="min-h-11 sm:min-h-9"
                  onChange={(e) => updateFormData("pixelId", e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="testEventCode">
                  Test event code (optional)
                </Label>
                <Input
                  id="testEventCode"
                  placeholder="Enter test event code"
                  value={formData.testEventCode}
                  disabled={!canEdit || isSettingsLoading}
                  className="min-h-11 sm:min-h-9"
                  onChange={(e) => updateFormData("testEventCode", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  New events appear in Meta Test Events until this code is removed.
                </p>
              </div>
            </div>

            <MetaPixelParityPanel pixelParity={pixelParity} />

            <div className="space-y-2">
              <Label htmlFor="accessToken">Access token</Label>
              <div className="relative">
                <Input
                  id="accessToken"
                  type={showAccessToken ? "text" : "password"}
                  placeholder="Enter your Meta Conversions API access token"
                  value={formData.accessToken}
                  disabled={!canEdit || isSettingsLoading}
                  onChange={(e) => updateFormData("accessToken", e.target.value)}
                  className="min-h-11 pr-11 sm:min-h-9"
                  autoComplete="off"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full px-3 py-2"
                  aria-label={showAccessToken ? "Hide access token" : "Show access token"}
                  disabled={!canEdit || isSettingsLoading}
                  onClick={() => setShowAccessToken(!showAccessToken)}
                >
                  {showAccessToken ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Stored encrypted. The saved token is never shown again.
              </p>
            </div>

            {settingsIssue || enableIssue ? (
              <Alert
                className={
                  settingsIssue
                    ? "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100 [&_[data-slot=alert-description]]:text-amber-800 dark:[&_[data-slot=alert-description]]:text-amber-200"
                    : "bg-muted/40"
                }
              >
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>
                  {settingsIssue
                    ? "Meta CAPI settings need attention"
                    : "Meta CAPI is not ready to enable"}
                </AlertTitle>
                <AlertDescription>
                  {settingsIssue ??
                    "Add a Meta Pixel ID and access token before enabling server events. Use Events Manager test events with a test event code to verify delivery."}
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="logRetentionDays">
                  Keep delivery logs (days)
                </Label>
                <Input
                  id="logRetentionDays"
                  type="number"
                  min="1"
                  max="365"
                  value={formData.logRetentionDays}
                  disabled={!canEdit || isSettingsLoading}
                  className="min-h-11 sm:min-h-9"
                  onChange={(e) =>
                    updateFormData(
                      "logRetentionDays",
                      parseInt(e.target.value) || 30,
                    )
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Events older than this many days are removed by scheduled cleanup.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="isEnabled">Send server events</Label>
                <div className="flex min-h-11 items-center justify-between gap-3 rounded-md border px-3 py-2 sm:min-h-9">
                  <span className="text-sm text-muted-foreground">
                    {formData.isEnabled
                      ? "Supported events are sent to Meta"
                      : enableIssue
                        ? "Complete setup before enabling"
                        : "Server delivery is off"}
                  </span>
                  <Switch
                    id="isEnabled"
                    checked={formData.isEnabled}
                    disabled={!canEdit || isSettingsLoading}
                    onCheckedChange={(checked) =>
                      updateFormData("isEnabled", checked)
                    }
                  />
                </div>
              </div>
            </div>

            <Alert className="bg-muted/30">
              <Info className="h-4 w-4" />
              <AlertTitle>Delivery is verified separately</AlertTitle>
              <AlertDescription>
                Saving does not test Meta delivery. Review provider results in
                Delivery activity.
              </AlertDescription>
            </Alert>

            {canEdit ? (
              <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center">
                <Button
                  type="submit"
                  disabled={isSettingsLoading || !hasUnsavedChanges || Boolean(settingsIssue)}
                  className="min-h-11 gap-2 sm:min-h-9"
                >
                  {isSettingsLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  Save changes
                </Button>
                {hasUnsavedChanges ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleResetForm}
                    className="min-h-11 gap-2 sm:min-h-9"
                  >
                    <RotateCcw className="h-4 w-4" />
                    Reset
                  </Button>
                ) : null}
                <span className="text-xs text-muted-foreground" aria-live="polite">
                  {hasUnsavedChanges ? "Unsaved changes" : "Settings are up to date"}
                </span>
              </div>
            ) : null}
          </div>
        </form>
        </CardContent>
      </Card>
    </>
  );
}
