// src/components/admin/settings/StripeSettingsForm.tsx
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
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Loader2, Save, CheckCircle2, ExternalLink, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

const MASKED_VALUE = "••••••••••••";

export default function StripeSettingsForm() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [secretKey, setSecretKey] = useState("");
  const [publishableKey, setPublishableKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [enabled, setEnabled] = useState(false);

  const [secretKeyConfigured, setSecretKeyConfigured] = useState(false);
  const [webhookSecretConfigured, setWebhookSecretConfigured] = useState(false);

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const res = await fetch("/api/settings/stripe");
      if (res.ok) {
        const data = await res.json();
        setSecretKey(data.secretKey || "");
        setPublishableKey(data.publishableKey || "");
        setWebhookSecret(data.webhookSecret || "");
        setEnabled(data.enabled ?? false);
        setSecretKeyConfigured(!!data.secretKey);
        setWebhookSecretConfigured(!!data.webhookSecret);
      }
    } catch {
      toast.error("Failed to load Stripe settings");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      const res = await fetch("/api/settings/stripe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secretKey, publishableKey, webhookSecret, enabled }),
      });

      if (res.ok) {
        toast.success("Stripe settings saved successfully!");
        fetchSettings();
      } else {
        const err = await res.json();
        toast.error(err.message || "Failed to save Stripe settings");
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

  const isLiveKey = secretKey && secretKey !== MASKED_VALUE && secretKey.startsWith("sk_live_");
  const isSandboxKey = secretKey && secretKey !== MASKED_VALUE && secretKey.startsWith("sk_test_");

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            Stripe
            {secretKeyConfigured && enabled && (
              <Badge variant="default" className="text-xs">Active</Badge>
            )}
            {secretKeyConfigured && !enabled && (
              <Badge variant="secondary" className="text-xs">Disabled</Badge>
            )}
          </h2>
          <p className="text-muted-foreground">
            Accept card payments via Stripe.
          </p>
        </div>
        <Button onClick={handleSubmit} disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          <Save className="mr-2 h-4 w-4" />
          Save
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Enable Stripe Payments</span>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label="Enable Stripe"
            />
          </CardTitle>
          <CardDescription>
            Toggle Stripe as an active payment method on your checkout.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Secret Key
            {secretKeyConfigured && (
              <CheckCircle2 className="h-5 w-5 text-green-500" />
            )}
          </CardTitle>
          <CardDescription>
            Your Stripe secret key. Never share this publicly.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertDescription className="text-sm">
              <strong>Where to find:</strong>{" "}
              <a
                href="https://dashboard.stripe.com/apikeys"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                dashboard.stripe.com/apikeys <ExternalLink className="h-3 w-3" />
              </a>{" "}
              → Use the Secret key (starts with <code className="font-mono text-xs">sk_</code>).
            </AlertDescription>
          </Alert>

          {isLiveKey && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="text-sm">
                This is a <strong>live</strong> key. Payments will be charged to real cards.
              </AlertDescription>
            </Alert>
          )}
          {isSandboxKey && (
            <Alert>
              <AlertDescription className="text-sm">
                This is a <strong>test</strong> key. No real charges will occur.
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="stripe-secret-key">Secret Key</Label>
            <Input
              id="stripe-secret-key"
              type="password"
              placeholder={secretKeyConfigured ? MASKED_VALUE : "sk_live_... or sk_test_..."}
              value={secretKey}
              onChange={(e) => setSecretKey(e.target.value)}
              className="font-mono"
            />
            {secretKeyConfigured && secretKey === MASKED_VALUE && (
              <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" /> Secret key configured. Type a new key to replace it.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Publishable Key</CardTitle>
          <CardDescription>
            Your Stripe publishable key. This is safe to expose to the browser.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="stripe-pub-key">Publishable Key</Label>
          <Input
            id="stripe-pub-key"
            type="text"
            placeholder="pk_live_... or pk_test_..."
            value={publishableKey}
            onChange={(e) => setPublishableKey(e.target.value)}
            className="font-mono"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Webhook Secret
            {webhookSecretConfigured && (
              <CheckCircle2 className="h-5 w-5 text-green-500" />
            )}
          </CardTitle>
          <CardDescription>
            Used to verify webhook events sent by Stripe to your server.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertDescription className="text-sm">
              <strong>Where to find:</strong>{" "}
              <a
                href="https://dashboard.stripe.com/webhooks"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                dashboard.stripe.com/webhooks <ExternalLink className="h-3 w-3" />
              </a>{" "}
              → Add endpoint{" "}
              <code className="font-mono text-xs">/api/v1/webhooks/stripe</code> → copy the signing secret (starts with{" "}
              <code className="font-mono text-xs">whsec_</code>).
            </AlertDescription>
          </Alert>
          <div className="space-y-2">
            <Label htmlFor="stripe-webhook-secret">Webhook Signing Secret</Label>
            <Input
              id="stripe-webhook-secret"
              type="password"
              placeholder={webhookSecretConfigured ? MASKED_VALUE : "whsec_..."}
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              className="font-mono"
            />
            {webhookSecretConfigured && webhookSecret === MASKED_VALUE && (
              <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" /> Webhook secret configured. Type a new value to replace it.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end pb-4">
        <Button onClick={handleSubmit} disabled={saving} size="lg">
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save Stripe Settings
        </Button>
      </div>
    </div>
  );
}
