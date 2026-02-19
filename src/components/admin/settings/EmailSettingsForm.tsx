// src/components/admin/settings/EmailSettingsForm.tsx
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
import { toast } from "sonner";
import { Loader2, Save, CheckCircle2, ExternalLink } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

const MASKED_VALUE = "••••••••••••";

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
      const res = await fetch("/api/settings/email");
      if (res.ok) {
        const data = await res.json();
        setApiKey(data.apiKey || "");
        setSender(data.sender || "");
        setApiKeyConfigured(!!data.apiKey);
      }
    } catch {
      toast.error("Failed to load email settings");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      const res = await fetch("/api/settings/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, sender }),
      });

      if (res.ok) {
        toast.success("Email settings saved successfully!");
        fetchSettings();
      } else {
        const err = await res.json();
        toast.error(err.message || "Failed to save email settings");
      }
    } catch {
      toast.error("An error occurred while saving");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center p-8">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Email Settings</h2>
          <p className="text-muted-foreground">
            Configure transactional email delivery via Resend.
          </p>
        </div>
        <Button onClick={handleSubmit} disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          <Save className="mr-2 h-4 w-4" />
          Save Changes
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Resend API Key
            {apiKeyConfigured && (
              <CheckCircle2 className="h-5 w-5 text-green-500" />
            )}
          </CardTitle>
          <CardDescription>
            Used to send transactional emails (verification, password reset,
            2FA codes).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
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
              → Create a new API key with "Sending access".
            </AlertDescription>
          </Alert>
          <div className="space-y-2">
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
                <CheckCircle2 className="h-3 w-3" /> API key configured. Type a
                new key to replace it.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sender Email Address</CardTitle>
          <CardDescription>
            The "From" address shown on outgoing emails. Must be verified in
            your Resend account.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertDescription className="text-sm">
              <strong>Note:</strong> The domain used in this address must be
              verified in Resend. See{" "}
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
          <div className="space-y-2">
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

      <div className="flex justify-end pb-4">
        <Button onClick={handleSubmit} disabled={saving} size="lg">
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save Email Settings
        </Button>
      </div>
    </div>
  );
}
