import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Smartphone,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { isReady } from "@scalius/shared/readiness";
import { toast } from "sonner";

import {
  ContextualSaveBar,
  InlineHelp,
  SettingsSection,
  SkeletonPage,
  StatusBadge,
} from "~/components/admin/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { usePermissions } from "~/contexts/PermissionContext";
import { getSettingsLoadErrorMessage, mergeUneditedFields } from "~/hooks/use-settings-form";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { getServerFnError } from "~/lib/api-helpers";
import {
  getAdminNotificationChannels,
  getFirebaseSettings,
  type FirebaseSettingsPayload,
  type SettingsPayload,
  updateFirebaseSettings,
} from "~/lib/api-functions/settings";
import { queryKeys } from "~/lib/query-keys";

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

function mergeFirebaseDraft(current: FirebaseDraft, baseline: FirebaseDraft, incoming: FirebaseDraft): FirebaseDraft {
  return {
    ...mergeUneditedFields(current, baseline, incoming),
    publicConfig: mergeUneditedFields(current.publicConfig, baseline.publicConfig, incoming.publicConfig),
  };
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
  const dataUpdateCount = queryClient.getQueryState(queryKeys.settings.firebase())?.dataUpdateCount ?? 0;
  const [{ draft, savedDraft }, setEditor] = useState<{ draft: FirebaseDraft | null; savedDraft: FirebaseDraft | null }>({
    draft: null, savedDraft: null,
  });
  const [retrying, setRetrying] = useState(false);
  const commandInFlight = useRef(false);
  const ignoredReadUpdates = useRef(-1);
  function setDraft(next: SetStateAction<FirebaseDraft | null>) {
    setEditor((current) => ({
      ...current,
      draft: typeof next === "function" ? next(current.draft) : next,
    }));
  }
  const [rawPublicConfig, setRawPublicConfig] = useState("");
  const [showRawPaste, setShowRawPaste] = useState(false);
  const dirty = Boolean(draft && savedDraft && !draftsEqual(draft, savedDraft));

  useEffect(() => {
    if (!firebaseQuery.data || dataUpdateCount <= ignoredReadUpdates.current) return;
    const incoming = toDraft(firebaseQuery.data);
    setEditor((current) => ({
      draft: current.draft && current.savedDraft
        ? mergeFirebaseDraft(current.draft, current.savedDraft, incoming)
        : incoming,
      savedDraft: incoming,
    }));
  }, [firebaseQuery.data, firebaseQuery.dataUpdatedAt, dataUpdateCount]);

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
      // Ignore pre-acknowledgment reads even if their React effect is still queued.
      ignoredReadUpdates.current = queryClient.getQueryState(queryKeys.settings.firebase())?.dataUpdateCount ?? 0;
      // A committed write is authoritative even if its confirming read fails.
      setEditor((current) => ({ draft: current.draft ?? saved, savedDraft: saved }));
      setRawPublicConfig("");
      setShowRawPaste(false);
      const [refreshed] = await Promise.all([
        firebaseQuery.refetch({ throwOnError: true }).then((result) => result.isSuccess, () => false),
        queryClient.invalidateQueries({ queryKey: queryKeys.settings.adminNotificationChannels() }),
      ]);
      if (refreshed) toast.success("Firebase settings saved");
      else toast.warning("Firebase settings were saved, but the current settings could not be refreshed.");
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Firebase settings could not be saved"));
    },
    onSettled: () => { commandInFlight.current = false; },
  });

  const handleSave = () => {
    if (!canManage || !draft || !dirty || commandInFlight.current) return;
    commandInFlight.current = true;
    saveMutation.mutate(draft);
  };
  const handleRetry = async () => {
    if (commandInFlight.current) return;
    commandInFlight.current = true;
    setRetrying(true);
    try {
      await Promise.all([firebaseQuery.refetch(), readinessQuery.refetch()]);
    } finally {
      commandInFlight.current = false;
      setRetrying(false);
    }
  };

  const savedBrowserConfigComplete = useMemo(
    () => hasCompleteBrowserConfig(savedDraft),
    [savedDraft],
  );
  const checkingSettings = firebaseQuery.isFetching || saveMutation.isPending;
  const settingsCurrent = !isLoadError && !checkingSettings;
  const serviceAccountSaved = settingsCurrent && firebaseQuery.data?.serviceAccount === MASKED_VALUE;
  const providerReady = !readinessQuery.isError && !readinessQuery.isFetching && isReady(readinessQuery.data?.push);
  const setupComplete = settingsCurrent && providerReady && savedBrowserConfigComplete;
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
            <Button type="button" variant="outline" disabled={retrying} onClick={() => void handleRetry()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      );
    }
    return (
      <SkeletonPage
        showHeader={false}
        sections={2}
        rowsPerSection={4}
        label="Loading Firebase settings"
      />
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

  function discardDraft() {
    setDraft(savedDraft);
    setRawPublicConfig("");
    setShowRawPaste(false);
  }

  return (
    <div className="max-w-5xl">
      <ContextualSaveBar
        // The bar stays up through the confirming read so the navigation guard
        // does not drop while the write is still settling.
        isDirty={dirty || saveMutation.isPending}
        saving={saveMutation.isPending}
        saveDisabled={!dirty || retrying}
        saveDisabledReason="Confirm the current settings before saving again."
        canSave={canManage}
        saveLabel="Save push settings"
        allowSamePathNavigation
        // The settings section picker is sticky on narrow widths.
        stickyClassName="sticky top-15 z-30 lg:top-0"
        onDiscard={discardDraft}
        onSave={handleSave}
      />
      <div className="space-y-6">
        {!canManage && (
          <Alert>
            <AlertDescription>
              Your role can review Firebase settings, but cannot change them.
            </AlertDescription>
          </Alert>
        )}

        {isLoadError && (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Firebase settings refresh unavailable</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>The saved settings could not be refreshed. Your values are preserved. Retry to confirm the current settings.</p>
              <Button type="button" variant="outline" disabled={saveMutation.isPending || retrying} onClick={() => void handleRetry()}>
                {retrying ? "Retrying…" : "Retry"}
              </Button>
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
              {checkingSettings || readinessQuery.isFetching ? "Checking push status…"
                : !settingsCurrent || readinessQuery.isError ? "Push status unavailable"
                : setupComplete ? "Push configured" : "Push setup incomplete"}
            </span>
            {dirty ? <StatusBadge tone="attention">Unsaved</StatusBadge> : null}
          </div>
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            <StatusBadge
              tone={readinessQuery.isFetching ? "neutral" : readinessQuery.isError ? "critical"
                : providerReady ? "success" : "attention"}
            >
              {readinessQuery.isFetching ? "Checking server…" : readinessQuery.isError ? "Server unavailable"
                : providerReady ? "Server configured" : "Server needs setup"}
            </StatusBadge>
            <StatusBadge
              tone={checkingSettings ? "neutral" : !settingsCurrent ? "critical"
                : savedBrowserConfigComplete ? "success" : "attention"}
            >
              {checkingSettings ? "Checking browser settings…" : !settingsCurrent ? "Browser status unavailable"
                : savedBrowserConfigComplete ? "Browser configured" : "Browser needs setup"}
            </StatusBadge>
          </div>
          {!providerReady ? (
            <div className="space-y-2 text-xs text-muted-foreground sm:basis-full">
              <p>{readinessQuery.isFetching ? "Checking provider status…" : readinessQuery.isError
                ? "Provider status could not be checked."
                : readinessQuery.data?.push?.issues[0]?.message ?? "Checking provider status…"}</p>
              {readinessQuery.isError && !isLoadError && (
                <Button type="button" variant="outline" disabled={saveMutation.isPending || retrying} onClick={() => void handleRetry()}>
                  {retrying ? "Retrying…" : "Retry"}
                </Button>
              )}
            </div>
          ) : null}
        </div>

        <SettingsSection
          title="Server credential"
          description="The service account the API uses to send push messages through Firebase."
          actions={serviceAccountSaved ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          ) : undefined}
        >
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="firebase-service-account">Service account JSON</Label>
              <Textarea
                id="firebase-service-account"
                value={draft.serviceAccount}
                disabled={!canEdit}
                spellCheck={false}
                autoComplete="off"
                placeholder='{ "type": "service_account", "project_id": "..." }'
                aria-describedby="firebase-service-account-help"
                className="min-h-40 font-mono text-xs"
                onChange={(event) => setDraft((current) => ({
                  ...current!,
                  serviceAccount: event.target.value,
                }))}
              />
              <InlineHelp id="firebase-service-account-help">
                {!settingsCurrent && draft.serviceAccount === MASKED_VALUE
                  ? checkingSettings ? "Checking saved credential status…" : "Saved credential status is unavailable. Retry to confirm it."
                  : serviceAccountSaved && draft.serviceAccount === MASKED_VALUE
                  ? "A credential is saved. Paste new JSON to replace it, or clear this field and save to remove it."
                  : draft.serviceAccount
                    ? "The new credential is validated before saving."
                    : "No dashboard credential will be stored."}
              </InlineHelp>
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
          </div>
        </SettingsSection>

        <SettingsSection
          title="Browser configuration"
          description="Values the storefront uses to register a browser for push."
          actions={<Smartphone className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
        >
          <div className="space-y-4">
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
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}
