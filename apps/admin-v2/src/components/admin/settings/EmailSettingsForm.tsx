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
import { Loader2, Save, CheckCircle2, ExternalLink, Info } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { queryKeys } from "@/lib/query-keys";
import {
  getEmailSettings,
  type SettingsPayload,
  updateEmailSettings,
} from "@/lib/api-functions/settings";

const MASKED_VALUE = "••••••••••••";

/** Inline Resend-style logo: a stylized "R" in a violet rounded square */
function ResendLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Resend logo"
    >
      <rect width="32" height="32" rx="7" fill="#7C3AED" />
      <path
        d="M10 8h7.5a4.5 4.5 0 0 1 0 9H14.5l6.5 7h-3.8l-5.7-6.2V24H10V8Zm1.5 1.5v5.7h6a3 3 0 1 0 0-5.7h-6Z"
        fill="white"
      />
    </svg>
  );
}

interface EmailSettings {
  apiKey: string;
  sender: string;
}

export default function EmailSettingsForm() {
  const { values, setValue, isLoading, isSaving, handleSubmit } = useSettingsForm<EmailSettings>({
    queryKey: queryKeys.settings.email(),
    fetchFn: () => getEmailSettings() as Promise<Partial<EmailSettings>>,
    saveFn: (v) => updateEmailSettings({ data: v as unknown as SettingsPayload }),
    defaultValues: { apiKey: "", sender: "" },
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

  // Derive configured status from current values
  const apiKeyConfigured = !!values.apiKey;
  const isConfigured = apiKeyConfigured && !!values.sender;

  return (
    <div className="space-y-5 max-w-2xl">
      {/* Provider Header Card */}
      <Card>
        <CardContent className="flex items-center gap-4 py-5">
          <div className="flex-shrink-0 rounded-lg bg-violet-100 dark:bg-violet-950/40 p-2.5">
            <ResendLogo className="h-8 w-8" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">Email Provider: Resend</h3>
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

      {/* API Key Card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            API Key
            {apiKeyConfigured && (
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            )}
          </CardTitle>
          <CardDescription>
            Used for transactional emails (verification, password reset, 2FA).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Alert>
            <AlertDescription className="text-sm">
              <strong>Where to find:</strong>{" "}
              <a
                href="https://resend.com/api-keys"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                resend.com/api-keys <ExternalLink className="h-3 w-3" />
              </a>{" "}
              — Create a key with "Sending access".
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

      {/* Sender Address Card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Sender Email Address</CardTitle>
          <CardDescription>
            The "From" address on outgoing emails. Must be verified in Resend.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Alert>
            <AlertDescription className="text-sm">
              The domain must be verified at{" "}
              <a
                href="https://resend.com/domains"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                resend.com/domains <ExternalLink className="h-3 w-3" />
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
          More email providers (SendGrid, Mailgun, AWS SES) coming soon.
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
