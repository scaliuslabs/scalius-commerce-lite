import React, { useState } from "react";
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
import { useSettingsForm } from "@/hooks/use-settings-form";
import { queryKeys } from "@/lib/query-keys";
import {
  getFirebaseSettings,
  type SettingsPayload,
  updateFirebaseSettings,
} from "@/lib/api-functions/settings";

interface FirebasePublicConfig {
  apiKey?: string;
  authDomain?: string;
  projectId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
  measurementId?: string;
  vapidKey?: string;
}

interface FirebaseSettings {
  serviceAccount: string;
  publicConfig: FirebasePublicConfig;
}

const defaultValues: FirebaseSettings = {
  serviceAccount: "",
  publicConfig: {},
};

function validateServiceAccountJson(
  json: string,
): { valid: boolean; error?: string } {
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
  } catch {
    return { valid: false, error: "Invalid JSON format" };
  }
}

export default function FirebaseSettingsForm() {
  const { values, setValue, setValues, isLoading, isSaving, handleSubmit } = useSettingsForm<FirebaseSettings>({
    queryKey: queryKeys.settings.firebase(),
    fetchFn: () => getFirebaseSettings() as Promise<Partial<FirebaseSettings>>,
    saveFn: (v) => {
      // Build payload: only include serviceAccount if it's new (not masked)
      const payload: { publicConfig: FirebasePublicConfig; serviceAccount?: string } = {
        publicConfig: v.publicConfig,
      };
      if (v.serviceAccount && !v.serviceAccount.includes("••••")) {
        payload.serviceAccount = v.serviceAccount;
      }
      return updateFirebaseSettings({ data: payload as unknown as SettingsPayload });
    },
    defaultValues,
    successMessage: "Settings saved successfully!",
    errorMessage: "Failed to save settings",
  });

  // Derive service account status from current values
  const serviceAccountStatus: "empty" | "configured" | "invalid" = (() => {
    if (!values.serviceAccount) return "empty";
    if (values.serviceAccount.includes("••••")) return "configured";
    const validation = validateServiceAccountJson(values.serviceAccount);
    return validation.valid ? "configured" : "invalid";
  })();

  // UI-only state for the raw paste feature
  const [rawPublicConfig, setRawPublicConfig] = useState("");
  const [showRawPaste, setShowRawPaste] = useState(false);

  const handleServiceAccountChange = (
    e: React.ChangeEvent<HTMLTextAreaElement>,
  ) => {
    setValue("serviceAccount", e.target.value);
  };

  const handlePublicConfigChange = (
    key: keyof FirebasePublicConfig,
    value: string,
  ) => {
    setValues((prev) => ({
      ...prev,
      publicConfig: { ...prev.publicConfig, [key]: value },
    }));
  };

  const handleRawPaste = () => {
    try {
      let input = rawPublicConfig.trim();

      // Remove JavaScript variable declaration if present
      // e.g., "const firebaseConfig = { ... };" -> "{ ... }"
      input = input.replace(/^(const|let|var)\s+\w+\s*=\s*/, "");
      input = input.replace(/;$/, ""); // Remove trailing semicolon

      // Convert JavaScript object syntax to valid JSON
      // Only quote keys that appear at the start of a line or after { or ,
      // This regex matches: `  keyName:` pattern (unquoted key followed by colon)
      // but NOT colons inside strings like URLs
      input = input.replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');

      // Handle trailing commas (invalid in JSON but valid in JS)
      input = input.replace(/,(\s*[}\]])/g, "$1");

      const parsed = JSON.parse(input);
      const mapped: FirebasePublicConfig = { ...values.publicConfig };
      const keys = [
        "apiKey",
        "authDomain",
        "projectId",
        "storageBucket",
        "messagingSenderId",
        "appId",
        "measurementId",
      ] as const;
      keys.forEach((k) => {
        if (parsed[k]) mapped[k] = parsed[k];
      });
      setValues((prev) => ({ ...prev, publicConfig: mapped }));
      setShowRawPaste(false);
      setRawPublicConfig("");
      toast.success("Config parsed successfully!");
    } catch (e: unknown) {
      if (import.meta.env.DEV) console.error("Parse error:", e);
      toast.error("Could not parse config. Please check format.");
    }
  };

  // Custom submit with pre-validation for service account JSON
  const onSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault();

    if (values.serviceAccount && !values.serviceAccount.includes("••••")) {
      const validation = validateServiceAccountJson(values.serviceAccount);
      if (!validation.valid) {
        toast.error(validation.error || "Invalid Service Account JSON");
        return;
      }
    }

    await handleSubmit();
  };

  if (isLoading) {
    return (
      <div className="flex justify-center p-8">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-3xl">

      {/* SECTION 1: Service Account */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            Service Account JSON
            {serviceAccountStatus === "configured" && (
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            )}
            {serviceAccountStatus === "invalid" && (
              <AlertCircle className="h-4 w-4 text-red-500" />
            )}
          </CardTitle>
          <CardDescription>
            Required for sending notifications from the server.
          </CardDescription>
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
              value={values.serviceAccount}
              onChange={handleServiceAccountChange}
            />
            {serviceAccountStatus === "configured" &&
              values.serviceAccount.includes("••••") && (
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
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Firebase Web App Config</CardTitle>
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
                value={values.publicConfig.apiKey || ""}
                onChange={(e) =>
                  handlePublicConfigChange("apiKey", e.target.value)
                }
                placeholder="AIzaSy..."
              />
            </div>
            <div className="space-y-2">
              <Label>Auth Domain</Label>
              <Input
                value={values.publicConfig.authDomain || ""}
                onChange={(e) =>
                  handlePublicConfigChange("authDomain", e.target.value)
                }
                placeholder="your-project.firebaseapp.com"
              />
            </div>
            <div className="space-y-2">
              <Label>Project ID</Label>
              <Input
                value={values.publicConfig.projectId || ""}
                onChange={(e) =>
                  handlePublicConfigChange("projectId", e.target.value)
                }
                placeholder="your-project"
              />
            </div>
            <div className="space-y-2">
              <Label>Storage Bucket</Label>
              <Input
                value={values.publicConfig.storageBucket || ""}
                onChange={(e) =>
                  handlePublicConfigChange("storageBucket", e.target.value)
                }
                placeholder="your-project.firebasestorage.app"
              />
            </div>
            <div className="space-y-2">
              <Label>Messaging Sender ID</Label>
              <Input
                value={values.publicConfig.messagingSenderId || ""}
                onChange={(e) =>
                  handlePublicConfigChange("messagingSenderId", e.target.value)
                }
                placeholder="123456789"
              />
            </div>
            <div className="space-y-2">
              <Label>App ID</Label>
              <Input
                value={values.publicConfig.appId || ""}
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
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Web Push Certificate (VAPID Key)</CardTitle>
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
              value={values.publicConfig.vapidKey || ""}
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

      <div className="flex justify-end pt-4 border-t border-border">
        <Button onClick={onSubmit} disabled={isSaving} className="min-w-[160px]">
          {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          <Save className="mr-2 h-4 w-4" />
          Save All Settings
        </Button>
      </div>
    </div>
  );
}
