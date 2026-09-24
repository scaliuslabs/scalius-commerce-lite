import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Code2, Loader2, ShieldCheck } from "lucide-react";
import {
  deleteApiV1AdminAnalyticsById,
  deleteApiV1AdminAnalyticsByIdPermanent,
  deleteApiV1AdminFraudCheckerById,
  getApiV1AdminAnalytics,
  getApiV1AdminAnalyticsByIdSource,
  getApiV1AdminSettingsMetaConversions,
  getApiV1AdminSettingsMetaConversionsLogs,
  postApiV1AdminAnalytics,
  postApiV1AdminAnalyticsByIdToggle,
  postApiV1AdminAuthScannerLink,
  postApiV1AdminFraudChecker,
  postApiV1AdminSettingsMetaConversions,
  putApiV1AdminAnalyticsById,
  putApiV1AdminFraudChecker,
} from "@scalius/api-client/sdk";
import {
  FRAUD_CHECK_PROVIDER_TYPES,
  getFraudCheckProviderDefinition,
  type FraudCheckProviderType,
} from "@scalius/core/modules/fraud-checker/provider";
import { readQuotedHtmlAttribute } from "@scalius/shared/html-attributes";
import { SCANNER_TOKEN_TTL_SECONDS } from "@scalius/shared/scanner-auth";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { usePermissions } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { analyticsScriptTypes, type AnalyticsScriptType } from "~/lib/analytics-script-types";
import { apiData, type ApiResult } from "~/lib/api";
import {
  fraudCheckerProvidersQueryOptions,
  type FraudCheckerProvider,
} from "~/lib/api-query-options/fraud-checker";
import { withDashboardBasePath } from "~/lib/dashboard-base-path";
import { analyticsFormSchema } from "~/lib/form-schemas";
import { queryKeys } from "~/lib/query-keys";
import { formatDateTime, useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { appsMessages } from "~/i18n/settings-apps";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useSaveBar } from "../shared/SaveBar";
import { OfficialProviderMark, type ProviderMarkId } from "./provider-marks";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { SettingsCard, SettingsCardLoading, SettingsDialog, SettingsField, SettingsRow } from "./SettingsPage";

/** Saved secrets come back masked; sending the mask back keeps them. */
const MASKED_VALUE = "••••••••••••";

type AppsMessage = keyof (typeof appsMessages)["en"];

function Mark({ provider, fallback }: { provider?: ProviderMarkId; fallback: ReactNode }) {
  return provider ? (
    <OfficialProviderMark provider={provider} size="sm" />
  ) : (
    <span className="grid size-6 shrink-0 place-items-center text-muted-foreground" aria-hidden="true">
      {fallback}
    </span>
  );
}

function MarkLabel({ mark, children }: { mark: ReactNode; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      {mark}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Clears a masked secret on focus so the merchant types a new one. */
function secretInputProps(value: string, onChange: (value: string) => void) {
  return {
    value,
    autoComplete: "off",
    onFocus: () => value === MASKED_VALUE && onChange(""),
    onChange: (event: { target: { value: string } }) => onChange(event.target.value),
  };
}

// ── Tracking ─────────────────────────────────────────────────────────────

type ScriptSummary = ApiResult<typeof getApiV1AdminAnalytics>["scripts"][number];
type ScriptSource = ApiResult<typeof getApiV1AdminAnalyticsByIdSource>;
type Placement = "head" | "body_start" | "body_end";

const TRACKING_PARAMS = { page: 1, limit: 100, sort: "name", order: "asc", trashed: "false" } as const;
export const trackingQuery = {
  queryKey: queryKeys.analytics.list(TRACKING_PARAMS),
  queryFn: () => apiData(getApiV1AdminAnalytics({ query: TRACKING_PARAMS })),
};

const SCRIPT_MARKS: Partial<Record<string, ProviderMarkId>> = {
  google_analytics: "google-analytics",
  google_tag_manager: "google-tag-manager",
  facebook_pixel: "meta",
  tiktok_pixel: "tiktok",
  cloudflare_web_analytics: "cloudflare",
};
const PLACEMENTS: readonly Placement[] = ["head", "body_start", "body_end"];

function scriptType(type: string): AnalyticsScriptType {
  return analyticsScriptTypes.includes(type as AnalyticsScriptType) ? (type as AnalyticsScriptType) : "custom";
}

function ScriptMark({ type }: { type: string }) {
  return <Mark provider={SCRIPT_MARKS[type]} fallback={<Code2 className="size-4" />} />;
}

/** Cloudflare scripts are stored as the beacon tag; the merchant edits the token. */
function editableConfig(type: AnalyticsScriptType, config: string): string {
  if (type !== "cloudflare_web_analytics") return config;
  const beacon = readQuotedHtmlAttribute(config, "data-cf-beacon");
  try {
    const token = beacon ? (JSON.parse(beacon) as { token?: unknown }).token : undefined;
    return typeof token === "string" ? token : config;
  } catch {
    return config;
  }
}

interface ScriptDraft {
  name: string;
  type: AnalyticsScriptType;
  config: string;
  location: Placement;
  isActive: boolean;
  allowDuplicateProvider: boolean;
}

function ScriptForm({ script, scripts }: { script: ScriptSource | null; scripts: readonly ScriptSummary[] }) {
  const t = useMessages(appsMessages);
  const common = useMessages(settingsMessages);
  const queryClient = useQueryClient();
  const { hasPermission } = usePermissions();
  const canSave = hasPermission(script ? ADMIN_PERMISSIONS.ANALYTICS_EDIT : ADMIN_PERMISSIONS.ANALYTICS_CREATE);
  const canToggle = hasPermission(ADMIN_PERMISSIONS.ANALYTICS_TOGGLE);
  const [saved] = useState<ScriptDraft>(() => {
    if (!script) {
      return {
        name: t("cloudflare_web_analytics"),
        type: "cloudflare_web_analytics",
        config: "",
        location: "body_end",
        isActive: false,
        allowDuplicateProvider: false,
      };
    }
    const type = scriptType(script.type);
    return {
      name: script.name,
      type,
      config: editableConfig(type, script.config),
      location: PLACEMENTS.includes(script.location as Placement) ? (script.location as Placement) : "head",
      isActive: script.isActive,
      allowDuplicateProvider: false,
    };
  });
  const [draft, setDraft] = useState(saved);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const set = <K extends keyof ScriptDraft>(key: K, value: ScriptDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const isCloudflare = draft.type === "cloudflare_web_analytics";
  const isCustom = draft.type === "custom";
  // Custom code keeps its saved choice; the API decides for every named service.
  const usePartytown = isCloudflare ? false : isCustom ? (script?.usePartytown ?? true) : true;
  const parsed = analyticsFormSchema.safeParse({ ...draft, usePartytown });
  const issue = (field: "name" | "config") =>
    !parsed.success && parsed.error.issues.some((entry) => entry.path[0] === field);
  const duplicate = !script && draft.isActive && !isCustom &&
    scripts.some((other) => other.type === draft.type && other.isActive);
  const service = t(draft.type);

  const save = useMutation({
    mutationFn: (): Promise<unknown> => {
      const body = {
        name: draft.name.trim(),
        type: draft.type,
        config: draft.config.trim(),
        location: draft.location,
        isActive: draft.isActive,
        usePartytown,
        allowDuplicateProvider: duplicate && draft.allowDuplicateProvider,
      };
      return script
        ? apiData(putApiV1AdminAnalyticsById({
            path: { id: script.id },
            body: { ...body, id: script.id, expectedRevision: script.revision },
          }))
        : apiData(postApiV1AdminAnalytics({ body }));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.analytics.all }),
  });
  const remove = useMutation({
    mutationFn: async () => {
      // Trash, then delete for good: nothing on this page restores from trash.
      const trashed = await apiData(deleteApiV1AdminAnalyticsById({
        path: { id: script!.id },
        body: { expectedRevision: script!.revision },
      }));
      await apiData(deleteApiV1AdminAnalyticsByIdPermanent({
        path: { id: script!.id },
        body: { expectedRevision: trashed.revision },
      }));
    },
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: queryKeys.analytics.detail(script!.id) });
      toast.success(t("trackingDeleted"));
      await queryClient.invalidateQueries({ queryKey: queryKeys.analytics.list() });
    },
    onError: () => {
      toast.error(t("deleteFailed"));
      void queryClient.invalidateQueries({ queryKey: queryKeys.analytics.list() });
    },
  });
  useSaveBar({
    dirty,
    saving: save.isPending,
    invalid: !canSave || !parsed.success || (duplicate && !draft.allowDuplicateProvider),
    save: () => save.mutateAsync(),
    discard: () => setDraft(saved),
  });

  const changeType = (type: AnalyticsScriptType) =>
    setDraft((current) => ({
      ...current,
      type,
      name: !current.name.trim() || current.name === t(current.type) ? t(type) : current.name,
      location: type === "cloudflare_web_analytics" ? "body_end" : "head",
    }));

  return (
    <>
      {script ? null : (
        <SettingsField id="tracking-service" label={t("service")}>
          <NativeSelect id="tracking-service" value={draft.type} onValueChange={(value) => changeType(value as AnalyticsScriptType)}>
            {analyticsScriptTypes.map((type) => (
              <option key={type} value={type}>{t(type)}</option>
            ))}
          </NativeSelect>
        </SettingsField>
      )}
      <SettingsField
        id="tracking-name"
        label={t("name")}
        help={t("nameHelp")}
        error={dirty && issue("name") ? t("nameTooShort") : null}
      >
        <Input
          id="tracking-name"
          value={draft.name}
          aria-invalid={dirty && issue("name")}
          aria-describedby="tracking-name-note"
          onChange={(event) => set("name", event.target.value)}
        />
      </SettingsField>
      <SettingsField
        id="tracking-code"
        label={isCloudflare ? t("cloudflareToken") : t("trackingCode")}
        help={isCloudflare ? t("cloudflareHelp") : isCustom ? t("customHelp") : t("codeHelp", { service })}
        error={dirty && issue("config") ? (draft.config.trim() ? t("codeSample") : t("codeRequired")) : null}
      >
        {isCloudflare ? (
          <Input
            id="tracking-code"
            autoComplete="off"
            spellCheck={false}
            value={draft.config}
            aria-invalid={dirty && issue("config")}
            aria-describedby="tracking-code-note"
            onChange={(event) => set("config", event.target.value)}
          />
        ) : (
          <Textarea
            id="tracking-code"
            rows={8}
            spellCheck={false}
            value={draft.config}
            aria-invalid={dirty && issue("config")}
            aria-describedby="tracking-code-note"
            onChange={(event) => set("config", event.target.value)}
          />
        )}
      </SettingsField>
      {isCustom ? (
        <SettingsField id="tracking-placement" label={t("placement")}>
          <NativeSelect id="tracking-placement" value={draft.location} onValueChange={(value) => set("location", value as Placement)}>
            {PLACEMENTS.map((placement) => (
              <option key={placement} value={placement}>{t(placement)}</option>
            ))}
          </NativeSelect>
        </SettingsField>
      ) : null}
      {!script && canToggle ? (
        <label className="flex min-h-11 items-center justify-between gap-4 text-body font-medium">
          {t("turnOnNow")}
          <Switch checked={draft.isActive} onCheckedChange={(on) => set("isActive", on)} />
        </label>
      ) : null}
      {duplicate ? (
        <SettingsField id="tracking-keep-both" label={t("keepBoth", { service })} help={t("keepOne")}>
          <Checkbox
            id="tracking-keep-both"
            checked={draft.allowDuplicateProvider}
            aria-describedby="tracking-keep-both-note"
            onCheckedChange={(checked) => set("allowDuplicateProvider", checked === true)}
          />
        </SettingsField>
      ) : null}
      {script && canSave ? (
        <>
          <div>
            <Button type="button" variant="ghost" onClick={() => setConfirmDelete(true)}>
              {t("deleteTracking")}
            </Button>
          </div>
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={common("deleteNamed", { name: script.name })}
            description={t("deleteTrackingConfirm", { name: script.name })}
            confirmLabel={common("delete")}
            cancelLabel={common("cancel")}
            isLoading={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        </>
      ) : null}
    </>
  );
}

/** Reading a script's code needs edit access, so it loads when the dialog opens. */
function EditScript({ id, scripts }: { id: string; scripts: readonly ScriptSummary[] }) {
  const t = useMessages(appsMessages);
  const { data, isError, refetch } = useQuery({
    queryKey: queryKeys.analytics.detail(id),
    queryFn: () => apiData(getApiV1AdminAnalyticsByIdSource({ path: { id } })),
    staleTime: 0,
  });
  if (isError) return <SettingsLoadFailure title={t("trackingTitle")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;
  return <ScriptForm key={data.revision} script={data} scripts={scripts} />;
}

function TrackingCardBody() {
  const t = useMessages(appsMessages);
  const queryClient = useQueryClient();
  const { hasPermission } = usePermissions();
  const canCreate = hasPermission(ADMIN_PERMISSIONS.ANALYTICS_CREATE);
  const canEdit = hasPermission(ADMIN_PERMISSIONS.ANALYTICS_EDIT);
  const canToggle = hasPermission(ADMIN_PERMISSIONS.ANALYTICS_TOGGLE);
  const { data, isError, refetch } = useQuery(trackingQuery);
  const scripts = data?.scripts ?? [];

  // Row switches are page drafts, saved by the page save bar.
  const [switched, setSwitched] = useState<Record<string, boolean>>({});
  const [keepBoth, setKeepBoth] = useState(false);
  const isOn = (script: ScriptSummary) => switched[script.id] ?? script.isActive;
  const changed = scripts.filter((script) => isOn(script) !== script.isActive);
  const duplicateTypes = [
    ...new Set(
      changed
        .filter((script) =>
          isOn(script) &&
          script.type !== "custom" &&
          scripts.some((other) => other.id !== script.id && other.type === script.type && isOn(other)))
        .map((script) => script.type),
    ),
  ];
  const discard = () => {
    setSwitched({});
    setKeepBoth(false);
  };
  const toggle = useMutation({
    mutationFn: async () => {
      // Turn scripts off first so swapping one for another never overlaps.
      const ordered = [...changed].sort((a, b) => Number(isOn(a)) - Number(isOn(b)));
      for (const script of ordered) {
        try {
          await apiData(postApiV1AdminAnalyticsByIdToggle({
            path: { id: script.id },
            body: { isActive: isOn(script), expectedRevision: script.revision, allowDuplicateProvider: keepBoth },
          }));
        } catch (error) {
          toast.error(t("switchFailed", { name: script.name }));
          throw error;
        }
      }
    },
    onSuccess: discard,
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.analytics.all }),
  });
  useSaveBar({
    dirty: changed.length > 0,
    saving: toggle.isPending,
    invalid: !canToggle || (duplicateTypes.length > 0 && !keepBoth),
    save: () => toggle.mutateAsync(),
    discard,
  });

  if (isError) return <SettingsLoadFailure title={t("trackingTitle")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;
  return (
    <SettingsCard id="tracking"
      title={t("trackingTitle")}
      description={t("trackingDescription")}
      action={
        <SettingsDialog
          title={t("addTracking")}
          trigger={<Button type="button" variant="outline" size="sm" disabled={!canCreate}>{t("addTracking")}</Button>}
        >
          <ScriptForm script={null} scripts={scripts} />
        </SettingsDialog>
      }
      rows={
        scripts.length
          ? scripts.map((script) => (
              <div key={script.id} className="flex items-center border-t border-border first:border-t-0">
                <SettingsDialog
                  title={t("editTracking", { name: script.name })}
                  trigger={
                    <SettingsRow
                      disabled={!canEdit}
                      label={<MarkLabel mark={<ScriptMark type={script.type} />}>{script.name}</MarkLabel>}
                      value={script.configIssue
                        ? `${t(scriptType(script.type))} · ${t("needsRealId")}`
                        : t(scriptType(script.type))}
                    />
                  }
                >
                  <EditScript id={script.id} scripts={scripts} />
                </SettingsDialog>
                <Switch
                  className="mr-6"
                  checked={isOn(script)}
                  disabled={!canToggle || (!script.isActive && Boolean(script.configIssue))}
                  aria-label={t("switchLabel", { name: script.name })}
                  onCheckedChange={(on) => setSwitched((current) => ({ ...current, [script.id]: on }))}
                />
              </div>
            ))
          : null
      }
    >
      {duplicateTypes.length ? (
        <SettingsField
          id="tracking-keep-both-rows"
          label={t("keepBoth", { service: duplicateTypes.map((type) => t(scriptType(type))).join(", ") })}
          help={t("keepOne")}
        >
          <Checkbox
            id="tracking-keep-both-rows"
            checked={keepBoth}
            aria-describedby="tracking-keep-both-rows-note"
            onCheckedChange={(checked) => setKeepBoth(checked === true)}
          />
        </SettingsField>
      ) : null}
    </SettingsCard>
  );
}

export function TrackingCard() {
  const { hasPermission } = usePermissions();
  return hasPermission(ADMIN_PERMISSIONS.ANALYTICS_VIEW) ? <TrackingCardBody /> : null;
}

// ── Facebook & Instagram ────────────────────────────────────────────────

type MetaLog = ApiResult<typeof getApiV1AdminSettingsMetaConversionsLogs>["logs"][number];

export const metaQuery = {
  queryKey: queryKeys.settings.metaConversions(),
  queryFn: () => apiData(getApiV1AdminSettingsMetaConversions()),
};
const EVENTS_PARAMS = { page: 1, limit: 20 } as const;

interface MetaDraft {
  pixelId: string;
  accessToken: string;
  testEventCode: string;
  isEnabled: boolean;
}

/** The connection form's copy of the Meta settings, with the revision a save sends back. */
const metaConnectionQuery = {
  queryKey: [...metaQuery.queryKey, "connection"],
  queryFn: async () => {
    const { settings, revision } = await metaQuery.queryFn();
    return {
      pixelId: settings?.pixelId ?? "",
      accessToken: settings?.accessToken ?? "",
      testEventCode: settings?.testEventCode ?? "",
      isEnabled: settings?.isEnabled ?? false,
      revision,
    };
  },
};

function MetaConnectionFields({ canEdit }: { canEdit: boolean }) {
  const t = useMessages(appsMessages);
  const common = useMessages(settingsMessages);
  const { values: draft, setValue: set, isLoaded } = useSettingsForm<MetaDraft>({
    queryKey: metaConnectionQuery.queryKey,
    fetchFn: metaConnectionQuery.queryFn,
    // A secret still showing its mask is left out, so the saved one stays.
    saveFn: (values, expectedRevision) =>
      apiData(postApiV1AdminSettingsMetaConversions({
        body: {
          pixelId: values.pixelId.trim(),
          isEnabled: values.isEnabled,
          ...(values.accessToken !== MASKED_VALUE ? { accessToken: values.accessToken.trim() } : {}),
          ...(values.testEventCode !== MASKED_VALUE ? { testEventCode: values.testEventCode.trim() } : {}),
          expectedRevision,
        },
      })),
    invalidateQueryKeys: [metaQuery.queryKey],
    defaultValues: { pixelId: "", accessToken: "", testEventCode: "", isEnabled: false },
    errorMessage: common("saveFailed"),
    canEdit,
    isValid: (values) => !values.isEnabled || Boolean(values.pixelId.trim() && values.accessToken.trim()),
    fields: { pixelId: "meta-pixel", accessToken: "meta-token", testEventCode: "meta-test-code" },
  });
  if (!isLoaded) return <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" aria-hidden="true" />;
  const missing = draft.isEnabled && (!draft.pixelId.trim() || !draft.accessToken.trim());
  return (
    <>
      <SettingsField id="meta-pixel" label={t("pixelId")} help={t("pixelHelp")}>
        <Input
          id="meta-pixel"
          inputMode="numeric"
          autoComplete="off"
          value={draft.pixelId}
          aria-describedby="meta-pixel-note"
          onChange={(event) => set("pixelId", event.target.value)}
        />
      </SettingsField>
      <SettingsField
        id="meta-token"
        label={t("accessToken")}
        help={draft.accessToken === MASKED_VALUE ? t("secretSaved") : undefined}
      >
        <Input
          id="meta-token"
          type="password"
          aria-describedby="meta-token-note"
          {...secretInputProps(draft.accessToken, (value) => set("accessToken", value))}
        />
      </SettingsField>
      <SettingsField
        id="meta-test-code"
        label={`${t("testCode")} (${common("optional")})`}
        help={draft.testEventCode === MASKED_VALUE ? t("secretSaved") : t("testCodeHelp")}
      >
        <Input
          id="meta-test-code"
          aria-describedby="meta-test-code-note"
          {...secretInputProps(draft.testEventCode, (value) => set("testEventCode", value))}
        />
      </SettingsField>
      <label className="flex min-h-11 items-center justify-between gap-4 text-body font-medium">
        {t("sendToMeta")}
        <Switch checked={draft.isEnabled} onCheckedChange={(on) => set("isEnabled", on)} />
      </label>
      {missing ? <p role="alert" className="text-body text-destructive">{t("needsPixelAndToken")}</p> : null}
    </>
  );
}

function toDate(value: MetaLog["createdAt"]): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function RecentEvents() {
  const t = useMessages(appsMessages);
  const { data, isError, refetch } = useQuery({
    queryKey: queryKeys.settings.metaConversionsLogs(EVENTS_PARAMS),
    queryFn: () => apiData(getApiV1AdminSettingsMetaConversionsLogs({ query: EVENTS_PARAMS })),
    staleTime: 0,
  });
  if (isError) return <SettingsLoadFailure title={t("recentEvents")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;
  if (!data.logs.length) return <p className="text-body text-muted-foreground">{t("noEvents")}</p>;
  return (
    <ul className="max-h-96 divide-y divide-border overflow-y-auto">
      {data.logs.map((log) => {
        const time = toDate(log.createdAt);
        return (
          <li key={log.id} className="flex min-h-11 items-center gap-3 py-2 text-body">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{log.eventName ?? t("event")}</span>
              {time ? (
                <span className="block text-muted-foreground">
                  {formatDateTime(time, { dateStyle: "medium", timeStyle: "short" })}
                </span>
              ) : null}
            </span>
            <Badge variant={log.status === "success" ? "secondary" : "destructive"}>
              {log.status === "success" ? t("sent") : t("failed")}
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}

function FacebookCardBody() {
  const t = useMessages(appsMessages);
  const common = useMessages(settingsMessages);
  const canEdit = usePermissions().hasPermission(ADMIN_PERMISSIONS.ANALYTICS_EDIT);
  const { data, isError, refetch } = useQuery(metaQuery);
  if (isError) return <SettingsLoadFailure title={t("facebookTitle")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;
  const settings = data.settings;
  const status = settings?.isEnabled && settings.pixelId
    ? t("connectionOn", { pixel: settings.pixelId })
    : settings?.pixelId || settings?.accessToken
      ? common("off")
      : t("notSetUp");
  return (
    <SettingsCard id="facebook"
      title={
        <span className="flex items-center gap-3">
          <OfficialProviderMark provider="meta" size="sm" />
          {t("facebookTitle")}
        </span>
      }
      description={t("facebookDescription")}
      rows={
        <>
          <SettingsDialog
            title={t("connection")}
            trigger={<SettingsRow label={t("connection")} value={status} disabled={!canEdit} />}
          >
            <MetaConnectionFields canEdit={canEdit} />
          </SettingsDialog>
          <Dialog>
            <DialogTrigger asChild>
              <SettingsRow label={t("recentEvents")} value={t("recentEventsValue")} />
            </DialogTrigger>
            <DialogContent className="sm:max-w-xl">
              <DialogHeader>
                <DialogTitle>{t("recentEvents")}</DialogTitle>
              </DialogHeader>
              <RecentEvents />
            </DialogContent>
          </Dialog>
        </>
      }
    />
  );
}

export function FacebookCard() {
  const { hasPermission } = usePermissions();
  return hasPermission(ADMIN_PERMISSIONS.ANALYTICS_VIEW) ? <FacebookCardBody /> : null;
}

// ── Courier fraud check ─────────────────────────────────────────────────

type FraudField = "apiKey" | "apiSecret" | "userId";

/** Named checkers first; a custom checker last. */
const FRAUD_ORDER: readonly FraudCheckProviderType[] = ["fraudbd", "fraudguard", "ecourier", "default"];
const FRAUD_MARKS: Partial<Record<FraudCheckProviderType, ProviderMarkId>> = { fraudbd: "fraudbd", ecourier: "ecourier" };
const FRAUD_FIELD_LABELS: Record<FraudCheckProviderType, Record<FraudField, AppsMessage>> = {
  default: { apiKey: "accessKey", apiSecret: "apiSecret", userId: "userId" },
  fraudbd: { apiKey: "apiKey", apiSecret: "password", userId: "username" },
  fraudguard: { apiKey: "apiKey", apiSecret: "apiSecret", userId: "userId" },
  ecourier: { apiKey: "apiKey", apiSecret: "apiSecret", userId: "userId" },
};

function fraudType(provider: FraudCheckerProvider | null, fallback: FraudCheckProviderType): FraudCheckProviderType {
  return provider?.providerType ?? fallback;
}

interface FraudDraft {
  apiUrl: string;
  apiKey: string;
  apiSecret: string;
  userId: string;
  isActive: boolean;
}

function FraudProviderForm({
  type,
  provider,
  name,
}: {
  type: FraudCheckProviderType;
  provider: FraudCheckerProvider | null;
  name: string;
}) {
  const t = useMessages(appsMessages);
  const common = useMessages(settingsMessages);
  const queryClient = useQueryClient();
  const canEdit = usePermissions().hasPermission(ADMIN_PERMISSIONS.SETTINGS_FRAUD_CHECKER_EDIT);
  const definition = getFraudCheckProviderDefinition(type);
  const fields = definition.requiredFields;
  const [saved] = useState<FraudDraft>(() => ({
    apiUrl: provider?.apiUrl || definition.defaultApiUrl,
    apiKey: provider?.apiKey ?? "",
    apiSecret: provider?.apiSecret ?? "",
    userId: provider?.userId ?? "",
    isActive: provider?.isActive ?? true,
  }));
  const [draft, setDraft] = useState(saved);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const set = <K extends keyof FraudDraft>(key: K, value: FraudDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const blank = (field: FraudField | "apiUrl") => !draft[field].trim();
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.fraudChecker.all });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: provider?.name || name,
        providerType: type,
        apiUrl: draft.apiUrl.trim(),
        apiKey: draft.apiKey.trim(),
        ...(fields.includes("apiSecret") ? { apiSecret: draft.apiSecret.trim() } : {}),
        ...(fields.includes("userId") ? { userId: draft.userId.trim() } : {}),
        isActive: draft.isActive,
      };
      return provider
        ? apiData(putApiV1AdminFraudChecker({ body: { ...body, id: provider.id } }))
        : apiData(postApiV1AdminFraudChecker({ body }));
    },
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => apiData(deleteApiV1AdminFraudCheckerById({ path: { id: provider!.id } })),
    onSuccess: async () => {
      toast.success(t("providerRemoved", { name }));
      await refresh();
    },
    onError: () => toast.error(t("removeFailed")),
  });
  useSaveBar({
    dirty,
    saving: save.isPending,
    invalid: !canEdit || blank("apiUrl") || fields.some(blank),
    save: () => save.mutateAsync(),
    discard: () => setDraft(saved),
  });

  return (
    <>
      {type === "default" ? (
        <SettingsField
          id="fraud-address"
          label={t("address")}
          help={t("addressHelp")}
          error={dirty && blank("apiUrl") ? t("fieldRequired") : null}
        >
          <Input
            id="fraud-address"
            type="url"
            inputMode="url"
            value={draft.apiUrl}
            aria-describedby="fraud-address-note"
            onChange={(event) => set("apiUrl", event.target.value)}
          />
        </SettingsField>
      ) : null}
      {fields.map((field) => {
        const id = `fraud-${field}`;
        const value = draft[field];
        return (
          <SettingsField
            key={field}
            id={id}
            label={t(FRAUD_FIELD_LABELS[type][field])}
            help={value === MASKED_VALUE ? t("secretSaved") : undefined}
            error={dirty && blank(field) ? t("fieldRequired") : null}
          >
            <Input
              id={id}
              type={field === "userId" ? "text" : "password"}
              aria-invalid={dirty && blank(field)}
              aria-describedby={`${id}-note`}
              {...secretInputProps(value, (next) => set(field, next))}
            />
          </SettingsField>
        );
      })}
      <label className="flex min-h-11 items-center justify-between gap-4 text-body font-medium">
        {t("useOnOrders")}
        <Switch checked={draft.isActive} onCheckedChange={(on) => set("isActive", on)} />
      </label>
      {provider && canEdit ? (
        <>
          <div>
            <Button type="button" variant="ghost" onClick={() => setConfirmRemove(true)}>
              {t("removeProvider", { name })}
            </Button>
          </div>
          <ConfirmDialog
            open={confirmRemove}
            onOpenChange={setConfirmRemove}
            title={t("removeProvider", { name })}
            description={t("removeConfirm", { name })}
            confirmLabel={common("remove")}
            cancelLabel={common("cancel")}
            isLoading={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        </>
      ) : null}
    </>
  );
}

function FraudCardBody() {
  const t = useMessages(appsMessages);
  const common = useMessages(settingsMessages);
  const canEdit = usePermissions().hasPermission(ADMIN_PERMISSIONS.SETTINGS_FRAUD_CHECKER_EDIT);
  const { data, isError, refetch } = useQuery(fraudCheckerProvidersQueryOptions());
  if (isError) return <SettingsLoadFailure title={t("fraudTitle")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;
  // Every saved checker, plus one "not set up" row for each checker not saved yet.
  const rows = [
    ...data.map((provider) => ({ key: provider.id, type: fraudType(provider, "default"), provider })),
    ...FRAUD_CHECK_PROVIDER_TYPES
      .filter((type) => !data.some((provider) => fraudType(provider, "default") === type))
      .map((type) => ({ key: type, type, provider: null })),
  ].sort((a, b) => FRAUD_ORDER.indexOf(a.type) - FRAUD_ORDER.indexOf(b.type));
  return (
    <SettingsCard id="fraudCheck"
      title={t("fraudTitle")}
      description={t("fraudDescription")}
      rows={rows.map(({ key, type, provider }) => {
        const name = type === "default"
          ? provider?.name || t("customChecker")
          : getFraudCheckProviderDefinition(type).label;
        return (
          <SettingsDialog
            key={key}
            title={t("keysTitle", { name })}
            trigger={
              <SettingsRow
                disabled={!canEdit}
                label={<MarkLabel mark={<Mark provider={FRAUD_MARKS[type]} fallback={<ShieldCheck className="size-4" />} />}>{name}</MarkLabel>}
                value={provider ? (provider.isActive ? t("connected") : common("off")) : t("notSetUp")}
              />
            }
          >
            <FraudProviderForm type={type} provider={provider} name={name} />
          </SettingsDialog>
        );
      })}
    />
  );
}

export function FraudCheckCard() {
  const { hasPermission } = usePermissions();
  return hasPermission(ADMIN_PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW) ? <FraudCardBody /> : null;
}

// ── Warehouse scanner ───────────────────────────────────────────────────

const LINK_MINUTES = SCANNER_TOKEN_TTL_SECONDS / 60;

/**
 * The one-time link lives only in this component's state: never in the URL,
 * storage, logs or toasts. The token rides in the fragment, which browsers
 * don't send to servers.
 */
function ScannerCardBody() {
  const t = useMessages(appsMessages);
  const [link, setLink] = useState<{ url: string; expiresAt: number } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const qrFailed = t("qrFailed");
  const create = useMutation({
    mutationFn: () => apiData(postApiV1AdminAuthScannerLink()),
    onSuccess: ({ token, expiresAt }) => {
      const expiry = new Date(expiresAt).getTime();
      setQr(null);
      setNow(Date.now());
      setLink({
        url: `${window.location.origin}${withDashboardBasePath("/scanner")}#token=${encodeURIComponent(token)}`,
        expiresAt: Number.isNaN(expiry) ? Date.now() + SCANNER_TOKEN_TTL_SECONDS * 1000 : expiry,
      });
    },
    onError: () => toast.error(t("linkFailed")),
  });

  useEffect(() => {
    if (!link) return;
    let active = true;
    void import("qrcode")
      .then(({ toDataURL }) => toDataURL(link.url, { width: 280, margin: 2 }))
      .then((dataUrl) => active && setQr(dataUrl))
      .catch(() => active && toast.error(qrFailed));
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [link, qrFailed]);

  const minutesLeft = link ? Math.ceil((link.expiresAt - now) / 60_000) : 0;
  useEffect(() => {
    if (link && minutesLeft <= 0) {
      setLink(null);
      setQr(null);
    }
  }, [link, minutesLeft]);

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      toast.success(t("linkCopied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  };

  return (
    <SettingsCard id="scanner"
      title={t("scannerTitle")}
      description={t("scannerDescription")}
      action={
        <Button type="button" variant="outline" size="sm" disabled={create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          {link ? t("createAnother") : t("createLink")}
        </Button>
      }
    >
      {link && minutesLeft > 0 ? (
        <div className="flex flex-col items-center gap-3 text-center">
          {qr ? (
            <img src={qr} alt={t("qrAlt")} className="size-56 rounded-md" />
          ) : (
            <div className="grid size-56 place-items-center rounded-md bg-muted">
              <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
            </div>
          )}
          <p className="text-body text-muted-foreground" aria-live="polite">
            {t("linkHelp", { minutes: LINK_MINUTES })} {t("expiresIn", { minutes: minutesLeft })}
          </p>
          <Button type="button" variant="outline" onClick={() => void copy()}>
            {t("copyLink")}
          </Button>
        </div>
      ) : null}
    </SettingsCard>
  );
}

export function ScannerCard() {
  const { hasAllPermissions } = usePermissions();
  return hasAllPermissions([ADMIN_PERMISSIONS.PRODUCTS_VIEW, ADMIN_PERMISSIONS.PRODUCTS_EDIT])
    ? <ScannerCardBody />
    : null;
}
