import React, { useState, useEffect } from "react";
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
import { toast } from "sonner";
import { Loader2, Save, CheckCircle2, ExternalLink, Info } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { getServerFnError } from "@/lib/api-helpers";
import { getEmailSettings, updateEmailSettings } from "@/lib/api.functions";

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

export default function EmailSettingsForm() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [sender, setSender] = useState("");
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const data = await getEmailSettings() as Record<string, unknown>;
      setApiKey((data.apiKey as string) || "");
      setSender((data.sender as string) || "");
      setApiKeyConfigured(!!data.apiKey);
    } catch {
      toast.error("Failed to load email settings");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e?: React.SyntheticEvent) => {
    e?.preventDefault();
    setSaving(true);

    try {
      await updateEmailSettings({ data: { apiKey, sender } });
      toast.success("Email settings saved successfully!");
      fetchSettings();
    } catch (err) {
      toast.error(getServerFnError(err, "Failed to save email settings"));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isConfigured = apiKeyConfigured && !!sender;

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
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="font-mono"
            />
            {apiKeyConfigured && apiKey === MASKED_VALUE && (
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
              value={sender}
              onChange={(e) => setSender(e.target.value)}
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
          disabled={saving}
          className="min-w-[140px]"
        >
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          <Save className="mr-2 h-4 w-4" />
          Save Email Settings
        </Button>
      </div>
    </div>
  );
}
