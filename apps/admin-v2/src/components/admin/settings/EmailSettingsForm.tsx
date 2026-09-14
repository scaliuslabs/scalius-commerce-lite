import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  ExternalLink,
  KeyRound,
  Mail,
} from "lucide-react";
import { useEffect, useRef, useState, type SetStateAction } from "react";
import { isReady } from "@scalius/shared/readiness";
import { toast } from "sonner";

import { usePermissions } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { getServerFnError } from "~/lib/api-helpers";
import {
  getEmailSettings,
  type EmailSettingsPayload,
  type SettingsPayload,
  updateEmailSettings,
} from "~/lib/api-functions/settings";
import { queryKeys } from "~/lib/query-keys";
import { getSettingsLoadErrorMessage, mergeUneditedFields } from "~/hooks/use-settings-form";
import {
  ContextualSaveBar,
  FormCard,
  InlineHelp,
  SettingsSection,
  SkeletonPage,
  StatusBadge,
} from "../shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { OfficialProviderMark } from "./provider-marks";

const MASKED_VALUE = "••••••••••••";

interface EmailDraft {
  provider: "cloudflare" | "resend";
  apiKey: string;
  sender: string;
}

function toDraft(settings: EmailSettingsPayload): EmailDraft {
  return {
    provider: settings.provider,
    apiKey: settings.apiKey,
    sender: settings.sender,
  };
}

function draftsEqual(left: EmailDraft | null, right: EmailDraft | null): boolean {
  return Boolean(
    left
    && right
    && left.provider === right.provider
    && left.apiKey === right.apiKey
    && left.sender === right.sender,
  );
}

export default function EmailSettingsForm() {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const queryClient = useQueryClient();
  const {
    data,
    dataUpdatedAt,
    error: loadError,
    isError: isLoadError,
    isLoading,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: queryKeys.settings.email(),
    queryFn: getEmailSettings,
  });
  const dataUpdateCount = queryClient.getQueryState(queryKeys.settings.email())?.dataUpdateCount ?? 0;
  const [{ draft, savedDraft }, setEditor] = useState<{ draft: EmailDraft | null; savedDraft: EmailDraft | null }>({
    draft: null, savedDraft: null,
  });
  const [retrying, setRetrying] = useState(false);
  const commandInFlight = useRef(false);
  const ignoredReadUpdates = useRef(-1);
  function setDraft(next: SetStateAction<EmailDraft | null>) {
    setEditor((current) => ({
      ...current,
      draft: typeof next === "function" ? next(current.draft) : next,
    }));
  }
  const dirty = Boolean(draft && savedDraft && !draftsEqual(draft, savedDraft));

  useEffect(() => {
    if (!data || dataUpdateCount <= ignoredReadUpdates.current) return;
    const incoming = toDraft(data);
    setEditor((current) => ({
      draft: current.draft && current.savedDraft
        ? mergeUneditedFields(current.draft, current.savedDraft, incoming)
        : incoming,
      savedDraft: incoming,
    }));
  }, [data, dataUpdatedAt, dataUpdateCount]);

  const saveMutation = useMutation({
    mutationFn: async (nextDraft: EmailDraft) => {
      const payload: SettingsPayload = {
        provider: nextDraft.provider,
        sender: nextDraft.sender,
      };
      if (nextDraft.apiKey !== MASKED_VALUE) {
        payload.apiKey = nextDraft.apiKey;
      }
      return updateEmailSettings({ data: payload });
    },
    onSuccess: async (_response, saved) => {
      // Ignore pre-acknowledgment reads even if their React effect is still queued.
      ignoredReadUpdates.current = queryClient.getQueryState(queryKeys.settings.email())?.dataUpdateCount ?? 0;
      // A committed write is authoritative even if its confirming read fails.
      setEditor((current) => ({ draft: current.draft ?? saved, savedDraft: saved }));
      const [refreshed] = await Promise.all([
        refetch({ throwOnError: true }).then((result) => result.isSuccess, () => false),
        queryClient.invalidateQueries({ queryKey: queryKeys.settings.auth() }),
      ]);
      if (refreshed) toast.success("Email settings saved");
      else toast.warning("Email settings were saved, but the current settings could not be refreshed.");
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Email settings could not be saved"));
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
      await Promise.all([
        refetch(),
        queryClient.invalidateQueries({ queryKey: queryKeys.settings.auth() }),
      ]);
    } finally {
      commandInFlight.current = false;
      setRetrying(false);
    }
  };

  if (isLoading || !draft || !data) {
    if (isLoadError) {
      return (
        <Alert variant="destructive" className="max-w-2xl">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Email settings unavailable</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              {getSettingsLoadErrorMessage(
                loadError,
                "Email settings could not be loaded. Existing delivery settings were not changed.",
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
        rowsPerSection={3}
        label="Loading email delivery settings"
      />
    );
  }

  const provider = draft.provider;
  const canEdit = canManage && !saveMutation.isPending;
  const checkingSettings = isFetching || saveMutation.isPending;
  const settingsCurrent = !isLoadError && !checkingSettings;
  const unavailableStatus = checkingSettings ? "Checking status…" : "Status unavailable";
  const resendKeySaved = settingsCurrent && data.resendConfigured;
  const hasDraftResendKey = draft.apiKey !== "" && draft.apiKey !== MASKED_VALUE;
  const runtimeConfigured = settingsCurrent && isReady(data.readiness);

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
        saveLabel="Save email settings"
        allowSamePathNavigation
        // The settings section picker is sticky on narrow widths.
        stickyClassName="sticky top-15 z-30 lg:top-0"
        onDiscard={() => setDraft(savedDraft)}
        onSave={handleSave}
      />

      <div className="space-y-6">
        {!canManage && (
          <Alert>
            <AlertDescription>
              Your role can review email delivery settings, but cannot change them.
            </AlertDescription>
          </Alert>
        )}

        {isLoadError && (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Email settings refresh unavailable</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>The saved settings could not be refreshed. Your values are preserved. Retry to confirm the current settings.</p>
              <Button type="button" variant="outline" disabled={saveMutation.isPending || retrying} onClick={() => void handleRetry()}>
                {retrying ? "Retrying…" : "Retry"}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        <FormCard contentClassName="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex h-12 w-16 shrink-0 items-center justify-center rounded-md border bg-background/70">
            <OfficialProviderMark provider={provider} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">Transactional email</h3>
              <span
                title={runtimeConfigured
                  ? "Credentials and sender are configured; delivery has not been tested."
                  : undefined}
              >
                <StatusBadge
                  tone={!settingsCurrent ? "neutral" : runtimeConfigured ? "success" : "attention"}
                >
                  {!settingsCurrent ? unavailableStatus : runtimeConfigured ? "Configured" : "Setup incomplete"}
                </StatusBadge>
              </span>
              {dirty && <StatusBadge tone="attention">Unsaved changes</StatusBadge>}
            </div>
            {settingsCurrent && !runtimeConfigured ? (
              <InlineHelp className="mt-1">
                {data.readiness?.issues[0]?.message ?? "Add a sender and an available provider."}
              </InlineHelp>
            ) : null}
          </div>
        </FormCard>

        <SettingsSection
          title="Primary provider"
          description="The other configured provider is used as a fallback."
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              type="button"
              variant={provider === "cloudflare" ? "default" : "outline"}
              className="h-auto min-h-16 justify-start gap-3 py-3"
              aria-pressed={provider === "cloudflare"}
              disabled={!canEdit}
              onClick={() => setDraft((current) => ({ ...current!, provider: "cloudflare" }))}
            >
              <OfficialProviderMark provider="cloudflare" />
              <span className="flex flex-col items-start">
                <span>Cloudflare Email</span>
                <span className="text-xs font-normal opacity-80">
                  {!settingsCurrent ? unavailableStatus : data.cloudflareBindingConfigured ? "Binding available" : "Binding missing"}
                </span>
              </span>
            </Button>
            <Button
              type="button"
              variant={provider === "resend" ? "default" : "outline"}
              className="h-auto min-h-16 justify-start gap-3 py-3"
              aria-pressed={provider === "resend"}
              disabled={!canEdit}
              onClick={() => setDraft((current) => ({ ...current!, provider: "resend" }))}
            >
              <OfficialProviderMark provider="resend" />
              <span className="flex flex-col items-start">
                <span>Resend</span>
                <span className="text-xs font-normal opacity-80">
                  {!settingsCurrent ? unavailableStatus : resendKeySaved ? "API key saved" : "API key missing"}
                </span>
              </span>
            </Button>
          </div>
        </SettingsSection>

        {provider === "cloudflare" && (
          <SettingsSection
            title="Cloudflare Email"
            description="Sends through the Worker EMAIL binding, so no key is stored here."
            actions={settingsCurrent && data.cloudflareBindingConfigured ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            ) : undefined}
          >
            <div className="flex items-center gap-2 text-sm">
              <Cloud className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <span>
                Uses the Worker <code>EMAIL</code> binding.
              </span>
            </div>
            <Button variant="outline" asChild className="mt-3 min-h-11 w-full sm:w-auto">
              <a
                href="https://dash.cloudflare.com/?to=/:account/workers-and-pages/email"
                target="_blank"
                rel="noopener noreferrer"
              >
                Open Cloudflare Email <ExternalLink className="ml-2 h-4 w-4" />
              </a>
            </Button>
          </SettingsSection>
        )}

        {provider === "resend" && (
          <SettingsSection
            title="Resend API key"
            description="Create a sending key in Resend, then save it here."
            actions={resendKeySaved ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            ) : undefined}
          >
            <div className="space-y-1.5">
              <Label htmlFor="resend-api-key" className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                API key
              </Label>
              <Input
                id="resend-api-key"
                type="password"
                autoComplete="new-password"
                placeholder={settingsCurrent ? resendKeySaved ? MASKED_VALUE : "re_xxxxxxxxxxxx" : ""}
                value={draft.apiKey}
                disabled={!canEdit}
                aria-describedby="resend-api-key-help"
                onChange={(event) => setDraft((current) => ({
                  ...current!,
                  apiKey: event.target.value,
                }))}
                className="h-11 font-mono sm:h-9"
              />
              <InlineHelp id="resend-api-key-help">
                {!settingsCurrent && draft.apiKey === MASKED_VALUE
                  ? checkingSettings ? "Checking saved key status…" : "Saved key status is unavailable. Retry to confirm it."
                  : hasDraftResendKey
                  ? "A new key will replace the saved key."
                  : resendKeySaved
                    ? "A key is saved. Clear this field and save to remove it."
                    : "No key is saved."}
              </InlineHelp>
            </div>
            <Button variant="outline" asChild className="mt-3 min-h-11 w-full sm:w-auto">
              <a
                href="https://resend.com/api-keys"
                target="_blank"
                rel="noopener noreferrer"
              >
                Manage Resend keys <ExternalLink className="ml-2 h-4 w-4" />
              </a>
            </Button>
          </SettingsSection>
        )}

        <SettingsSection
          title="Sender address"
          description="Every transactional email is sent from this address. Verify the domain with each provider you use."
        >
          <div className="space-y-1.5">
            <Label htmlFor="email-sender" className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              Email address
            </Label>
            <Input
              id="email-sender"
              type="email"
              autoComplete="email"
              placeholder="noreply@yourdomain.com"
              value={draft.sender}
              disabled={!canEdit}
              onChange={(event) => setDraft((current) => ({
                ...current!,
                sender: event.target.value,
              }))}
              className="h-11 sm:h-9"
            />
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}
