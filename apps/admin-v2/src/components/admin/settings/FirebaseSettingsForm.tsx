import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  RotateCcw,
  Save,
  Smartphone,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { UnsavedChangesGuard } from "@/components/admin/shared/UnsavedChangesGuard";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { usePermissions } from "@/contexts/PermissionContext";
import { getSettingsLoadErrorMessage } from "@/hooks/use-settings-form";
import { ADMIN_PERMISSIONS } from "@/lib/admin-permissions";
import { getServerFnError } from "@/lib/api-helpers";
import {
  getAdminNotificationChannels,
  getFirebaseSettings,
  type FirebaseSettingsPayload,
  type SettingsPayload,
  updateFirebaseSettings,
} from "@/lib/api-functions/settings";
import { queryKeys } from "@/lib/query-keys";

const MASKED_VALUE = "••••••••••••";
const PUBLIC_CONFIG_FIELDS = [
  "apiKey",
  "authDomain",
  "projectId",
  "storageBucket",
  "messagingSenderId",
  "appId",
  "measurementId",
  "vapidKey",
] as const;
const REQUIRED_BROWSER_FIELDS = [
  "apiKey",
  "authDomain",
  "projectId",
  "messagingSenderId",
  "appId",
  "vapidKey",
] as const;

type FirebasePublicConfigKey = (typeof PUBLIC_CONFIG_FIELDS)[number];

interface FirebasePublicConfig extends Record<string, string> {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  measurementId: string;
  vapidKey: string;
}

interface FirebaseDraft {
  serviceAccount: string;
  publicConfig: FirebasePublicConfig;
}

function normalizePublicConfig(value: SettingsPayload): FirebasePublicConfig {
  return PUBLIC_CONFIG_FIELDS.reduce<FirebasePublicConfig>((config, key) => {
    const field = value[key];
    config[key] = typeof field === "string" ? field : "";
    return config;
  }, {
    apiKey: "",
    authDomain: "",
    projectId: "",
    storageBucket: "",
    messagingSenderId: "",
    appId: "",
    measurementId: "",
    vapidKey: "",
  });
}

function toDraft(settings: FirebaseSettingsPayload): FirebaseDraft {
  return {
    serviceAccount: settings.serviceAccount,
    publicConfig: normalizePublicConfig(settings.publicConfig),
  };
}

function draftsEqual(left: FirebaseDraft | null, right: FirebaseDraft | null): boolean {
  return Boolean(
    left
    && right
    && left.serviceAccount === right.serviceAccount
    && PUBLIC_CONFIG_FIELDS.every(
      (key) => left.publicConfig[key] === right.publicConfig[key],
    ),
  );
}

function hasCompleteBrowserConfig(value: FirebaseDraft | null): boolean {
  return Boolean(
    value
    && REQUIRED_BROWSER_FIELDS.every((key) => value.publicConfig[key].trim()),
  );
}

function validateServiceAccountJson(value: string): string | null {
  if (!value || value === MASKED_VALUE) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.private_key !== "string" || !parsed.private_key.trim()) {
      return "Service account JSON is missing private_key.";
    }
    if (typeof parsed.client_email !== "string" || !parsed.client_email.trim()) {
      return "Service account JSON is missing client_email.";
    }
    if (typeof parsed.project_id !== "string" || !parsed.project_id.trim()) {
      return "Service account JSON is missing project_id.";
    }
    return null;
  } catch {
    return "Service account JSON is not valid JSON.";
  }
}

function parseFirebaseConfig(raw: string): Partial<FirebasePublicConfig> {
  let input = raw.trim();
  input = input.replace(/^(const|let|var)\s+\w+\s*=\s*/, "");
  input = input.replace(/;$/, "");
  input = input.replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
  input = input.replace(/,(\s*[}\]])/g, "$1");
  const parsed = JSON.parse(input) as Record<string, unknown>;
  return PUBLIC_CONFIG_FIELDS.reduce<Partial<FirebasePublicConfig>>(
    (config, key) => {
      if (typeof parsed[key] === "string") config[key] = parsed[key];
      return config;
    },
    {},
  );
}

const BROWSER_FIELDS: Array<{
  key: FirebasePublicConfigKey;
  label: string;
  placeholder: string;
}> = [
  { key: "apiKey", label: "API key", placeholder: "AIzaSy..." },
  { key: "authDomain", label: "Auth domain", placeholder: "your-project.firebaseapp.com" },
  { key: "projectId", label: "Project ID", placeholder: "your-project" },
  { key: "storageBucket", label: "Storage bucket", placeholder: "your-project.firebasestorage.app" },
  { key: "messagingSenderId", label: "Messaging sender ID", placeholder: "123456789" },
  { key: "appId", label: "App ID", placeholder: "1:123456789:web:abc123" },
];

export default function FirebaseSettingsForm() {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const queryClient = useQueryClient();
  const firebaseQuery = useQuery({
    queryKey: queryKeys.settings.firebase(),
    queryFn: getFirebaseSettings,
  });
  const isLoadError = firebaseQuery.isError;
  const loadError = firebaseQuery.error;
  const readinessQuery = useQuery({
    queryKey: queryKeys.settings.adminNotificationChannels(),
    queryFn: getAdminNotificationChannels,
  });
  const [draft, setDraft] = useState<FirebaseDraft | null>(null);
  const [savedDraft, setSavedDraft] = useState<FirebaseDraft | null>(null);
  const [rawPublicConfig, setRawPublicConfig] = useState("");
  const [showRawPaste, setShowRawPaste] = useState(false);
  const dirty = Boolean(draft && savedDraft && !draftsEqual(draft, savedDraft));

  useEffect(() => {
    if (!firebaseQuery.data || dirty) return;
    const nextDraft = toDraft(firebaseQuery.data);
    setDraft(nextDraft);
    setSavedDraft(nextDraft);
  }, [dirty, firebaseQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async (nextDraft: FirebaseDraft) => {
      const serviceAccountError = validateServiceAccountJson(nextDraft.serviceAccount);
      if (serviceAccountError) throw new Error(serviceAccountError);

      const payload: SettingsPayload = {
        publicConfig: nextDraft.publicConfig,
      };
      if (nextDraft.serviceAccount !== MASKED_VALUE) {
        payload.serviceAccount = nextDraft.serviceAccount;
      }
      return updateFirebaseSettings({ data: payload });
    },
    onSuccess: async (_response, saved) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.settings.firebase() }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.settings.adminNotificationChannels(),
        }),
      ]);
      const refreshed = queryClient.getQueryData<FirebaseSettingsPayload>(
        queryKeys.settings.firebase(),
      );
      const nextDraft = refreshed ? toDraft(refreshed) : saved;
      setDraft(nextDraft);
      setSavedDraft(nextDraft);
      setRawPublicConfig("");
      setShowRawPaste(false);
      toast.success("Firebase settings saved");
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Firebase settings could not be saved"));
    },
  });

  const savedBrowserConfigComplete = useMemo(
    () => hasCompleteBrowserConfig(savedDraft),
    [savedDraft],
  );
  const serviceAccountSaved = firebaseQuery.data?.serviceAccount === MASKED_VALUE;
  const providerReady = readinessQuery.data?.pushConfigured === true;
  const setupComplete = providerReady && savedBrowserConfigComplete;
  const canEdit = canManage && !saveMutation.isPending;

  if (firebaseQuery.isLoading || !draft || !firebaseQuery.data) {
    if (isLoadError) {
      return (
        <Alert variant="destructive" className="max-w-3xl">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Firebase settings unavailable</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              {getSettingsLoadErrorMessage(
                loadError,
                "Firebase settings could not be loaded. Existing push credentials were not changed.",
              )}
            </p>
            <Button type="button" variant="outline" onClick={() => void firebaseQuery.refetch()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      );
    }
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  function updatePublicConfig(key: FirebasePublicConfigKey, value: string) {
    setDraft((current) => ({
      ...current!,
      publicConfig: { ...current!.publicConfig, [key]: value },
    }));
  }

  function fillPastedConfig() {
    try {
      const parsed = parseFirebaseConfig(rawPublicConfig);
      setDraft((current) => ({
        ...current!,
        publicConfig: {
          ...current!.publicConfig,
          ...parsed,
        } as FirebasePublicConfig,
      }));
      setShowRawPaste(false);
      setRawPublicConfig("");
      toast.success("Firebase config filled");
    } catch {
      toast.error("Firebase config could not be parsed");
    }
  }

  return (
    <>
      <UnsavedChangesGuard isDirty={dirty} isSubmitting={saveMutation.isPending} />
      <div className="max-w-5xl space-y-4 pb-24">
        {!canManage && (
          <Alert>
            <AlertDescription>
              Your role can review Firebase settings, but cannot change them.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-2 rounded-lg border bg-card px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${setupComplete ? "bg-emerald-500" : "bg-amber-500"}`}
              aria-hidden="true"
            />
            <span className="text-sm font-semibold">
              {setupComplete ? "Push configured" : "Push setup incomplete"}
            </span>
            {dirty ? <Badge variant="outline">Unsaved</Badge> : null}
          </div>
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            <Badge variant="outline">
              {providerReady
                ? "Server configured"
                : readinessQuery.isError
                  ? "Server unavailable"
                  : "Server needs setup"}
            </Badge>
            <Badge variant="outline">
              {savedBrowserConfigComplete ? "Browser configured" : "Browser needs setup"}
            </Badge>
          </div>
          {!providerReady ? (
            <p className="text-xs text-muted-foreground sm:basis-full">
              {readinessQuery.data?.pushError
                ?? (readinessQuery.isError
                  ? "Provider status could not be checked."
                  : "Checking provider status…")}
            </p>
          ) : null}
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4" />
              Server credential
              {serviceAccountSaved && (
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="firebase-service-account">Service account JSON</Label>
              <Textarea
                id="firebase-service-account"
                value={draft.serviceAccount}
                disabled={!canEdit}
                spellCheck={false}
                autoComplete="off"
                placeholder='{ "type": "service_account", "project_id": "..." }'
                className="min-h-40 font-mono text-xs"
                onChange={(event) => setDraft((current) => ({
                  ...current!,
                  serviceAccount: event.target.value,
                }))}
              />
              <p className="text-xs text-muted-foreground">
                {serviceAccountSaved && draft.serviceAccount === MASKED_VALUE
                  ? "A credential is saved. Paste new JSON to replace it, or clear this field and save to remove it."
                  : draft.serviceAccount
                    ? "The new credential is validated before saving."
                    : "No dashboard credential will be stored."}
              </p>
            </div>
            <Button variant="outline" asChild className="min-h-11 w-full sm:w-auto">
              <a
                href="https://console.firebase.google.com/project/_/settings/serviceaccounts/adminsdk"
                target="_blank"
                rel="noopener noreferrer"
              >
                Open service accounts <ExternalLink className="ml-2 h-4 w-4" />
              </a>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Smartphone className="h-4 w-4" />
              Browser configuration
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
              <Button variant="outline" asChild className="min-h-11 sm:min-h-9">
                <a
                  href="https://console.firebase.google.com/project/_/settings/general"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open web app settings <ExternalLink className="ml-2 h-4 w-4" />
                </a>
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 sm:min-h-9"
                disabled={!canEdit}
                aria-expanded={showRawPaste}
                onClick={() => setShowRawPaste((visible) => !visible)}
              >
                {showRawPaste ? "Cancel paste" : "Paste web config"}
              </Button>
            </div>

            {showRawPaste && (
              <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                <Label htmlFor="firebase-config-paste">Firebase config object</Label>
                <Textarea
                  id="firebase-config-paste"
                  value={rawPublicConfig}
                  disabled={!canEdit}
                  spellCheck={false}
                  placeholder='{ "apiKey": "...", "authDomain": "...", "projectId": "..." }'
                  className="min-h-28 font-mono text-xs"
                  onChange={(event) => setRawPublicConfig(event.target.value)}
                />
                <Button
                  type="button"
                  size="sm"
                  className="min-h-11 w-full sm:min-h-9 sm:w-auto"
                  disabled={!canEdit || !rawPublicConfig.trim()}
                  onClick={fillPastedConfig}
                >
                  Fill fields
                </Button>
              </div>
            )}

            <div className="grid gap-4 md:grid-cols-2">
              {BROWSER_FIELDS.map((field) => {
                const id = `firebase-${field.key}`;
                return (
                  <div key={field.key} className="space-y-1.5">
                    <Label htmlFor={id}>{field.label}</Label>
                    <Input
                      id={id}
                      value={draft.publicConfig[field.key]}
                      disabled={!canEdit}
                      autoComplete="off"
                      placeholder={field.placeholder}
                      className="h-11 sm:h-9"
                      onChange={(event) => updatePublicConfig(field.key, event.target.value)}
                    />
                  </div>
                );
              })}
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="firebase-vapidKey">VAPID public key</Label>
                <Input
                  id="firebase-vapidKey"
                  value={draft.publicConfig.vapidKey}
                  disabled={!canEdit}
                  autoComplete="off"
                  placeholder="BKagOny0KF_2pCJQ3m..."
                  className="h-11 font-mono text-xs sm:h-9"
                  onChange={(event) => updatePublicConfig("vapidKey", event.target.value)}
                />
              </div>
            </div>
            <Button variant="outline" asChild className="min-h-11 w-full sm:w-auto">
              <a
                href="https://console.firebase.google.com/project/_/settings/cloudmessaging"
                target="_blank"
                rel="noopener noreferrer"
              >
                Open Cloud Messaging <ExternalLink className="ml-2 h-4 w-4" />
              </a>
            </Button>
          </CardContent>
        </Card>

        <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-2 border-t pt-4 sm:flex sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 min-w-0 sm:min-h-9"
            disabled={!canEdit || !dirty}
            onClick={() => {
              setDraft(savedDraft);
              setRawPublicConfig("");
              setShowRawPaste(false);
            }}
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset
          </Button>
          <Button
            type="button"
            className="min-h-11 min-w-0 sm:min-h-9 sm:min-w-32"
            disabled={!canEdit || !dirty}
            onClick={() => saveMutation.mutate(draft)}
          >
            {saveMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save changes
          </Button>
        </div>
      </div>
    </>
  );
}
