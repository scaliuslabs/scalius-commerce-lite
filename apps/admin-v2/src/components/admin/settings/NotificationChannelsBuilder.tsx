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
import { Loader2, Save, Bell, ShieldCheck } from "lucide-react";
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

const ORDER_STATUSES = ORDER_NOTIFICATION_TYPES.map((key) => ({
  key,
  label: ORDER_NOTIFICATION_LABELS[key],
}));

const CHANNELS = [
  { key: "email", label: "Email" },
  { key: "sms", label: "SMS" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "push", label: "Push" },
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

type AdminStatusKey = OrderNotificationType;
type AdminChannelKey = (typeof ADMIN_CHANNELS)[number]["key"];
type AdminChannelConfig = Record<AdminStatusKey, Record<AdminChannelKey, boolean>>;

function getDefaultConfig(): ChannelConfig {
  const config = {} as ChannelConfig;
  for (const status of ORDER_STATUSES) {
    config[status.key] = {
      email: true,
      sms: false,
      whatsapp: false,
      push: false,
    };
  }
  return config;
}

function getDefaultAdminConfig(): AdminChannelConfig {
  const config = {} as AdminChannelConfig;
  for (const status of ADMIN_STATUSES) {
    config[status.key] = {
      push: status.key === "order_created" || status.key === "order_cancelled",
    };
  }
  return config;
}

export function NotificationChannelsBuilder() {
  const [channels, setChannels] = useState<ChannelConfig>(getDefaultConfig());
  const [whatsAppTemplate, setWhatsAppTemplate] = useState<WhatsAppTemplateConfig>(DEFAULT_WHATSAPP_TEMPLATE);
  const [isWhatsAppConfigured, setIsWhatsAppConfigured] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const [adminChannels, setAdminChannels] = useState<AdminChannelConfig>(getDefaultAdminConfig());
  const [isAdminLoading, setIsAdminLoading] = useState(true);
  const [isAdminSaving, setIsAdminSaving] = useState(false);

  useEffect(() => {
    async function loadCustomerChannels() {
      try {
        const data = await getNotificationChannels() as {
          channels?: Record<string, string[]>;
          whatsappTemplate?: Partial<WhatsAppTemplateConfig>;
          whatsappConfigured?: boolean;
        };
        const whatsappConfigured = Boolean(data?.whatsappConfigured);
        setIsWhatsAppConfigured(whatsappConfigured);
        const channelData = data?.channels;
        if (channelData && typeof channelData === "object") {
          const config = getDefaultConfig();
          for (const status of ORDER_STATUSES) {
            const enabledChannels = channelData[status.key];
            if (Array.isArray(enabledChannels)) {
              for (const ch of CHANNELS) {
                config[status.key][ch.key] = ch.key === "whatsapp" && !whatsappConfigured
                  ? false
                  : enabledChannels.includes(ch.key);
              }
            }
          }
          setChannels(config);
        }
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
        const data = await getAdminNotificationChannels() as { channels?: Record<string, string[]> };
        const channelData = data?.channels;
        if (channelData && typeof channelData === "object") {
          const config = getDefaultAdminConfig();
          for (const status of ADMIN_STATUSES) {
            const enabledChannels = channelData[status.key];
            if (Array.isArray(enabledChannels)) {
              for (const ch of ADMIN_CHANNELS) {
                config[status.key][ch.key] = enabledChannels.includes(ch.key);
              }
            }
          }
          setAdminChannels(config);
        }
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
    setChannels((prev) => ({
      ...prev,
      [status]: {
        ...prev[status],
        [channel]: channel === "whatsapp" && !isWhatsAppConfigured
          ? false
          : !prev[status][channel],
      },
    }));
  };

  const handleAdminToggle = (status: AdminStatusKey, channel: AdminChannelKey) => {
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
      // Transform UI format (Record<status, Record<channel, boolean>>)
      // to API format (Record<status, string[]>) -- array of enabled channel keys
      const apiChannels: Record<string, string[]> = {};
      for (const status of ORDER_STATUSES) {
        const statusChannels = channels[status.key];
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
        description: error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleAdminSave = async () => {
    setIsAdminSaving(true);
    try {
      const apiChannels: Record<string, string[]> = {};
      for (const status of ADMIN_STATUSES) {
        const statusChannels = adminChannels[status.key];
        apiChannels[status.key] = ADMIN_CHANNELS
          .filter((ch) => statusChannels?.[ch.key])
          .map((ch) => ch.key);
      }
      await updateAdminNotificationChannels({ data: { channels: apiChannels } });
      toast.success("Admin notification channels saved");
    } catch (error: unknown) {
      toast.error("Failed to save", {
        description: error instanceof Error ? error.message : "Please try again.",
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
                Choose how your <strong>customers</strong> are notified about their order status changes.
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

          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 border-b">
                  <th className="text-left py-3 px-4 font-medium">
                    Order Status
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
                          disabled={ch.key === "whatsapp" && !isWhatsAppConfigured}
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
              <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/50 border-b">
                      <th className="text-left py-3 px-4 font-medium">
                        Order Status
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
