import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  ExternalLink,
  KeyRound,
  Loader2,
  Mail,
  RotateCcw,
  Save,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { usePermissions } from "@/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "@/lib/admin-permissions";
import { getServerFnError } from "@/lib/api-helpers";
import {
  getEmailSettings,
  type EmailSettingsPayload,
  type SettingsPayload,
  updateEmailSettings,
} from "@/lib/api-functions/settings";
import { queryKeys } from "@/lib/query-keys";
import { getSettingsLoadErrorMessage } from "@/hooks/use-settings-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UnsavedChangesGuard } from "../shared/UnsavedChangesGuard";
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
    error: loadError,
    isError: isLoadError,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: queryKeys.settings.email(),
    queryFn: getEmailSettings,
  });
  const [draft, setDraft] = useState<EmailDraft | null>(null);
  const [savedDraft, setSavedDraft] = useState<EmailDraft | null>(null);
  const dirty = Boolean(draft && savedDraft && !draftsEqual(draft, savedDraft));

  useEffect(() => {
    if (!data || dirty) return;
    const nextDraft = toDraft(data);
    setDraft(nextDraft);
    setSavedDraft(nextDraft);
  }, [data, dirty]);

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
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings.email() });
      const refreshed = queryClient.getQueryData<EmailSettingsPayload>(
        queryKeys.settings.email(),
      );
      const nextDraft = refreshed ? toDraft(refreshed) : saved;
      setDraft(nextDraft);
      setSavedDraft(nextDraft);
      toast.success("Email settings saved");
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Email settings could not be saved"));
    },
  });

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
            <Button type="button" variant="outline" onClick={() => void refetch()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      );
    }
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const provider = draft.provider;
  const canEdit = canManage && !saveMutation.isPending;
  const resendKeySaved = data.resendConfigured;
  const hasDraftResendKey = draft.apiKey !== "" && draft.apiKey !== MASKED_VALUE;
  const runtimeConfigured = data.ready;

  return (
    <>
      <UnsavedChangesGuard isDirty={dirty} isSubmitting={saveMutation.isPending} />
      <div className="max-w-2xl space-y-5 pb-24">
        {!canManage && (
          <Alert>
            <AlertDescription>
              Your role can review email delivery settings, but cannot change them.
            </AlertDescription>
          </Alert>
        )}

        <Card>
          <CardContent className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center">
            <div className="flex h-12 w-16 shrink-0 items-center justify-center rounded-md border bg-background/70">
              <OfficialProviderMark provider={provider} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">Transactional email</h3>
                <Badge variant={runtimeConfigured ? "default" : "secondary"}>
                  {runtimeConfigured ? "Runtime configured" : "Setup incomplete"}
                </Badge>
                {dirty && <Badge variant="outline">Unsaved changes</Badge>}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {runtimeConfigured
                  ? "A valid sender and at least one provider are available. This does not confirm a successful delivery."
                  : data.readinessError ?? "Add a sender and an available provider to enable email delivery."}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Primary provider</CardTitle>
            <CardDescription>
              The other configured provider is used automatically if the primary is unavailable.
            </CardDescription>
          </CardHeader>
          <CardContent>
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
                    {data.cloudflareBindingConfigured ? "Binding available" : "Binding missing"}
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
                    {resendKeySaved ? "API key saved" : "API key missing"}
                  </span>
                </span>
              </Button>
            </div>
          </CardContent>
        </Card>

        {provider === "cloudflare" && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Cloud className="h-4 w-4" />
                Cloudflare Email
                {data.cloudflareBindingConfigured && (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                )}
              </CardTitle>
              <CardDescription>
                Uses the Worker <code>EMAIL</code> binding. Sender-domain onboarding stays in Cloudflare.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" asChild className="min-h-11 w-full sm:w-auto">
                <a
                  href="https://dash.cloudflare.com/?to=/:account/workers-and-pages/email"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open Cloudflare Email <ExternalLink className="ml-2 h-4 w-4" />
                </a>
              </Button>
            </CardContent>
          </Card>
        )}

        {provider === "resend" && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <KeyRound className="h-4 w-4" />
                Resend API key
                {resendKeySaved && (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                )}
              </CardTitle>
              <CardDescription>
                Create a sending key in Resend, then save it here.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="resend-api-key">API key</Label>
                <Input
                  id="resend-api-key"
                  type="password"
                  autoComplete="new-password"
                  placeholder={resendKeySaved ? MASKED_VALUE : "re_xxxxxxxxxxxx"}
                  value={draft.apiKey}
                  disabled={!canEdit}
                  onChange={(event) => setDraft((current) => ({
                    ...current!,
                    apiKey: event.target.value,
                  }))}
                  className="h-11 font-mono sm:h-9"
                />
                <p className="text-xs text-muted-foreground">
                  {hasDraftResendKey
                    ? "A new key will replace the saved key."
                    : resendKeySaved
                      ? "A key is saved. Clear this field and save to remove it."
                      : "No key is saved."}
                </p>
              </div>
              <Button variant="outline" asChild className="min-h-11 w-full sm:w-auto">
                <a
                  href="https://resend.com/api-keys"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Manage Resend keys <ExternalLink className="ml-2 h-4 w-4" />
                </a>
              </Button>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Mail className="h-4 w-4" />
              Sender address
            </CardTitle>
            <CardDescription>
              The From address on transactional email. Verify its domain with each provider you use.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            <Label htmlFor="email-sender">Email address</Label>
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
          </CardContent>
        </Card>

        <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            disabled={!canEdit || !dirty}
            onClick={() => setDraft(savedDraft)}
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset
          </Button>
          <Button
            type="button"
            className="min-h-11 sm:min-h-9 sm:min-w-32"
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
