/**
 * My account → "Notifications on this device": the dashboard's one place to
 * set up staff push. Every staff member can open it (the devices are their
 * own); the bell and Settings → Notifications link here.
 *
 * - Turning on proves it works: the browser subscribes, a test notification
 *   goes out at once, and the merchant answers "Did it arrive?". "No" opens
 *   the troubleshooting steps and "Send again".
 * - When this browser cannot receive them, it says exactly why: no https store
 *   address, iPhone and iPad need the dashboard on the Home Screen first
 *   (Apple's rule, with the steps), notifications blocked (with how to unblock
 *   in this browser), or a browser without Web Push.
 * - The staff member's own devices, each with when it was added, its last
 *   delivery, "Not delivering" after failed sends, "Send test" and "Remove".
 *
 * Every staff member manages only their own devices. The read is preloaded by
 * the page's loader, so the section appears whole and nothing below moves.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { ListDate } from "~/components/admin/data-table/ListDate";
import { useMessages } from "~/i18n";
import { webPushMessages } from "~/i18n/settings-web-push";
import { toast } from "~/lib/toast";
import {
  browserAndSystem,
  isAppleMobile,
  pushBlocker,
  removeDevice,
  sendTestPush,
  thisBrowserIsOn,
  thisDeviceId,
  turnOffThisDevice,
  turnOnThisDevice,
  webPushQuery,
  type PushBlocker,
  type TestPushOutcome,
} from "~/lib/web-push";

type UnblockKey = "unblockIos" | "unblockEdge" | "unblockChrome" | "unblockFirefox" | "unblockSafari" | "unblockOther";

/** How to unblock notifications in this browser, in its own words. */
function unblockStep(t: (key: UnblockKey) => string): string {
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (isAppleMobile(userAgent, typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints)) return t("unblockIos");
  const { browser } = browserAndSystem(userAgent);
  if (browser === "Edge") return t("unblockEdge");
  if (browser === "Chrome" || browser === "Opera") return t("unblockChrome");
  if (browser === "Firefox") return t("unblockFirefox");
  if (browser === "Safari") return t("unblockSafari");
  return t("unblockOther");
}

function BlockerNotice({ blocker }: { blocker: PushBlocker }) {
  const t = useMessages(webPushMessages);
  if (blocker === "homeScreen") {
    return (
      <Alert variant="info">
        <AlertTitle>{t("reasonHomeScreenTitle")}</AlertTitle>
        <AlertDescription>
          <p>{t("reasonHomeScreen")}</p>
          <ol className="list-disc space-y-1 ps-5">
            <li>{t("homeScreenShare")}</li>
            <li>{t("homeScreenAdd")}</li>
            <li>{t("homeScreenOpen")}</li>
          </ol>
        </AlertDescription>
      </Alert>
    );
  }
  if (blocker === "blocked") {
    return (
      <Alert variant="warning">
        <AlertTitle>{t("reasonBlocked")}</AlertTitle>
        <AlertDescription>
          <p>{unblockStep(t)}</p>
        </AlertDescription>
      </Alert>
    );
  }
  const text = blocker === "https" ? t("reasonHttps") : blocker === "iosVersion" ? t("reasonIosVersion") : t("reasonUnsupported");
  return <Alert variant="warning">{text}</Alert>;
}

/** "Did it arrive?" after a test to this device; "No" shows what to check. */
function ArrivalCheck({ sending, onYes, onSendAgain }: { sending: boolean; onYes: () => void; onSendAgain: () => void }) {
  const t = useMessages(webPushMessages);
  const [trouble, setTrouble] = useState(false);
  return (
    <Alert variant="info">
      <AlertTitle>{trouble ? t("troubleTitle") : t("askArrived")}</AlertTitle>
      <AlertDescription>
        {trouble ? (
          <ul className="list-disc space-y-1 ps-5">
            <li>{t("troubleSystem")}</li>
            <li>{t("troubleFocus")}</li>
            <li>{t("troubleHomeScreen")}</li>
            <li>{t("troubleLate")}</li>
          </ul>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-2">
          {trouble ? (
            <Button type="button" variant="outline" loading={sending} onClick={onSendAgain}>{t("sendAgain")}</Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={onYes}>{t("yes")}</Button>
              <Button type="button" variant="outline" onClick={() => setTrouble(true)}>{t("no")}</Button>
            </>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}

export function ThisDeviceNotifications() {
  const t = useMessages(webPushMessages);
  const queryClient = useQueryClient();
  const state = useQuery(webPushQuery);
  const [browserOn, setBrowserOn] = useState<boolean | null>(null);
  const [checked, setChecked] = useState(0);
  // The device a test just went to on this browser, while we ask whether it arrived.
  const [asking, setAsking] = useState<string | null>(null);
  // What a test to another device answered, by device.
  const [results, setResults] = useState<Record<string, TestPushOutcome>>({});

  // Whether this browser holds a subscription is the browser's to say, not the server's.
  useEffect(() => {
    let current = true;
    void thisBrowserIsOn().then((on) => current && setBrowserOn(on));
    return () => {
      current = false;
    };
  }, [checked]);

  const refresh = () => {
    setChecked((count) => count + 1);
    return queryClient.invalidateQueries({ queryKey: webPushQuery.queryKey });
  };
  const testText = () => ({ title: t("testTitle"), body: t("testBody") });

  const sendTest = useMutation({
    mutationFn: (id: string) => sendTestPush(id, testText()),
    onSuccess: async (outcome, id) => {
      if (id === thisDeviceId() && outcome === "sent") setAsking(id);
      else setResults((current) => ({ ...current, [id]: outcome }));
      if (outcome !== "sent") setAsking(null);
      await refresh();
    },
    onError: (_error, id) => setResults((current) => ({ ...current, [id]: "failed" })),
  });
  const turnOn = useMutation({
    mutationFn: () => {
      const { browser, system } = browserAndSystem(navigator.userAgent);
      const label = browser && system ? t("deviceLabel", { browser, system }) : browser || t("unknownDevice");
      return turnOnThisDevice(state.data!.publicKey!, label);
    },
    onSuccess: async (result) => {
      await refresh();
      // Prove it works: a test goes out at once, then we ask whether it arrived.
      if (result !== "blocked") sendTest.mutate(result.id);
    },
    onError: () => void toast.error(t("failed")),
  });
  const turnOff = useMutation({
    mutationFn: turnOffThisDevice,
    onSuccess: async () => {
      setAsking(null);
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

  const blocker = state.data ? pushBlocker(state.data.available && Boolean(state.data.publicKey)) : null;
  const devices = state.data?.devices ?? [];
  const mine = thisDeviceId();
  // A device removed elsewhere leaves this browser's subscription without a server copy.
  const on = browserOn === true && devices.some((device) => device.id === mine);
  return (
    <Card id="this-device" className="scroll-mt-4">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("help")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
      {state.isPending ? <div className="min-h-11" aria-hidden="true" /> : null}
      {state.isError ? (
        <div className="flex min-h-11 flex-wrap items-center gap-3 text-body text-destructive">
          {t("loadFailed")}
          <Button type="button" variant="outline" size="sm" loading={state.isFetching} onClick={() => void state.refetch()}>{t("retry")}</Button>
        </div>
      ) : null}
      {blocker ? <BlockerNotice blocker={blocker} /> : null}
      {state.data && !blocker ? (
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
              loading={turnOn.isPending || (sendTest.isPending && !asking)}
              disabled={browserOn === null}
              onClick={() => turnOn.mutate()}
            >
              {t("turnOn")}
            </Button>
          )}
        </div>
      ) : null}
      {asking && on ? (
        <ArrivalCheck
          sending={sendTest.isPending}
          onYes={() => {
            setAsking(null);
            toast.success(t("arrived"));
          }}
          onSendAgain={() => sendTest.mutate(asking)}
        />
      ) : null}
      {devices.length > 0 ? (
        <div className="space-y-1">
          <h4 className="text-body font-medium">{t("devicesTitle")}</h4>
          <ul className="divide-y divide-border">
            {devices.map((device) => {
              const name = device.deviceLabel || t("unknownDevice");
              const isThis = device.id === mine;
              const result = results[device.id];
              return (
                <li key={device.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="flex flex-wrap items-center gap-2 text-body">
                      <span className="min-w-0 break-words">{name}</span>
                      {isThis ? <Badge variant="info">{t("thisDevice")}</Badge> : null}
                      {device.failureCount > 0 ? <Badge variant="warning">{t("notDelivering")}</Badge> : null}
                    </p>
                    <p className="flex flex-wrap gap-x-3 text-body text-muted-foreground">
                      <span>{t("added")}: <ListDate value={device.createdAt} /></span>
                      <span>
                        {device.lastSuccessAt
                          ? <>{t("lastDelivery")}: <ListDate value={device.lastSuccessAt} /></>
                          : t("noDeliveryYet")}
                      </span>
                    </p>
                    {result ? (
                      <p role="status" className={result === "sent" ? "text-body text-muted-foreground" : "text-body text-destructive"}>
                        {result === "sent" ? t("testSent") : result === "gone" ? t("testGone") : t("testFailed")}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t("sendTestTo", { device: name })}
                      loading={sendTest.isPending && sendTest.variables === device.id}
                      onClick={() => sendTest.mutate(device.id)}
                    >
                      {t("sendTest")}
                    </Button>
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
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      </CardContent>
    </Card>
  );
}
