import { useState, useEffect } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Save, Bell, ShieldCheck } from "lucide-react";
import {
  getNotificationChannels,
  updateNotificationChannels,
  getAdminNotificationChannels,
  updateAdminNotificationChannels,
} from "@/lib/api-functions/settings";
import {
  ORDER_NOTIFICATION_LABELS,
  ORDER_NOTIFICATION_TYPES,
  type OrderNotificationType,
} from "@scalius/core/modules/notifications/notification-types";
import { describeNotificationIssue } from "@/lib/order-notification-display";

const ORDER_STATUSES = ORDER_NOTIFICATION_TYPES.map((key) => ({
  key,
  label: ORDER_NOTIFICATION_LABELS[key],
}));

const CHANNELS = [
  { key: "email", label: "Email" },
  { key: "sms", label: "SMS" },
  { key: "whatsapp", label: "WhatsApp" },
] as const;

const ADMIN_STATUSES = ORDER_STATUSES;

const ADMIN_CHANNELS = [
  { key: "push", label: "Push" },
] as const;

const DEFAULT_WHATSAPP_TEMPLATE = {
  templateName: "order_status_update",
  languageCode: "en_US",
};

type StatusKey = OrderNotificationType;
type ChannelKey = (typeof CHANNELS)[number]["key"];
type ChannelConfig = Record<StatusKey, Record<ChannelKey, boolean>>;
type WhatsAppTemplateConfig = typeof DEFAULT_WHATSAPP_TEMPLATE;
type CustomerChannelReadiness = {
  email: boolean;
  sms: boolean;
  whatsapp: boolean;
};

type AdminStatusKey = OrderNotificationType;
type AdminChannelKey = (typeof ADMIN_CHANNELS)[number]["key"];
type AdminChannelConfig = Record<AdminStatusKey, Record<AdminChannelKey, boolean>>;

function getDefaultConfig(): ChannelConfig {
  const config = {} as ChannelConfig;
  for (const status of ORDER_STATUSES) {
    config[status.key] = {
      email: status.key !== "support_request_submitted",
      sms: false,
      whatsapp: false,
    };
  }
  return config;
}

function channelCanBeEnabled(channel: ChannelKey, readiness: CustomerChannelReadiness): boolean {
  if (channel === "email") return readiness.email;
  if (channel === "sms") return readiness.sms;
  if (channel === "whatsapp") return readiness.whatsapp;
  return true;
}

function buildCustomerChannelConfig(
  channelData: Record<string, string[]> | undefined,
  readiness: CustomerChannelReadiness,
): ChannelConfig {
  const config = getDefaultConfig();
  if (!channelData || typeof channelData !== "object") {
    return sanitizeCustomerChannelConfig(config, readiness);
  }

  for (const status of ORDER_STATUSES) {
    const enabledChannels = channelData[status.key];
    if (!Array.isArray(enabledChannels)) continue;
    for (const ch of CHANNELS) {
      config[status.key][ch.key] =
        enabledChannels.includes(ch.key) && channelCanBeEnabled(ch.key, readiness);
    }
  }

  return sanitizeCustomerChannelConfig(config, readiness);
}

function sanitizeCustomerChannelConfig(
  config: ChannelConfig,
  readiness: CustomerChannelReadiness,
): ChannelConfig {
  const sanitized = {} as ChannelConfig;
  for (const status of ORDER_STATUSES) {
    sanitized[status.key] = { ...config[status.key] };
    for (const ch of CHANNELS) {
      if (!channelCanBeEnabled(ch.key, readiness)) {
        sanitized[status.key][ch.key] = false;
      }
    }
  }
  return sanitized;
}

function getDefaultAdminConfig(): AdminChannelConfig {
  const config = {} as AdminChannelConfig;
  for (const status of ADMIN_STATUSES) {
    config[status.key] = {
      push: status.key === "order_created" || status.key === "order_cancelled" || status.key === "support_request_submitted",
    };
  }
  return config;
}

function buildAdminChannelConfig(
  channelData: Record<string, string[]> | undefined,
  pushReady: boolean,
): AdminChannelConfig {
  const config = getDefaultAdminConfig();
  if (channelData && typeof channelData === "object") {
    for (const status of ADMIN_STATUSES) {
      const enabledChannels = channelData[status.key];
      if (!Array.isArray(enabledChannels)) continue;
      for (const ch of ADMIN_CHANNELS) {
        config[status.key][ch.key] = enabledChannels.includes(ch.key);
      }
    }
  }
  return sanitizeAdminChannelConfig(config, pushReady);
}

function sanitizeAdminChannelConfig(
  config: AdminChannelConfig,
  pushReady: boolean,
): AdminChannelConfig {
  const sanitized = {} as AdminChannelConfig;
  for (const status of ADMIN_STATUSES) {
    sanitized[status.key] = { ...config[status.key] };
    if (!pushReady) {
      sanitized[status.key].push = false;
    }
  }
  return sanitized;
}

function readinessIssueText(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? "";
  const described = describeNotificationIssue(trimmed);
  if (described) return described;
  return trimmed.length > 0 ? trimmed : fallback;
}

export function NotificationChannelsBuilder() {
  const [channels, setChannels] = useState<ChannelConfig>(getDefaultConfig());
  const [whatsAppTemplate, setWhatsAppTemplate] = useState<WhatsAppTemplateConfig>(DEFAULT_WHATSAPP_TEMPLATE);
  const [isEmailConfigured, setIsEmailConfigured] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [isWhatsAppConfigured, setIsWhatsAppConfigured] = useState(false);
  const [whatsAppError, setWhatsAppError] = useState<string | null>(null);
  const [isSmsConfigured, setIsSmsConfigured] = useState(false);
  const [smsProviderError, setSmsProviderError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const [adminChannels, setAdminChannels] = useState<AdminChannelConfig>(getDefaultAdminConfig());
  const [isPushConfigured, setIsPushConfigured] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [isAdminLoading, setIsAdminLoading] = useState(true);
  const [isAdminSaving, setIsAdminSaving] = useState(false);

  useEffect(() => {
    async function loadCustomerChannels() {
      try {
        const data = await getNotificationChannels() as {
          channels?: Record<string, string[]>;
          whatsappTemplate?: Partial<WhatsAppTemplateConfig>;
          emailConfigured?: boolean;
          emailError?: string | null;
          whatsappConfigured?: boolean;
          whatsappError?: string | null;
          smsProviderConfigured?: boolean;
          smsProviderError?: string | null;
        };
        const emailConfigured = Boolean(data?.emailConfigured);
        const whatsappConfigured = Boolean(data?.whatsappConfigured);
        const smsConfigured = Boolean(data?.smsProviderConfigured);
        setIsEmailConfigured(emailConfigured);
        setEmailError(data?.emailError ?? null);
        setIsWhatsAppConfigured(whatsappConfigured);
        setWhatsAppError(data?.whatsappError ?? null);
        setIsSmsConfigured(smsConfigured);
        setSmsProviderError(data?.smsProviderError ?? null);
        setChannels(buildCustomerChannelConfig(data?.channels, {
          email: emailConfigured,
          sms: smsConfigured,
          whatsapp: whatsappConfigured,
        }));
        if (data?.whatsappTemplate) {
          setWhatsAppTemplate({
            templateName: data.whatsappTemplate.templateName || DEFAULT_WHATSAPP_TEMPLATE.templateName,
            languageCode: data.whatsappTemplate.languageCode || DEFAULT_WHATSAPP_TEMPLATE.languageCode,
          });
        }
      } catch {
        // Use defaults on error
      } finally {
        setIsLoading(false);
      }
    }

    async function loadAdminChannels() {
      try {
        const data = await getAdminNotificationChannels() as {
          channels?: Record<string, string[]>;
          pushConfigured?: boolean;
          pushError?: string | null;
        };
        const pushConfigured = Boolean(data?.pushConfigured);
        setIsPushConfigured(pushConfigured);
        setPushError(data?.pushError ?? null);
        setAdminChannels(buildAdminChannelConfig(data?.channels, pushConfigured));
      } catch {
        // Use defaults on error
      } finally {
        setIsAdminLoading(false);
      }
    }

    loadCustomerChannels();
    loadAdminChannels();
  }, []);

  const handleToggle = (status: StatusKey, channel: ChannelKey) => {
    if (!channelCanBeEnabled(channel, {
      email: isEmailConfigured,
      sms: isSmsConfigured,
      whatsapp: isWhatsAppConfigured,
    })) {
      return;
    }
    setChannels((prev) => ({
      ...prev,
      [status]: {
        ...prev[status],
        [channel]: !prev[status][channel],
      },
    }));
  };

  const handleAdminToggle = (status: AdminStatusKey, channel: AdminChannelKey) => {
    if (channel === "push" && !isPushConfigured) {
      return;
    }
    setAdminChannels((prev) => ({
      ...prev,
      [status]: {
        ...prev[status],
        [channel]: !prev[status][channel],
      },
    }));
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const effectiveChannels = sanitizeCustomerChannelConfig(channels, {
        email: isEmailConfigured,
        sms: isSmsConfigured,
        whatsapp: isWhatsAppConfigured,
      });
      setChannels(effectiveChannels);
      // Transform UI format (Record<status, Record<channel, boolean>>)
      // to API format (Record<status, string[]>) -- array of enabled channel keys
      const apiChannels: Record<string, string[]> = {};
      for (const status of ORDER_STATUSES) {
        const statusChannels = effectiveChannels[status.key];
        apiChannels[status.key] = CHANNELS
          .filter((ch) => statusChannels?.[ch.key])
          .map((ch) => ch.key);
      }
      await updateNotificationChannels({
        data: {
          channels: apiChannels,
          whatsappTemplate: {
            templateName: whatsAppTemplate.templateName.trim() || DEFAULT_WHATSAPP_TEMPLATE.templateName,
            languageCode: whatsAppTemplate.languageCode.trim() || DEFAULT_WHATSAPP_TEMPLATE.languageCode,
          },
        },
      });
      toast.success("Notification channels saved");
    } catch (error: unknown) {
      toast.error("Failed to save", {
        description: readinessIssueText(
          error instanceof Error ? error.message : null,
          "Please try again.",
        ),
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleAdminSave = async () => {
    setIsAdminSaving(true);
    try {
      const effectiveAdminChannels = sanitizeAdminChannelConfig(adminChannels, isPushConfigured);
      setAdminChannels(effectiveAdminChannels);
      const apiChannels: Record<string, string[]> = {};
      for (const status of ADMIN_STATUSES) {
        const statusChannels = effectiveAdminChannels[status.key];
        apiChannels[status.key] = ADMIN_CHANNELS
          .filter((ch) => statusChannels?.[ch.key])
          .map((ch) => ch.key);
      }
      await updateAdminNotificationChannels({ data: { channels: apiChannels } });
      toast.success("Admin notification channels saved");
    } catch (error: unknown) {
      toast.error("Failed to save", {
        description: readinessIssueText(
          error instanceof Error ? error.message : null,
          "Please try again.",
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
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle className="text-base">Customer Notification Channels</CardTitle>
              <CardDescription className="mt-1">
                Choose how your <strong>customers</strong> are notified about order events.
                These notifications are sent directly to the customer via their preferred channel.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="mb-5 grid gap-4 md:grid-cols-[minmax(0,1fr)_12rem]">
            <div className="space-y-2">
              <Label htmlFor="order-whatsapp-template">WhatsApp order template</Label>
              <Input
                id="order-whatsapp-template"
                value={whatsAppTemplate.templateName}
                onChange={(event) =>
                  setWhatsAppTemplate((prev) => ({
                    ...prev,
                    templateName: event.target.value,
                  }))
                }
                placeholder="order_status_update"
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="order-whatsapp-language">Language</Label>
              <Input
                id="order-whatsapp-language"
                value={whatsAppTemplate.languageCode}
                onChange={(event) =>
                  setWhatsAppTemplate((prev) => ({
                    ...prev,
                    languageCode: event.target.value,
                  }))
                }
                placeholder="en_US"
                autoComplete="off"
              />
            </div>
          </div>

          {(!isEmailConfigured || !isSmsConfigured || !isWhatsAppConfigured) && (
            <div className="mb-4 grid gap-2">
              {!isEmailConfigured && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {readinessIssueText(
                      emailError,
                      "Email notifications are locked until a transactional email provider is ready.",
                    )}
                  </span>
                </div>
              )}
              {!isSmsConfigured && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {readinessIssueText(
                      smsProviderError,
                      "SMS notifications are locked until an active SMS provider is ready.",
                    )}
                  </span>
                </div>
              )}
              {!isWhatsAppConfigured && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {readinessIssueText(
                      whatsAppError,
                      "WhatsApp notifications are locked until Meta WhatsApp Cloud API credentials are ready.",
                    )}
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 border-b">
                  <th className="text-left py-3 px-4 font-medium">
                    Order Event
                  </th>
                  {CHANNELS.map((ch) => (
                    <th
                      key={ch.key}
                      className="text-center py-3 px-4 font-medium w-24"
                    >
                      {ch.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ORDER_STATUSES.map((status, i) => (
                  <tr
                    key={status.key}
                    className={i < ORDER_STATUSES.length - 1 ? "border-b" : ""}
                  >
                    <td className="py-3 px-4 font-medium">{status.label}</td>
                    {CHANNELS.map((ch) => (
                      <td key={ch.key} className="text-center py-3 px-4">
                        <Checkbox
                          checked={channels[status.key]?.[ch.key] ?? false}
                          disabled={!channelCanBeEnabled(ch.key, {
                            email: isEmailConfigured,
                            sms: isSmsConfigured,
                            whatsapp: isWhatsAppConfigured,
                          })}
                          onCheckedChange={() =>
                            handleToggle(status.key, ch.key)
                          }
                          aria-label={`${status.label} via ${ch.label}`}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end mt-4">
            <Button onClick={handleSave} disabled={isSaving} size="sm">
              {isSaving ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Save Changes
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle className="text-base">Admin Notifications</CardTitle>
              <CardDescription className="mt-1">
                Choose which order events send push notifications to admin devices.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isAdminLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {!isPushConfigured && (
                <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {readinessIssueText(
                      pushError,
                      "Admin push notifications are locked until Firebase service account credentials are ready.",
                    )}
                  </span>
                </div>
              )}
              <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/50 border-b">
                      <th className="text-left py-3 px-4 font-medium">
                        Order Event
                      </th>
                      {ADMIN_CHANNELS.map((ch) => (
                        <th
                          key={ch.key}
                          className="text-center py-3 px-4 font-medium w-24"
                        >
                          {ch.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ADMIN_STATUSES.map((status, i) => (
                      <tr
                        key={status.key}
                        className={i < ADMIN_STATUSES.length - 1 ? "border-b" : ""}
                      >
                        <td className="py-3 px-4 font-medium">{status.label}</td>
                        {ADMIN_CHANNELS.map((ch) => (
                          <td key={ch.key} className="text-center py-3 px-4">
                            <Checkbox
                              checked={adminChannels[status.key]?.[ch.key] ?? false}
                              disabled={ch.key === "push" && !isPushConfigured}
                              onCheckedChange={() =>
                                handleAdminToggle(status.key, ch.key)
                              }
                              aria-label={`Admin: ${status.label} via ${ch.label}`}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex justify-end mt-4">
                <Button onClick={handleAdminSave} disabled={isAdminSaving} size="sm">
                  {isAdminSaving ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  Save Changes
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default NotificationChannelsBuilder;
