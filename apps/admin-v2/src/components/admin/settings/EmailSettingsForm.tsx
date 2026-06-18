import React from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, Save, CheckCircle2, ExternalLink, Info, Cloud, KeyRound, Mail, Send } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { queryKeys } from "@/lib/query-keys";
import {
  getEmailSettings,
  type SettingsPayload,
  updateEmailSettings,
} from "@/lib/api-functions/settings";

const MASKED_VALUE = "••••••••••••";

interface EmailSettings {
  provider: "cloudflare" | "resend";
  apiKey: string;
  sender: string;
  cloudflareBindingConfigured: boolean;
  resendConfigured: boolean;
}

export default function EmailSettingsForm() {
  const { values, setValue, isLoading, isSaving, handleSubmit } = useSettingsForm<EmailSettings>({
    queryKey: queryKeys.settings.email(),
    fetchFn: () => getEmailSettings() as Promise<Partial<EmailSettings>>,
    saveFn: (v) => {
      const payload: SettingsPayload = {
        provider: v.provider,
        sender: v.sender,
      };
      if (v.apiKey !== MASKED_VALUE) {
        payload.apiKey = v.apiKey;
      }
      return updateEmailSettings({ data: payload });
    },
    defaultValues: {
      provider: "cloudflare",
      apiKey: "",
      sender: "",
      cloudflareBindingConfigured: false,
      resendConfigured: false,
    },
    successMessage: "Email settings saved successfully!",
    errorMessage: "Failed to save email settings",
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const provider = values.provider || "cloudflare";
  const apiKeyConfigured = values.resendConfigured || (!!values.apiKey && values.apiKey !== "");
  const providerConfigured =
    provider === "cloudflare"
      ? values.cloudflareBindingConfigured
      : apiKeyConfigured;
  const isConfigured = providerConfigured && !!values.sender;
  const providerLabel = provider === "cloudflare" ? "Cloudflare Email" : "Resend";

  return (
    <div className="space-y-5 max-w-2xl">
      <Card>
        <CardContent className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center">
          <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-md bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">
            {provider === "cloudflare" ? <Cloud className="h-6 w-6" /> : <Send className="h-6 w-6" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">Email Provider: {providerLabel}</h3>
              <Badge
                variant={isConfigured ? "default" : "secondary"}
                className={
                  isConfigured
                    ? "bg-green-600 hover:bg-green-600/80 text-white text-[10px] px-1.5 py-0"
                    : "text-[10px] px-1.5 py-0"
                }
              >
                {isConfigured ? "Configured" : "Not Configured"}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Transactional email delivery for verification, password reset, and 2FA codes.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Provider</CardTitle>
          <CardDescription>
            Cloudflare Email is the native default. Resend is available as a fallback.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              type="button"
              variant={provider === "cloudflare" ? "default" : "outline"}
              className="h-auto justify-start gap-3 py-3"
              aria-pressed={provider === "cloudflare"}
              onClick={() => setValue("provider", "cloudflare")}
            >
              <Cloud className="h-4 w-4" />
              <span className="flex flex-col items-start">
                <span>Cloudflare Email</span>
                <span className="text-xs font-normal opacity-80">
                  {values.cloudflareBindingConfigured ? "Binding ready" : "Binding missing"}
                </span>
              </span>
            </Button>
            <Button
              type="button"
              variant={provider === "resend" ? "default" : "outline"}
              className="h-auto justify-start gap-3 py-3"
              aria-pressed={provider === "resend"}
              onClick={() => setValue("provider", "resend")}
            >
              <Send className="h-4 w-4" />
              <span className="flex flex-col items-start">
                <span>Resend</span>
                <span className="text-xs font-normal opacity-80">
                  {apiKeyConfigured ? "API key saved" : "API key missing"}
                </span>
              </span>
            </Button>
          </div>
        </CardContent>
      </Card>

      {provider === "cloudflare" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Cloud className="h-4 w-4" />
              Cloudflare Binding
              {values.cloudflareBindingConfigured && (
                <CheckCircle2 className="h-4 w-4 text-green-500" />
              )}
            </CardTitle>
            <CardDescription>
              Uses the API/admin Worker `EMAIL` binding configured in Wrangler.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Alert>
              <AlertDescription className="text-sm">
                Domain onboarding lives in{" "}
                <a
                  href="https://dash.cloudflare.com/?to=/:account/workers-and-pages/email"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  Cloudflare Email Service <ExternalLink className="h-3 w-3" />
                </a>
                .
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      )}

      {provider === "resend" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <KeyRound className="h-4 w-4" />
              Resend API Key
              {apiKeyConfigured && (
                <CheckCircle2 className="h-4 w-4 text-green-500" />
              )}
            </CardTitle>
            <CardDescription>
              Used when Resend is selected or Cloudflare is unavailable.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Alert>
              <AlertDescription className="text-sm">
                Create a sending key at{" "}
                <a
                  href="https://resend.com/api-keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  resend.com/api-keys <ExternalLink className="h-3 w-3" />
                </a>
                .
              </AlertDescription>
            </Alert>
            <div className="space-y-1.5">
              <Label htmlFor="resend-api-key">API Key</Label>
              <Input
                id="resend-api-key"
                type="password"
                placeholder={apiKeyConfigured ? MASKED_VALUE : "re_xxxxxxxxxxxx"}
                value={values.apiKey}
                onChange={(e) => setValue("apiKey", e.target.value)}
                className="font-mono"
              />
              {apiKeyConfigured && values.apiKey === MASKED_VALUE && (
                <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" /> Configured. Type a new key
                  to replace.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Mail className="h-4 w-4" />
            Sender Email Address
          </CardTitle>
          <CardDescription>
            The "From" address on outgoing emails. It must be verified with the selected provider.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Alert>
            <AlertDescription className="text-sm">
              {provider === "cloudflare" ? "Onboard the sender domain in " : "Verify the sender domain at "}
              <a
                href={provider === "cloudflare" ? "https://dash.cloudflare.com/?to=/:account/workers-and-pages/email" : "https://resend.com/domains"}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                {provider === "cloudflare" ? "Cloudflare Email Service" : "resend.com/domains"} <ExternalLink className="h-3 w-3" />
              </a>
              .
            </AlertDescription>
          </Alert>
          <div className="space-y-1.5">
            <Label htmlFor="email-sender">Sender Address</Label>
            <Input
              id="email-sender"
              type="email"
              placeholder="noreply@yourdomain.com"
              value={values.sender}
              onChange={(e) => setValue("sender", e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between pt-4 border-t border-border">
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Info className="h-3.5 w-3.5 flex-shrink-0" />
          Cloudflare is default; Resend remains available for merchants who prefer it.
        </p>
        <Button
          onClick={() => handleSubmit()}
          disabled={isSaving}
          className="min-w-[140px]"
        >
          {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          <Save className="mr-2 h-4 w-4" />
          Save Email Settings
        </Button>
      </div>
    </div>
  );
}
