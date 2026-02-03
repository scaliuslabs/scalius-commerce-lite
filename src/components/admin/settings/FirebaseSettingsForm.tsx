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
import {
  Loader2,
  Save,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface FirebaseConfig {
  serviceAccount: string;
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
  const [serviceAccountStatus, setServiceAccountStatus] = useState<
    "empty" | "configured" | "invalid"
  >("empty");

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
        if (data.serviceAccount && data.serviceAccount.includes("••••")) {
          setServiceAccountStatus("configured");
        }
        setServiceAccountJson(data.serviceAccount || "");
        setPublicConfig(data.publicConfig || {});
      }
    } catch (error) {
      toast.error("Failed to load Firebase settings");
    } finally {
      setLoading(false);
    }
  };

  const validateServiceAccountJson = (
    json: string,
  ): { valid: boolean; error?: string } => {
    if (!json || json.includes("••••")) return { valid: true }; // Skip validation for masked/empty
    try {
      const parsed = JSON.parse(json);
      if (!parsed.private_key)
        return { valid: false, error: "Missing 'private_key' field" };
      if (!parsed.client_email)
        return { valid: false, error: "Missing 'client_email' field" };
      if (!parsed.project_id)
        return { valid: false, error: "Missing 'project_id' field" };
      return { valid: true };
    } catch (e) {
      return { valid: false, error: "Invalid JSON format" };
    }
  };

  const handleServiceAccountChange = (
    e: React.ChangeEvent<HTMLTextAreaElement>,
  ) => {
    const value = e.target.value;
    setServiceAccountJson(value);
    if (value && !value.includes("••••")) {
      const validation = validateServiceAccountJson(value);
      setServiceAccountStatus(validation.valid ? "configured" : "invalid");
    }
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
      toast.success("Config parsed successfully!");
    } catch (e) {
      toast.error("Invalid JSON format");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      const payload: any = { publicConfig };

      if (serviceAccountJson && !serviceAccountJson.includes("••••")) {
        const validation = validateServiceAccountJson(serviceAccountJson);
        if (!validation.valid) {
          toast.error(validation.error || "Invalid Service Account JSON");
          setSaving(false);
          return;
        }
        payload.serviceAccount = serviceAccountJson;
      }

      const res = await fetch("/api/settings/firebase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        toast.success("Settings saved successfully!");
        if (payload.serviceAccount) {
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
          <h2 className="text-2xl font-bold tracking-tight">
            Push Notifications
          </h2>
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

      {/* SECTION 1: Service Account */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                1. Service Account JSON
                {serviceAccountStatus === "configured" && (
                  <CheckCircle2 className="h-5 w-5 text-green-500" />
                )}
                {serviceAccountStatus === "invalid" && (
                  <AlertCircle className="h-5 w-5 text-red-500" />
                )}
              </CardTitle>
              <CardDescription>
                Required for sending notifications from the server.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertDescription className="text-sm">
              <strong>Where to find:</strong> Firebase Console → Project
              Settings →
              <a
                href="https://console.firebase.google.com/project/_/settings/serviceaccounts/adminsdk"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline ml-1"
              >
                Service Accounts <ExternalLink className="h-3 w-3" />
              </a>
              → Click "Generate New Private Key" → Download & paste content
              below.
            </AlertDescription>
          </Alert>
          <div className="space-y-2">
            <Label htmlFor="serviceAccount">Service Account JSON</Label>
            <Textarea
              id="serviceAccount"
              placeholder='{ "type": "service_account", "project_id": "...", "private_key": "...", ... }'
              className="font-mono text-xs min-h-[150px]"
              value={serviceAccountJson}
              onChange={handleServiceAccountChange}
            />
            {serviceAccountStatus === "configured" &&
              serviceAccountJson.includes("••••") && (
                <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" /> Credentials configured.
                  Paste new JSON to replace.
                </p>
              )}
          </div>
        </CardContent>
      </Card>

      {/* SECTION 2: Firebase Config */}
      <Card>
        <CardHeader>
          <CardTitle>2. Firebase Web App Config</CardTitle>
          <CardDescription>
            Required for the admin dashboard to receive notifications in
            browser.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertDescription className="text-sm">
              <strong>Where to find:</strong> Firebase Console → Project
              Settings →
              <a
                href="https://console.firebase.google.com/project/_/settings/general"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline ml-1"
              >
                General <ExternalLink className="h-3 w-3" />
              </a>
              → Your apps → Web app → "Config" radio button.
            </AlertDescription>
          </Alert>

          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowRawPaste(!showRawPaste)}
            >
              {showRawPaste ? "Cancel" : "Paste firebaseConfig Object"}
            </Button>
          </div>

          {showRawPaste && (
            <div className="p-4 border rounded-md bg-muted/50">
              <Label className="mb-2 block">
                Paste the entire{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">
                  firebaseConfig
                </code>{" "}
                object:
              </Label>
              <Textarea
                value={rawPublicConfig}
                onChange={(e) => setRawPublicConfig(e.target.value)}
                placeholder='{ "apiKey": "...", "authDomain": "...", "projectId": "..." }'
                className="font-mono text-xs min-h-[100px] mb-2"
              />
              <Button size="sm" onClick={handleRawPaste}>
                Parse & Fill Fields
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
                placeholder="AIzaSy..."
              />
            </div>
            <div className="space-y-2">
              <Label>Auth Domain</Label>
              <Input
                value={publicConfig.authDomain || ""}
                onChange={(e) =>
                  handlePublicConfigChange("authDomain", e.target.value)
                }
                placeholder="your-project.firebaseapp.com"
              />
            </div>
            <div className="space-y-2">
              <Label>Project ID</Label>
              <Input
                value={publicConfig.projectId || ""}
                onChange={(e) =>
                  handlePublicConfigChange("projectId", e.target.value)
                }
                placeholder="your-project"
              />
            </div>
            <div className="space-y-2">
              <Label>Storage Bucket</Label>
              <Input
                value={publicConfig.storageBucket || ""}
                onChange={(e) =>
                  handlePublicConfigChange("storageBucket", e.target.value)
                }
                placeholder="your-project.firebasestorage.app"
              />
            </div>
            <div className="space-y-2">
              <Label>Messaging Sender ID</Label>
              <Input
                value={publicConfig.messagingSenderId || ""}
                onChange={(e) =>
                  handlePublicConfigChange("messagingSenderId", e.target.value)
                }
                placeholder="123456789"
              />
            </div>
            <div className="space-y-2">
              <Label>App ID</Label>
              <Input
                value={publicConfig.appId || ""}
                onChange={(e) =>
                  handlePublicConfigChange("appId", e.target.value)
                }
                placeholder="1:123456789:web:abc123"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* SECTION 3: VAPID Key */}
      <Card>
        <CardHeader>
          <CardTitle>3. Web Push Certificate (VAPID Key)</CardTitle>
          <CardDescription>
            Required for subscribing browsers to push notifications.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertDescription className="text-sm">
              <strong>Where to find:</strong> Firebase Console → Project
              Settings →
              <a
                href="https://console.firebase.google.com/project/_/settings/cloudmessaging"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline ml-1"
              >
                Cloud Messaging <ExternalLink className="h-3 w-3" />
              </a>
              → Web configuration → Web Push certificates → "Generate key pair"
              (if empty) → Copy the Key pair value.
            </AlertDescription>
          </Alert>
          <div className="space-y-2">
            <Label>VAPID Key (Public Key)</Label>
            <Input
              value={publicConfig.vapidKey || ""}
              onChange={(e) =>
                handlePublicConfigChange("vapidKey", e.target.value)
              }
              placeholder="BKagOny0KF_2pCJQ3m....moL0ewzQ8rZu"
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              This is the long base64 string from "Key pair" in Firebase
              Console.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end pb-8">
        <Button onClick={handleSubmit} disabled={saving} size="lg">
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save All Settings
        </Button>
      </div>
    </div>
  );
}
