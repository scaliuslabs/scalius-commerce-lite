import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bell,
  ChevronDown,
  Loader2,
  RotateCcw,
  Save,
  ShieldCheck,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import type { OrderNotificationType } from "@scalius/core/modules/notifications/notification-types";

import { UnsavedChangesGuard } from "@/components/admin/shared/UnsavedChangesGuard";
import {
  CUSTOMER_NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENT_GROUPS,
  NOTIFICATION_EVENTS,
  adminNotificationConfigsEqual,
  buildAdminNotificationConfig,
  buildCustomerNotificationConfig,
  customerNotificationConfigsEqual,
  getAdminPushSelection,
  getCustomerChannelSelection,
  getDefaultAdminNotificationConfig,
  getDefaultCustomerNotificationConfig,
  serializeAdminNotificationConfig,
  serializeCustomerNotificationConfig,
  setAdminPushForEveryEvent,
  setCustomerChannelForEveryEvent,
  type AdminNotificationChannel,
  type AdminNotificationConfig,
  type CustomerNotificationChannel,
  type CustomerNotificationConfig,
} from "@/components/admin/settings/notification-channel-policy";
import type { NotificationRulesPanel } from "@/components/admin/settings/notification-settings-sections";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePermissions } from "@/contexts/PermissionContext";
import { getSettingsLoadErrorMessage } from "@/hooks/use-settings-form";
import { ADMIN_PERMISSIONS } from "@/lib/admin-permissions";
import {
  getAdminNotificationChannels,
  getNotificationChannels,
  updateAdminNotificationChannels,
  updateNotificationChannels,
} from "@/lib/api-functions/settings";
import { describeNotificationIssue } from "@/lib/order-notification-display";

const DEFAULT_WHATSAPP_TEMPLATE = {
  templateName: "order_status_update",
  languageCode: "en_US",
};

type WhatsAppTemplateConfig = typeof DEFAULT_WHATSAPP_TEMPLATE;

function readinessIssueText(
  value: string | null | undefined,
  fallback: string,
): string {
  const trimmed = value?.trim() ?? "";
  const described = describeNotificationIssue(trimmed);
  if (described) return described;
  return trimmed.length > 0 ? trimmed : fallback;
}

function countCustomerRules(
  config: CustomerNotificationConfig,
  channel: CustomerNotificationChannel,
): number {
  return NOTIFICATION_EVENTS.filter((event) => config[event.key][channel])
    .length;
}

function countAdminRules(config: AdminNotificationConfig): number {
  return NOTIFICATION_EVENTS.filter((event) => config[event.key].push).length;
}

function CustomerChannelControl({
  label,
  ready,
  activeRules,
  issue,
  selection,
  disabled,
  readyLabel = "Ready",
  readyDescription,
  onToggle,
}: {
  label: string;
  ready: boolean;
  activeRules: number;
  issue: string;
  selection: boolean | "indeterminate";
  disabled: boolean;
  readyLabel?: string;
  readyDescription?: string;
  onToggle: (enabled: boolean) => void;
}) {
  const state = ready
    ? readyLabel
    : activeRules > 0
      ? `${activeRules} paused`
      : "Needs setup";

  return (
    <label
      className="flex min-h-11 min-w-0 items-center gap-2 rounded-md border bg-background px-2.5 text-xs"
      title={ready ? readyDescription ?? `${label} delivery is ready.` : issue}
    >
      <Checkbox
        checked={selection}
        disabled={disabled}
        onCheckedChange={(checked) => onToggle(checked === true)}
        aria-label={`Enable ${label} for every customer event`}
      />
      <span
        className={ready ? "h-1.5 w-1.5 rounded-full bg-emerald-500" : "h-1.5 w-1.5 rounded-full bg-amber-500"}
        aria-hidden="true"
      />
      <span className="min-w-0">
        <span className="block font-medium sm:truncate">{label}</span>
        <span className="block text-muted-foreground sm:truncate">{state}</span>
      </span>
    </label>
  );
}

function CustomerRulesMatrix({
  channels,
  disabled,
  onToggle,
}: {
  channels: CustomerNotificationConfig;
  disabled: boolean;
  onToggle: (
    event: OrderNotificationType,
    channel: CustomerNotificationChannel,
  ) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="hidden md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/35">
              <th className="px-3 py-2 text-left font-medium">Event</th>
              {CUSTOMER_NOTIFICATION_CHANNELS.map((channel) => (
                <th
                  key={channel.key}
                  className="w-28 px-3 py-2 text-center font-medium"
                >
                  {channel.label}
                </th>
              ))}
            </tr>
          </thead>
          {NOTIFICATION_EVENT_GROUPS.map((group) => (
            <tbody key={group.label}>
              <tr className="border-b bg-muted/20">
                <th
                  colSpan={CUSTOMER_NOTIFICATION_CHANNELS.length + 1}
                  className="px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {group.label}
                </th>
              </tr>
              {group.keys.map((eventKey, index) => {
                const event = NOTIFICATION_EVENTS.find(
                  (candidate) => candidate.key === eventKey,
                );
                if (!event) return null;
                return (
                  <tr
                    key={event.key}
                    className={index < group.keys.length - 1 ? "border-b" : ""}
                  >
                    <td className="px-3 py-2 font-medium">{event.label}</td>
                    {CUSTOMER_NOTIFICATION_CHANNELS.map((channel) => (
                      <td key={channel.key} className="px-3 py-2 text-center">
                        <Checkbox
                          checked={channels[event.key][channel.key]}
                          disabled={disabled}
                          onCheckedChange={() =>
                            onToggle(event.key, channel.key)
                          }
                          aria-label={`${event.label} via ${channel.label}`}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>

      <div className="divide-y md:hidden">
        {NOTIFICATION_EVENT_GROUPS.map((group) => (
          <details key={group.label} className="group">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 bg-muted/25 px-3 text-sm font-medium">
              <span>{group.label}</span>
              <span className="ml-auto text-xs font-normal text-muted-foreground">
                {group.keys.length} events
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="divide-y border-t">
              {group.keys.map((eventKey) => {
                const event = NOTIFICATION_EVENTS.find(
                  (candidate) => candidate.key === eventKey,
                );
                if (!event) return null;
                return (
                  <div key={event.key} className="px-3 py-2.5">
                    <p className="text-sm font-medium">{event.label}</p>
                    <div className="mt-2 grid grid-cols-3 gap-2">
                      {CUSTOMER_NOTIFICATION_CHANNELS.map((channel) => (
                        <label
                          key={channel.key}
                          className="flex min-h-11 min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
                        >
                          <Checkbox
                            checked={channels[event.key][channel.key]}
                            disabled={disabled}
                            onCheckedChange={() =>
                              onToggle(event.key, channel.key)
                            }
                            aria-label={`${event.label} via ${channel.label}`}
                          />
                          <span className="truncate">{channel.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

function AdminRulesMatrix({
  channels,
  disabled,
  onToggle,
  onToggleAll,
}: {
  channels: AdminNotificationConfig;
  disabled: boolean;
  onToggle: (event: OrderNotificationType, channel: AdminNotificationChannel) => void;
  onToggleAll: (enabled: boolean) => void;
}) {
  const selection = getAdminPushSelection(channels);

  return (
    <div className="overflow-hidden rounded-lg border text-sm">
      <div className="flex items-center justify-between border-b bg-muted/35 px-3 py-2 font-medium">
        <span>Admin event</span>
        <label className="flex items-center gap-2">
          <Checkbox
            checked={selection}
            disabled={disabled}
            onCheckedChange={(checked) => onToggleAll(checked === true)}
            aria-label="Enable push for every admin event"
          />
          Push
        </label>
      </div>
      <div className="hidden md:block">
        {NOTIFICATION_EVENT_GROUPS.map((group) => (
          <section key={group.label} aria-labelledby={`admin-${group.label.replace(/\W+/g, "-").toLowerCase()}`}>
            <h3
              id={`admin-${group.label.replace(/\W+/g, "-").toLowerCase()}`}
              className="border-b bg-muted/20 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {group.label}
            </h3>
            <div className="divide-y">
              {group.keys.map((eventKey) => {
                const event = NOTIFICATION_EVENTS.find(
                  (candidate) => candidate.key === eventKey,
                );
                if (!event) return null;
                return (
                  <label
                    key={event.key}
                    className="flex min-h-10 items-center justify-between gap-3 px-3 py-2"
                  >
                    <span className="font-medium">{event.label}</span>
                    <Checkbox
                      checked={channels[event.key].push}
                      disabled={disabled}
                      onCheckedChange={() => onToggle(event.key, "push")}
                      aria-label={`Admin: ${event.label} via Push`}
                    />
                  </label>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <div className="divide-y md:hidden">
        {NOTIFICATION_EVENT_GROUPS.map((group) => (
          <details key={group.label} className="group">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 bg-muted/20 px-3 font-medium">
              <span>{group.label}</span>
              <span className="ml-auto text-xs font-normal text-muted-foreground">
                {group.keys.length} events
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="divide-y border-t">
              {group.keys.map((eventKey) => {
                const event = NOTIFICATION_EVENTS.find(
                  (candidate) => candidate.key === eventKey,
                );
                if (!event) return null;
                return (
                  <label
                    key={event.key}
                    className="flex min-h-11 items-center justify-between gap-3 px-3 py-2"
                  >
                    <span className="font-medium">{event.label}</span>
                    <Checkbox
                      checked={channels[event.key].push}
                      disabled={disabled}
                      onCheckedChange={() => onToggle(event.key, "push")}
                      aria-label={`Admin: ${event.label} via Push`}
                    />
                  </label>
                );
              })}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

export function NotificationChannelsBuilder({
  audience,
  onAudienceChange,
}: {
  audience: NotificationRulesPanel;
  onAudienceChange: (audience: NotificationRulesPanel) => void;
}) {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const [channels, setChannels] = useState<CustomerNotificationConfig>(
    getDefaultCustomerNotificationConfig,
  );
  const [savedChannels, setSavedChannels] =
    useState<CustomerNotificationConfig>(getDefaultCustomerNotificationConfig);
  const [whatsAppTemplate, setWhatsAppTemplate] =
    useState<WhatsAppTemplateConfig>(DEFAULT_WHATSAPP_TEMPLATE);
  const [savedWhatsAppTemplate, setSavedWhatsAppTemplate] =
    useState<WhatsAppTemplateConfig>(DEFAULT_WHATSAPP_TEMPLATE);
  const [isEmailConfigured, setIsEmailConfigured] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [isWhatsAppConfigured, setIsWhatsAppConfigured] = useState(false);
  const [whatsAppError, setWhatsAppError] = useState<string | null>(null);
  const [isSmsConfigured, setIsSmsConfigured] = useState(false);
  const [smsProviderError, setSmsProviderError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [customerLoadError, setCustomerLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const [adminChannels, setAdminChannels] = useState<AdminNotificationConfig>(
    getDefaultAdminNotificationConfig,
  );
  const [savedAdminChannels, setSavedAdminChannels] =
    useState<AdminNotificationConfig>(getDefaultAdminNotificationConfig);
  const [isPushConfigured, setIsPushConfigured] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [isAdminLoading, setIsAdminLoading] = useState(true);
  const [adminLoadError, setAdminLoadError] = useState<string | null>(null);
  const [isAdminSaving, setIsAdminSaving] = useState(false);

  const customerIssues = useMemo(
    () => [
      !isEmailConfigured
        ? readinessIssueText(
            emailError,
            "Email delivery needs a transactional email provider.",
          )
        : null,
      !isSmsConfigured
        ? readinessIssueText(
            smsProviderError,
            "SMS delivery needs an active SMS provider.",
          )
        : null,
      !isWhatsAppConfigured
        ? readinessIssueText(
            whatsAppError,
            "WhatsApp delivery needs Meta WhatsApp Cloud API credentials.",
          )
        : null,
    ].filter((issue): issue is string => Boolean(issue)),
    [
      emailError,
      isEmailConfigured,
      isSmsConfigured,
      isWhatsAppConfigured,
      smsProviderError,
      whatsAppError,
    ],
  );

  const customerDirty = useMemo(
    () =>
      !customerNotificationConfigsEqual(channels, savedChannels) ||
      whatsAppTemplate.templateName !== savedWhatsAppTemplate.templateName ||
      whatsAppTemplate.languageCode !== savedWhatsAppTemplate.languageCode,
    [channels, savedChannels, savedWhatsAppTemplate, whatsAppTemplate],
  );
  const adminDirty = useMemo(
    () => !adminNotificationConfigsEqual(adminChannels, savedAdminChannels),
    [adminChannels, savedAdminChannels],
  );
  const customerControlsDisabled = !canManage || isSaving;
  const adminControlsDisabled = !canManage || isAdminSaving;

  const loadCustomerChannels = useCallback(async () => {
    setIsLoading(true);
    setCustomerLoadError(null);
    try {
      const data = (await getNotificationChannels()) as {
        channels?: Record<string, string[]>;
        whatsappTemplate?: Partial<WhatsAppTemplateConfig>;
        emailConfigured?: boolean;
        emailError?: string | null;
        whatsappConfigured?: boolean;
        whatsappError?: string | null;
        smsProviderConfigured?: boolean;
        smsProviderError?: string | null;
      };
      const nextChannels = buildCustomerNotificationConfig(data?.channels);
      const nextTemplate = {
        templateName:
          data?.whatsappTemplate?.templateName ||
          DEFAULT_WHATSAPP_TEMPLATE.templateName,
        languageCode:
          data?.whatsappTemplate?.languageCode ||
          DEFAULT_WHATSAPP_TEMPLATE.languageCode,
      };
      setIsEmailConfigured(Boolean(data?.emailConfigured));
      setEmailError(data?.emailError ?? null);
      setIsWhatsAppConfigured(Boolean(data?.whatsappConfigured));
      setWhatsAppError(data?.whatsappError ?? null);
      setIsSmsConfigured(Boolean(data?.smsProviderConfigured));
      setSmsProviderError(data?.smsProviderError ?? null);
      setChannels(nextChannels);
      setSavedChannels(nextChannels);
      setWhatsAppTemplate(nextTemplate);
      setSavedWhatsAppTemplate(nextTemplate);
    } catch (error) {
      setCustomerLoadError(
        getSettingsLoadErrorMessage(
          error,
          "Customer notification channels could not be loaded. Existing notification settings were not changed.",
        ),
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadAdminChannels = useCallback(async () => {
    setIsAdminLoading(true);
    setAdminLoadError(null);
    try {
      const data = (await getAdminNotificationChannels()) as {
        channels?: Record<string, string[]>;
        pushConfigured?: boolean;
        pushError?: string | null;
      };
      const nextChannels = buildAdminNotificationConfig(data?.channels);
      setIsPushConfigured(Boolean(data?.pushConfigured));
      setPushError(data?.pushError ?? null);
      setAdminChannels(nextChannels);
      setSavedAdminChannels(nextChannels);
    } catch (error) {
      setAdminLoadError(
        getSettingsLoadErrorMessage(
          error,
          "Admin notification channels could not be loaded. Existing admin notification settings were not changed.",
        ),
      );
    } finally {
      setIsAdminLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCustomerChannels();
    void loadAdminChannels();
  }, [loadAdminChannels, loadCustomerChannels]);

  const handleToggle = (
    event: OrderNotificationType,
    channel: CustomerNotificationChannel,
  ) => {
    if (customerControlsDisabled) return;
    setChannels((previous) => ({
      ...previous,
      [event]: {
        ...previous[event],
        [channel]: !previous[event][channel],
      },
    }));
  };

  const handleToggleCustomerColumn = (
    channel: CustomerNotificationChannel,
    enabled: boolean,
  ) => {
    if (customerControlsDisabled) return;
    setChannels((previous) =>
      setCustomerChannelForEveryEvent(previous, channel, enabled),
    );
  };

  const handleAdminToggle = (
    event: OrderNotificationType,
    _channel: AdminNotificationChannel,
  ) => {
    if (adminControlsDisabled) return;
    setAdminChannels((previous) => ({
      ...previous,
      [event]: { push: !previous[event].push },
    }));
  };

  const handleSave = async () => {
    if (!canManage) {
      toast.error("You do not have permission to change notification rules.");
      return;
    }
    if (customerLoadError || isLoading) {
      toast.error("Reload customer notification channels before saving.");
      return;
    }
    setIsSaving(true);
    try {
      const normalizedTemplate = {
        templateName:
          whatsAppTemplate.templateName.trim() ||
          DEFAULT_WHATSAPP_TEMPLATE.templateName,
        languageCode:
          whatsAppTemplate.languageCode.trim() ||
          DEFAULT_WHATSAPP_TEMPLATE.languageCode,
      };
      await updateNotificationChannels({
        data: {
          channels: serializeCustomerNotificationConfig(channels),
          whatsappTemplate: normalizedTemplate,
        },
      });
      setWhatsAppTemplate(normalizedTemplate);
      setSavedWhatsAppTemplate(normalizedTemplate);
      setSavedChannels(channels);
      toast.success("Customer notification rules saved");
    } catch (error: unknown) {
      toast.error("Customer rules were not saved", {
        description: readinessIssueText(
          error instanceof Error ? error.message : null,
          "Try again.",
        ),
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleAdminSave = async () => {
    if (!canManage) {
      toast.error("You do not have permission to change notification rules.");
      return;
    }
    if (adminLoadError || isAdminLoading) {
      toast.error("Reload admin notification channels before saving.");
      return;
    }
    setIsAdminSaving(true);
    try {
      await updateAdminNotificationChannels({
        data: { channels: serializeAdminNotificationConfig(adminChannels) },
      });
      setSavedAdminChannels(adminChannels);
      toast.success("Admin notification rules saved");
    } catch (error: unknown) {
      toast.error("Admin rules were not saved", {
        description: readinessIssueText(
          error instanceof Error ? error.message : null,
          "Try again.",
        ),
      });
    } finally {
      setIsAdminSaving(false);
    }
  };

  if (isLoading && isAdminLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <UnsavedChangesGuard
        isDirty={customerDirty || adminDirty}
        isSubmitting={isSaving || isAdminSaving}
      />

      {!canManage && (
        <Alert>
          <AlertDescription>
            Your role can review notification rules, but cannot change them.
          </AlertDescription>
        </Alert>
      )}

      <div
        role="tablist"
        aria-label="Notification audience"
        className="inline-flex w-full rounded-lg border bg-muted/30 p-1 sm:w-auto"
      >
        <Button
          type="button"
          role="tab"
          aria-selected={audience === "customers"}
          variant={audience === "customers" ? "secondary" : "ghost"}
          className="h-11 flex-1 gap-2 px-4 sm:h-9 sm:flex-none"
          onClick={() => onAudienceChange("customers")}
        >
          <Users className="h-4 w-4" />
          Customers
          {customerDirty ? (
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-label="Unsaved customer changes" />
          ) : null}
        </Button>
        <Button
          type="button"
          role="tab"
          aria-selected={audience === "admins"}
          variant={audience === "admins" ? "secondary" : "ghost"}
          className="h-11 flex-1 gap-2 px-4 sm:h-9 sm:flex-none"
          onClick={() => onAudienceChange("admins")}
        >
          <ShieldCheck className="h-4 w-4" />
          Administrators
          {adminDirty ? (
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-label="Unsaved administrator changes" />
          ) : null}
        </Button>
      </div>

      {audience === "customers" ? <Card role="tabpanel">
        <CardHeader className="space-y-3 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-2.5">
              <Bell className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <CardTitle className="text-base">Customer updates</CardTitle>
              </div>
            </div>
            <div className="grid w-full grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-2 sm:flex sm:w-auto sm:flex-row">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setChannels(savedChannels);
                  setWhatsAppTemplate(savedWhatsAppTemplate);
                }}
                disabled={!canManage || !customerDirty || isSaving || isLoading || Boolean(customerLoadError)}
                className="min-h-11 min-w-0 sm:min-h-9"
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                Reset
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleSave}
                disabled={!canManage || !customerDirty || isSaving || isLoading || Boolean(customerLoadError)}
                className="min-h-11 min-w-0 sm:min-h-9"
              >
                {isSaving ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                Save customer rules
              </Button>
            </div>
          </div>

          {!isLoading && !customerLoadError ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" aria-label="Customer channel rules and readiness">
              <CustomerChannelControl
                label="Email"
                ready={isEmailConfigured}
                activeRules={countCustomerRules(channels, "email")}
                issue={readinessIssueText(emailError, "Email delivery needs setup.")}
                selection={getCustomerChannelSelection(channels, "email")}
                disabled={customerControlsDisabled}
                readyLabel="Configured"
                readyDescription="Email credentials and sender are configured; delivery has not been tested."
                onToggle={(enabled) => handleToggleCustomerColumn("email", enabled)}
              />
              <CustomerChannelControl
                label="SMS"
                ready={isSmsConfigured}
                activeRules={countCustomerRules(channels, "sms")}
                issue={readinessIssueText(smsProviderError, "SMS delivery needs setup.")}
                selection={getCustomerChannelSelection(channels, "sms")}
                disabled={customerControlsDisabled}
                onToggle={(enabled) => handleToggleCustomerColumn("sms", enabled)}
              />
              <CustomerChannelControl
                label="WhatsApp"
                ready={isWhatsAppConfigured}
                activeRules={countCustomerRules(channels, "whatsapp")}
                issue={readinessIssueText(whatsAppError, "WhatsApp delivery needs setup.")}
                selection={getCustomerChannelSelection(channels, "whatsapp")}
                disabled={customerControlsDisabled}
                onToggle={(enabled) => handleToggleCustomerColumn("whatsapp", enabled)}
              />
            </div>
          ) : null}
        </CardHeader>

        <CardContent className="space-y-3 px-4 pb-4 pt-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : customerLoadError ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Notification channels unavailable</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>{customerLoadError}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void loadCustomerChannels()}
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <>
              {customerIssues.length > 0 ? (
                <details className="group rounded-md border bg-muted/20 text-sm">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 font-medium sm:min-h-9">
                    <span>
                      {customerIssues.length} delivery {customerIssues.length === 1 ? "issue" : "issues"}
                      <span className="ml-1.5 font-normal text-muted-foreground">
                        Saved rules stay paused.
                      </span>
                    </span>
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                  </summary>
                  <ul className="space-y-1.5 border-t px-3 py-2 text-xs text-muted-foreground">
                    {customerIssues.map((issue) => (
                      <li key={issue} className="flex gap-2">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                        <span>{issue}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}

              <details className="group rounded-md border text-sm">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 sm:min-h-9">
                  <span className="font-medium">WhatsApp template</span>
                  <span className="ml-auto truncate text-xs text-muted-foreground">
                    {whatsAppTemplate.templateName} · {whatsAppTemplate.languageCode}
                  </span>
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                </summary>
                <div className="grid gap-3 border-t p-3 md:grid-cols-[minmax(0,1fr)_12rem]">
                  <div className="space-y-1.5">
                    <Label htmlFor="order-whatsapp-template">Template name</Label>
                    <Input
                      id="order-whatsapp-template"
                      value={whatsAppTemplate.templateName}
                      onChange={(event) =>
                        setWhatsAppTemplate((previous) => ({
                          ...previous,
                          templateName: event.target.value,
                        }))
                      }
                      placeholder="order_status_update"
                      autoComplete="off"
                      disabled={customerControlsDisabled}
                      className="h-11 sm:h-9"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="order-whatsapp-language">Language</Label>
                    <Input
                      id="order-whatsapp-language"
                      value={whatsAppTemplate.languageCode}
                      onChange={(event) =>
                        setWhatsAppTemplate((previous) => ({
                          ...previous,
                          languageCode: event.target.value,
                        }))
                      }
                      placeholder="en_US"
                      autoComplete="off"
                      disabled={customerControlsDisabled}
                      className="h-11 sm:h-9"
                    />
                  </div>
                </div>
              </details>

              <CustomerRulesMatrix
                channels={channels}
                disabled={customerControlsDisabled}
                onToggle={handleToggle}
              />
            </>
          )}
        </CardContent>
      </Card> : null}

      {audience === "admins" ? <Card role="tabpanel">
        <CardHeader className="space-y-3 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-2.5">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-base">Admin alerts</CardTitle>
                  {!isAdminLoading && !adminLoadError ? (
                    <Badge
                      variant={isPushConfigured ? "outline" : "secondary"}
                      className={
                        isPushConfigured
                          ? "border-emerald-500/35 text-emerald-700 dark:text-emerald-400"
                          : undefined
                      }
                    >
                      {isPushConfigured
                        ? "Push ready"
                        : countAdminRules(adminChannels) > 0
                          ? `${countAdminRules(adminChannels)} paused`
                          : "Push needs setup"}
                    </Badge>
                  ) : null}
                </div>
              </div>
            </div>
            <div className="grid w-full grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-2 sm:flex sm:w-auto sm:flex-row">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setAdminChannels(savedAdminChannels)}
                disabled={!canManage || !adminDirty || isAdminSaving || isAdminLoading || Boolean(adminLoadError)}
                className="min-h-11 min-w-0 sm:min-h-9"
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                Reset
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleAdminSave}
                disabled={!canManage || !adminDirty || isAdminSaving || isAdminLoading || Boolean(adminLoadError)}
                className="min-h-11 min-w-0 sm:min-h-9"
              >
                {isAdminSaving ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                Save admin rules
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-4 pb-4 pt-0">
          {isAdminLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : adminLoadError ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Admin notification channels unavailable</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>{adminLoadError}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void loadAdminChannels()}
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <div className="space-y-3">
              {!isPushConfigured ? (
                <div className="flex items-start gap-2 rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                  <span>
                    {readinessIssueText(
                      pushError,
                      "Admin push needs Firebase service account credentials.",
                    )}{" "}
                    Saved push rules stay paused until delivery recovers.
                  </span>
                </div>
              ) : null}
              <AdminRulesMatrix
                channels={adminChannels}
                disabled={adminControlsDisabled}
                onToggle={handleAdminToggle}
                onToggleAll={(enabled) =>
                  setAdminChannels((previous) =>
                    setAdminPushForEveryEvent(previous, enabled),
                  )
                }
              />
            </div>
          )}
        </CardContent>
      </Card> : null}
    </div>
  );
}

export default NotificationChannelsBuilder;
