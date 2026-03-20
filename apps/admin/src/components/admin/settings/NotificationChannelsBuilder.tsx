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
import { toast } from "sonner";
import { Loader2, Save, Bell } from "lucide-react";
import { unwrapEnvelope, extractApiError } from "@/lib/api-helpers";

const ORDER_STATUSES = [
  { key: "order_created", label: "Order Created" },
  { key: "order_confirmed", label: "Order Confirmed" },
  { key: "order_processing", label: "Order Processing" },
  { key: "order_shipped", label: "Order Shipped" },
  { key: "order_delivered", label: "Order Delivered" },
  { key: "order_cancelled", label: "Order Cancelled" },
] as const;

const CHANNELS = [
  { key: "email", label: "Email" },
  { key: "sms", label: "SMS" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "push", label: "Push" },
] as const;

type StatusKey = (typeof ORDER_STATUSES)[number]["key"];
type ChannelKey = (typeof CHANNELS)[number]["key"];
type ChannelConfig = Record<StatusKey, Record<ChannelKey, boolean>>;

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

export function NotificationChannelsBuilder() {
  const [channels, setChannels] = useState<ChannelConfig>(getDefaultConfig());
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/v1/admin/settings/notification-channels");
        if (res.ok) {
          const json = await res.json();
          const data = unwrapEnvelope<{ channels?: ChannelConfig }>(json);
          if (data?.channels) {
            setChannels({ ...getDefaultConfig(), ...data.channels });
          }
        }
      } catch {
        // Use defaults on error
      } finally {
        setIsLoading(false);
      }
    }
    load();
  }, []);

  const handleToggle = (status: StatusKey, channel: ChannelKey) => {
    setChannels((prev) => ({
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
      const res = await fetch("/api/v1/admin/settings/notification-channels", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channels }),
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(extractApiError(errJson, "Failed to save"));
      }
      toast.success("Notification channels saved");
    } catch (error: unknown) {
      toast.error("Failed to save", {
        description: error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
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
  );
}

export default NotificationChannelsBuilder;
