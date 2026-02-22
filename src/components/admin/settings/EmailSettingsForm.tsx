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

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
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
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-2xl">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            Resend API Key
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
              → Create a key with "Sending access".
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

      <div className="flex justify-end pt-4 border-t border-border">
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
