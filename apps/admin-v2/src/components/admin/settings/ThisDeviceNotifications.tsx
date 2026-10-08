/**
 * Settings → Notifications → Staff: "Notifications on this device". Turns Web
 * Push on or off for this dashboard browser (a worker shows each alert, even
 * with the dashboard closed) and lists the signed-in staff member's own
 * browsers with a Remove button. Every staff member manages only their own.
 * Its read is preloaded by the page's loader, so the section appears whole and
 * the rows below it never move. Without Web Push in the browser it renders
 * nothing; without an https address for the Worker it says why in one line.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ListDate } from "~/components/admin/data-table/ListDate";
import { useMessages } from "~/i18n";
import { webPushMessages } from "~/i18n/settings-web-push";
import { toast } from "~/lib/toast";
import {
  browserAndSystem,
  currentSubscription,
  removeDevice,
  thisDeviceId,
  turnOffThisDevice,
  turnOnThisDevice,
  webPushQuery,
  webPushSupported,
} from "~/lib/web-push";

type Local = "checking" | "on" | "off" | "blocked";

function readPermission(): "granted" | "denied" | "default" {
  return typeof Notification === "undefined" ? "default" : Notification.permission;
}

export function ThisDeviceNotifications() {
  const t = useMessages(webPushMessages);
  const queryClient = useQueryClient();
  const supported = webPushSupported();
  const state = useQuery({ ...webPushQuery, enabled: supported });
  const [local, setLocal] = useState<Local>("checking");
  const [saved, setSaved] = useState(0);
  // The merchant said no to the browser's question: say so until they try again.
  const [refused, setRefused] = useState(false);

  // Whether this browser holds a subscription is the browser's to say, not the server's.
  useEffect(() => {
    if (!supported) return;
    let current = true;
    void currentSubscription().then(
      (subscription) => {
        if (!current) return;
        if (readPermission() === "denied") setLocal("blocked");
        else setLocal(subscription && readPermission() === "granted" ? "on" : "off");
      },
      () => current && setLocal("off"),
    );
    return () => {
      current = false;
    };
  }, [supported, saved]);

  const refresh = () => {
    setSaved((count) => count + 1);
    return queryClient.invalidateQueries({ queryKey: webPushQuery.queryKey });
  };
  const turnOn = useMutation({
    mutationFn: () => {
      setRefused(false);
      const { browser, system } = browserAndSystem(navigator.userAgent);
      const label = browser && system ? t("deviceLabel", { browser, system }) : browser || t("unknownDevice");
      return turnOnThisDevice(state.data!.publicKey!, label);
    },
    onSuccess: async (result) => {
      if (result === "blocked") setRefused(true);
      else toast.success(t("turnedOn"));
      await refresh();
    },
    onError: () => void toast.error(t("failed")),
  });
  const turnOff = useMutation({
    mutationFn: turnOffThisDevice,
    onSuccess: async () => {
      toast.success(t("turnedOff"));
      await refresh();
    },
    onError: () => void toast.error(t("failed")),
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeDevice(id),
    onSuccess: async () => {
      toast.success(t("removed"));
      await refresh();
    },
    onError: () => void toast.error(t("removeFailed")),
  });

  if (!supported) return null;
  const available = state.data?.available === true && Boolean(state.data.publicKey);
  const devices = state.data?.devices ?? [];
  const mine = thisDeviceId();
  // A device removed elsewhere leaves this browser's subscription without a server copy.
  const on = local === "on" && !(mine && !devices.some((device) => device.id === mine));
  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="space-y-1">
        <h3 className="text-heading-sm">{t("title")}</h3>
        <p className="text-body text-muted-foreground">{state.data && !available ? t("unavailable") : t("help")}</p>
      </div>
      {state.isPending ? <div className="min-h-11" aria-hidden="true" /> : null}
      {available ? (
        <div className="flex min-h-11 flex-wrap items-center gap-3">
          <Badge variant={on ? "success" : "secondary"}>{on ? t("on") : t("off")}</Badge>
          {on ? (
            <Button type="button" variant="outline" size="sm" loading={turnOff.isPending} onClick={() => turnOff.mutate()}>
              {t("turnOff")}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              loading={turnOn.isPending}
              disabled={local === "checking" || local === "blocked"}
              onClick={() => turnOn.mutate()}
            >
              {t("turnOn")}
            </Button>
          )}
        </div>
      ) : null}
      {available && (local === "blocked" || refused) ? <p className="text-body text-destructive">{t("blocked")}</p> : null}
      {available && devices.length > 0 ? (
        <div className="space-y-1">
          <h4 className="text-body font-medium">{t("devicesTitle")}</h4>
          <ul className="divide-y divide-border">
            {devices.map((device) => {
              const name = device.deviceLabel || t("unknownDevice");
              const isThis = device.id === mine;
              return (
                <li key={device.id} className="flex min-h-11 items-center gap-3 py-1.5">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-body">
                      <span className="min-w-0 break-words">{name}</span>
                      {isThis ? <Badge variant="info">{t("thisDevice")}</Badge> : null}
                    </p>
                    <p className="text-body text-muted-foreground">
                      {device.lastSuccessAt ? <>{t("lastAlert")}: <ListDate value={device.lastSuccessAt} className="text-muted-foreground" /></> : t("noAlertYet")}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t("removeDevice", { device: name })}
                    loading={isThis ? turnOff.isPending : remove.isPending && remove.variables === device.id}
                    onClick={() => (isThis ? turnOff.mutate() : remove.mutate(device.id))}
                  >
                    {t("remove")}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
