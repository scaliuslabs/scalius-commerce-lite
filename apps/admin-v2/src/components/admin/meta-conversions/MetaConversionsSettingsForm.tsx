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
  Settings,
  Loader2,
  Eye,
  EyeOff,
  Save,
  RotateCcw,
} from "lucide-react";
import { useMetaConversionsSettings } from "./hooks/useMetaConversionsSettings";
import type { RetentionInfo } from "./hooks/useMetaConversionsLogs";
import type { MetaPixelParityDiagnostics } from "~/types/api-responses";

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
  retentionInfo: RetentionInfo | null;
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
          <Button asChild variant="outline" size="sm" className="mt-2">
            <Link to="/admin/analytics">
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
  retentionInfo,
}: MetaConversionsSettingsFormProps) {
  const {
    formData,
    isSettingsLoading,
    showAccessToken,
    setShowAccessToken,
    hasUnsavedChanges,
    pixelParity,
    handleSaveSettings,
    handleResetForm,
    updateFormData,
  } = useMetaConversionsSettings(initialSettings, initialPixelParity);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Settings className="w-5 h-5" />
          Meta Conversions API Configuration
        </CardTitle>
        <CardDescription>
          Configure your Meta (Facebook) Conversions API settings to track
          events and conversions. These settings are used to send
          server-side events to Meta for better tracking and attribution.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <form
          method="post"
          onSubmit={(e) => {
            e.preventDefault();
            handleSaveSettings();
          }}
          noValidate
        >
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label htmlFor="pixelId">Pixel ID</Label>
                <Input
                  id="pixelId"
                  placeholder="Enter your Meta Pixel ID"
                  value={formData.pixelId}
                  onChange={(e) => updateFormData("pixelId", e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="testEventCode">
                  Test Event Code (Optional)
                </Label>
                <Input
                  id="testEventCode"
                  placeholder="Enter test event code"
                  value={formData.testEventCode}
                  onChange={(e) => updateFormData("testEventCode", e.target.value)}
                />
              </div>
            </div>

            <MetaPixelParityPanel pixelParity={pixelParity} />

            <div className="space-y-2">
              <Label htmlFor="accessToken">Access Token</Label>
              <div className="relative">
                <Input
                  id="accessToken"
                  type={showAccessToken ? "text" : "password"}
                  placeholder="Enter your Meta Conversions API access token"
                  value={formData.accessToken}
                  onChange={(e) => updateFormData("accessToken", e.target.value)}
                  className="pr-10"
                  autoComplete="off"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full px-3 py-2"
                  onClick={() => setShowAccessToken(!showAccessToken)}
                >
                  {showAccessToken ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                This token is sensitive and will be encrypted when stored.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label htmlFor="logRetentionDays">
                  Log Retention (Days)
                </Label>
                <Input
                  id="logRetentionDays"
                  type="number"
                  min="1"
                  max="365"
                  value={formData.logRetentionDays}
                  onChange={(e) =>
                    updateFormData(
                      "logRetentionDays",
                      parseInt(e.target.value) || 30,
                    )
                  }
                />
                <p className="text-sm text-muted-foreground">
                  Dashboard setting only. Actual cleanup happens every{" "}
                  {retentionInfo?.hours || 12} hours automatically.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="isEnabled">
                  Enable Meta Conversions API
                </Label>
                <div className="flex items-center space-x-2">
                  <Switch
                    id="isEnabled"
                    checked={formData.isEnabled}
                    onCheckedChange={(checked) =>
                      updateFormData("isEnabled", checked)
                    }
                  />
                  <span className="text-sm text-muted-foreground">
                    {formData.isEnabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 pt-4">
              <Button
                type="submit"
                disabled={isSettingsLoading || !hasUnsavedChanges}
                className="flex items-center gap-2"
              >
                {isSettingsLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                Save Settings
              </Button>
              {hasUnsavedChanges && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleResetForm}
                  className="flex items-center gap-2"
                >
                  <RotateCcw className="w-4 h-4" />
                  Reset
                </Button>
              )}
            </div>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
