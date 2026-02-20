// src/components/admin/settings/SSLCommerzSettingsForm.tsx
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

export default function SSLCommerzSettingsForm() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [storeId, setStoreId] = useState("");
  const [storePassword, setStorePassword] = useState("");
  const [sandbox, setSandbox] = useState(true);
  const [enabled, setEnabled] = useState(false);

  const [passwordConfigured, setPasswordConfigured] = useState(false);

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const res = await fetch("/api/settings/sslcommerz");
      if (res.ok) {
        const data = await res.json();
        setStoreId(data.storeId || "");
        setStorePassword(data.storePassword || "");
        setSandbox(data.sandbox ?? true);
        setEnabled(data.enabled ?? false);
        setPasswordConfigured(!!data.storePassword);
      }
    } catch {
      toast.error("Failed to load SSLCommerz settings");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      const res = await fetch("/api/settings/sslcommerz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeId, storePassword, sandbox, enabled }),
      });

      if (res.ok) {
        toast.success("SSLCommerz settings saved successfully!");
        fetchSettings();
      } else {
        const err = await res.json();
        toast.error(err.message || "Failed to save SSLCommerz settings");
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
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            SSLCommerz
            {storeId && enabled && !sandbox && (
              <Badge variant="default" className="text-xs">Live</Badge>
            )}
            {storeId && enabled && sandbox && (
              <Badge variant="secondary" className="text-xs">Sandbox</Badge>
            )}
            {storeId && !enabled && (
              <Badge variant="secondary" className="text-xs">Disabled</Badge>
            )}
          </h2>
          <p className="text-muted-foreground">
            Accept payments via SSLCommerz (Bangladesh local gateway).
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
            <span>Enable SSLCommerz Payments</span>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label="Enable SSLCommerz"
            />
          </CardTitle>
          <CardDescription>
            Toggle SSLCommerz as an active payment method on your checkout.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Sandbox Mode</span>
            <Switch
              checked={sandbox}
              onCheckedChange={setSandbox}
              aria-label="Sandbox mode"
            />
          </CardTitle>
          <CardDescription>
            Use SSLCommerz sandbox for testing. Disable this in production.
          </CardDescription>
        </CardHeader>
        {!sandbox && (
          <CardContent>
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="text-sm">
                <strong>Live mode enabled.</strong> Real transactions will be processed.
                Ensure your store ID and password are production credentials.
              </AlertDescription>
            </Alert>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Store ID</CardTitle>
          <CardDescription>
            Your SSLCommerz store identifier.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertDescription className="text-sm">
              <strong>Where to find:</strong>{" "}
              <a
                href="https://dashboard.sslcommerz.com"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                dashboard.sslcommerz.com <ExternalLink className="h-3 w-3" />
              </a>{" "}
              → Merchant account → Store credentials.
            </AlertDescription>
          </Alert>
          <div className="space-y-2">
            <Label htmlFor="ssl-store-id">Store ID</Label>
            <Input
              id="ssl-store-id"
              type="text"
              placeholder="your_store_id"
              value={storeId}
              onChange={(e) => setStoreId(e.target.value)}
              className="font-mono"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Store Password
            {passwordConfigured && (
              <CheckCircle2 className="h-5 w-5 text-green-500" />
            )}
          </CardTitle>
          <CardDescription>
            Your SSLCommerz store password. Keep this secret.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="ssl-store-password">Store Password</Label>
          <Input
            id="ssl-store-password"
            type="password"
            placeholder={passwordConfigured ? MASKED_VALUE : "your_store_password"}
            value={storePassword}
            onChange={(e) => setStorePassword(e.target.value)}
            className="font-mono"
          />
          {passwordConfigured && storePassword === MASKED_VALUE && (
            <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" /> Password configured. Type a new value to replace it.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end pb-4">
        <Button onClick={handleSubmit} disabled={saving} size="lg">
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save SSLCommerz Settings
        </Button>
      </div>
    </div>
  );
}
