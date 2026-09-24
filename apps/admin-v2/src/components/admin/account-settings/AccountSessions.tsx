import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Laptop, MonitorSmartphone, Smartphone, Tablet } from "lucide-react";
import { toast } from "sonner";
import { deleteApiV1AdminAuthSessions, deleteApiV1AdminAuthSessionsByCommandId } from "@scalius/api-client/sdk";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { apiData } from "~/lib/api";
import {
  accountSessionsQueryOptions,
  type AccountSession,
  type AccountSessionsResponse,
} from "~/lib/api-query-options/auth-management";
import { queryKeys } from "~/lib/query-keys";
import { formatDateTime, useMessages } from "~/i18n";
import { accountMessages } from "~/i18n/account";
import { accountFailureKey } from "./account-error";

const DEVICE_ICONS = { mobile: Smartphone, tablet: Tablet, desktop: Laptop, unknown: MonitorSmartphone } as const;

function when(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : formatDateTime(date, { dateStyle: "medium", timeStyle: "short" });
}

/** Signed-in devices: where this account is signed in, with sign out per device or for all others. */
export function AccountSessions() {
  const t = useMessages(accountMessages);
  const queryClient = useQueryClient();
  const sessionsQuery = useQuery(accountSessionsQueryOptions());
  const [confirm, setConfirm] = useState<AccountSession | "others" | null>(null);
  const sessions = sessionsQuery.data?.sessions ?? [];
  const canSignOutOthers = sessions.some((session) => !session.current) || Boolean(sessionsQuery.data?.hasMore);

  const settle = () => void queryClient.invalidateQueries({ queryKey: queryKeys.auth.sessions() });
  const keep = (filter: (session: AccountSession) => boolean, hasMore?: boolean) =>
    queryClient.setQueryData<AccountSessionsResponse>(queryKeys.auth.sessions(), (current) =>
      current ? { sessions: current.sessions.filter(filter), hasMore: hasMore ?? current.hasMore } : current,
    );

  const signOutOne = useMutation({
    mutationFn: (commandId: string) => apiData(deleteApiV1AdminAuthSessionsByCommandId({ path: { commandId } })),
    onSuccess: (_result, commandId) => {
      keep((session) => session.commandId !== commandId);
      toast.success(t("deviceSignedOut"));
    },
    onError: (error) => toast.error(t(accountFailureKey(error, () => "signOutFailed"))),
    onSettled: settle,
  });

  const signOutOthers = useMutation({
    mutationFn: () => apiData(deleteApiV1AdminAuthSessions()),
    onSuccess: (result) => {
      keep((session) => session.current, false);
      const count = result.revokedCount;
      toast.success(count === 0 ? t("noOtherDevices") : count === 1 ? t("devicesSignedOutOne") : t("devicesSignedOutMany", { count }));
    },
    onError: (error) => toast.error(t(accountFailureKey(error, () => "signOutFailed"))),
    onSettled: settle,
  });

  const pending = signOutOne.isPending || signOutOthers.isPending;
  // `localNetwork` is new in the API; the generated client type catches up at the next SDK build.
  // The API names browsers and systems only; an unrecognised device is named here.
  const deviceName = (session: AccountSession) => session.deviceLabel || t("unknownDevice");
  const networkOf = (session: AccountSession & { localNetwork?: boolean }) =>
    session.localNetwork ? t("localNetwork") : session.networkHint ? t("network", { hint: session.networkHint }) : null;
  const loadFailed = Boolean(sessionsQuery.error) || (sessionsQuery.isSuccess && sessions.length === 0);

  return (
    <Card id="sessions" className="scroll-mt-4">
      <CardHeader>
        <CardTitle>{t("devices")}</CardTitle>
        <CardDescription>{t("devicesHelp")}</CardDescription>
      </CardHeader>
      <CardContent>
        {sessionsQuery.isPending ? (
          <ul className="flex flex-col gap-4" aria-busy="true" aria-label={t("loadingDevices")}>
            {[0, 1].map((item) => (
              <li key={item} className="flex items-center gap-3">
                <Skeleton className="size-5" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-4 w-56 max-w-full" />
                </div>
              </li>
            ))}
          </ul>
        ) : loadFailed ? (
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertDescription>
              <div className="flex flex-wrap items-center justify-between gap-2">
                {t("devicesLoadFailed")}
                <Button type="button" variant="outline" size="sm" loading={sessionsQuery.isFetching} onClick={() => void sessionsQuery.refetch()}>
                  {t("retry")}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : (
          <ul className="flex flex-col divide-y">
            {sessions.map((session) => {
              const Icon = DEVICE_ICONS[session.deviceType] ?? MonitorSmartphone;
              return (
                <li key={session.commandId} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                  <span className="flex h-lh items-center text-muted-foreground">
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-body font-medium">{deviceName(session)}</span>
                      {session.current ? <Badge variant="info">{t("thisDevice")}</Badge> : null}
                      {session.impersonated ? <Badge variant="attention">{t("openedByAdmin")}</Badge> : null}
                    </span>
                    <span className="text-body text-muted-foreground">
                      {t("lastActive", { time: when(session.lastActiveAt) })}
                      {networkOf(session) ? ` · ${networkOf(session)}` : ""}
                    </span>
                  </div>
                  {!session.current ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      loading={signOutOne.isPending && signOutOne.variables === session.commandId}
                      onClick={() => setConfirm(session)}
                    >
                      {t("signOut")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {sessionsQuery.data?.hasMore ? <p className="pt-3 text-body text-muted-foreground">{t("moreDevices")}</p> : null}
      </CardContent>
      <CardFooter className="justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={!canSignOutOthers || loadFailed || pending}
          loading={signOutOthers.isPending}
          onClick={() => setConfirm("others")}
        >
          {t("signOutOthers")}
        </Button>
      </CardFooter>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm === "others" ? t("signOutOthersTitle") : t("signOutOneTitle", { device: confirm ? deviceName(confirm) : "" })}
        description={t(confirm === "others" ? "signOutOthersBody" : "signOutOneBody")}
        confirmLabel={t(confirm === "others" ? "signOutOthers" : "signOut")}
        cancelLabel={t("cancel")}
        onConfirm={() => {
          if (confirm === "others") signOutOthers.mutate();
          else if (confirm) signOutOne.mutate(confirm.commandId);
          setConfirm(null);
        }}
      />
    </Card>
  );
}
