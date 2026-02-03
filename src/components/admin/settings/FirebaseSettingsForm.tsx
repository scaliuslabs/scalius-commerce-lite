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
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Loader2, Save } from "lucide-react";

interface FirebaseConfig {
  serviceAccount: string; // Will come as masked or empty
  publicConfig: {
    apiKey?: string;
    authDomain?: string;
    projectId?: string;
    storageBucket?: string;
    messagingSenderId?: string;
    appId?: string;
    measurementId?: string;
    vapidKey?: string;
  };
}

export default function FirebaseSettingsForm() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [serviceAccountJson, setServiceAccountJson] = useState("");
  const [publicConfig, setPublicConfig] = useState<
    FirebaseConfig["publicConfig"]
  >({});

  // State for raw JSON paste
  const [rawPublicConfig, setRawPublicConfig] = useState("");
  const [showRawPaste, setShowRawPaste] = useState(false);

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const res = await fetch("/api/settings/firebase");
      if (res.ok) {
        const data = await res.json();
        setServiceAccountJson(data.serviceAccount); // Will be masked or empty
        setPublicConfig(data.publicConfig || {});
      }
    } catch (error) {
      toast.error("Failed to load Firebase settings");
    } finally {
      setLoading(false);
    }
  };

  const handleServiceAccountChange = (
    e: React.ChangeEvent<HTMLTextAreaElement>,
  ) => {
    setServiceAccountJson(e.target.value);
  };

  const handlePublicConfigChange = (
    key: keyof FirebaseConfig["publicConfig"],
    value: string,
  ) => {
    setPublicConfig((prev) => ({ ...prev, [key]: value }));
  };

  const handleRawPaste = () => {
    try {
      const parsed = JSON.parse(rawPublicConfig);
      // Map known keys
      const mapped: any = { ...publicConfig };
      const keys = [
        "apiKey",
        "authDomain",
        "projectId",
        "storageBucket",
        "messagingSenderId",
        "appId",
        "measurementId",
      ];
      keys.forEach((k) => {
        if (parsed[k]) mapped[k] = parsed[k];
      });
      setPublicConfig(mapped);
      setShowRawPaste(false);
      setRawPublicConfig("");
      toast.success("Public config parsed successfully");
    } catch (e) {
      toast.error("Invalid JSON format");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      const payload: any = {
        publicConfig,
      };

      // Only send service account if it's not the masked value
      if (serviceAccountJson && !serviceAccountJson.includes("••••")) {
        // Validate JSON locally before sending
        try {
          JSON.parse(serviceAccountJson);
          payload.serviceAccount = serviceAccountJson;
        } catch (e) {
          toast.error("Invalid Service Account JSON");
          setSaving(false);
          return;
        }
      }

      const res = await fetch("/api/settings/firebase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        toast.success("Settings saved successfully");
        if (payload.serviceAccount) {
          // Re-fetch to mask it again
          fetchSettings();
        }
      } else {
        const err = await res.json();
        toast.error(err.error || "Failed to save settings");
      }
    } catch (error) {
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
    <div className="space-y-6 max-w-4xl">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Notifications</h2>
          <p className="text-muted-foreground">
            Configure Firebase Cloud Messaging for order notifications.
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
          <CardTitle>Service Account (Backend)</CardTitle>
          <CardDescription>
            The service account JSON is required for the server to send
            notifications. Download this from Firebase Console {">"} Project
            Settings {">"} Service accounts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Label htmlFor="serviceAccount">Service Account JSON</Label>
            <Textarea
              id="serviceAccount"
              placeholder='{ "type": "service_account", ... }'
              className="font-mono text-xs min-h-[150px]"
              value={serviceAccountJson}
              onChange={handleServiceAccountChange}
            />
            {serviceAccountJson.includes("••••") && (
              <p className="text-xs text-yellow-600 dark:text-yellow-500">
                Existing credentials are hidden for security. Providing a new
                value will overwrite properly.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Public Configuration (Frontend)</CardTitle>
          <CardDescription>
            These settings are used by the admin dashboard browser to receive
            notifications. Found in Firebase Console {">"} Project Settings{" "}
            {">"} General.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowRawPaste(!showRawPaste)}
            >
              {showRawPaste ? "Cancel Paste" : "Paste JSON Config"}
            </Button>
          </div>

          {showRawPaste && (
            <div className="p-4 border rounded-md bg-muted/50 mb-4">
              <Label className="mb-2 block">
                Paste <code>firebaseConfig</code> object here
              </Label>
              <Textarea
                value={rawPublicConfig}
                onChange={(e) => setRawPublicConfig(e.target.value)}
                placeholder='{ "apiKey": "...", "authDomain": "..." }'
                className="font-mono text-xs min-h-[100px] mb-2"
              />
              <Button size="sm" onClick={handleRawPaste}>
                Parse & Fill
              </Button>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>API Key</Label>
              <Input
                value={publicConfig.apiKey || ""}
                onChange={(e) =>
                  handlePublicConfigChange("apiKey", e.target.value)
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Auth Domain</Label>
              <Input
                value={publicConfig.authDomain || ""}
                onChange={(e) =>
                  handlePublicConfigChange("authDomain", e.target.value)
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Project ID</Label>
              <Input
                value={publicConfig.projectId || ""}
                onChange={(e) =>
                  handlePublicConfigChange("projectId", e.target.value)
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Storage Bucket</Label>
              <Input
                value={publicConfig.storageBucket || ""}
                onChange={(e) =>
                  handlePublicConfigChange("storageBucket", e.target.value)
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Messaging Sender ID</Label>
              <Input
                value={publicConfig.messagingSenderId || ""}
                onChange={(e) =>
                  handlePublicConfigChange("messagingSenderId", e.target.value)
                }
              />
            </div>
            <div className="space-y-2">
              <Label>App ID</Label>
              <Input
                value={publicConfig.appId || ""}
                onChange={(e) =>
                  handlePublicConfigChange("appId", e.target.value)
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Measurement ID</Label>
              <Input
                value={publicConfig.measurementId || ""}
                onChange={(e) =>
                  handlePublicConfigChange("measurementId", e.target.value)
                }
              />
            </div>
          </div>

          <div className="pt-4 border-t">
            <div className="space-y-2">
              <Label>VAPID Key (Web Push Certificate)</Label>
              <Input
                value={publicConfig.vapidKey || ""}
                onChange={(e) =>
                  handlePublicConfigChange("vapidKey", e.target.value)
                }
                placeholder="Key pair from Cloud Messaging tab > Web Push certificates"
              />
              <p className="text-xs text-muted-foreground">
                Requires a generated key pair from Firebase Console.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end pb-8">
        <Button onClick={handleSubmit} disabled={saving} size="lg">
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save Changes
        </Button>
      </div>
    </div>
  );
}
