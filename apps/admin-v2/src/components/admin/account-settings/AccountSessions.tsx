import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  AlertCircle,
  Laptop,
  Loader2,
  LogOut,
  MonitorSmartphone,
  RefreshCw,
  ShieldCheck,
  ShieldQuestion,
  Smartphone,
  Tablet,
} from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { getServerFnError } from "~/lib/api-helpers";
import {
  revokeAccountSession,
  revokeOtherAccountSessions,
  type AccountSession,
  type AccountSessionsResponse,
} from "~/lib/api-functions/auth-management";
import { accountSessionsQueryOptions } from "~/lib/api-query-options/auth-management";
import { queryKeys } from "~/lib/query-keys";

const SESSION_DATE_FORMATTER = new Intl.DateTimeFormat("en-BD", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function formatSessionRelativeDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return formatDistanceToNow(date, { addSuffix: true });
}

function formatSessionDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return SESSION_DATE_FORMATTER.format(date);
}

function SessionDeviceIcon({ type }: { type: AccountSession["deviceType"] }) {
  if (type === "mobile") return <Smartphone aria-hidden="true" />;
  if (type === "tablet") return <Tablet aria-hidden="true" />;
  if (type === "desktop") return <Laptop aria-hidden="true" />;
  return <MonitorSmartphone aria-hidden="true" />;
}

function AccountSessionsLoading() {
  return (
    <div className="divide-y" aria-label="Loading active sessions">
      {[0, 1].map((item) => (
        <div key={item} className="flex items-center gap-3 p-4">
          <Skeleton className="h-9 w-9 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-44 max-w-full" />
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

interface AccountSessionRowProps {
  session: AccountSession;
  actionDisabled: boolean;
  revoking: boolean;
  onRevoke: (commandId: string) => void;
}

function AccountSessionRow({
  session,
  actionDisabled,
  revoking,
  onRevoke,
}: AccountSessionRowProps) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg border bg-muted/45 text-muted-foreground [&_svg]:h-4 [&_svg]:w-4">
        <SessionDeviceIcon type={session.deviceType} />
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="truncate text-sm font-medium">{session.deviceLabel}</p>
          {session.current && (
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
              Current
            </Badge>
          )}
          {session.impersonated && (
            <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
              Impersonated
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Active {formatSessionRelativeDate(session.lastActiveAt)}
          {session.networkHint ? ` · Network ${session.networkHint}` : ""}
          {` · Expires ${formatSessionDate(session.expiresAt)}`}
        </p>
        <div
          className={
            session.twoFactorVerified
              ? "mt-1 flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400"
              : "mt-1 flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400"
          }
        >
          {session.twoFactorVerified ? (
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ShieldQuestion className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {session.twoFactorVerified
            ? "Two-factor verified for this session"
            : "Two-factor not verified for this session"}
        </div>
      </div>

      {!session.current && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="col-start-2 min-h-11 justify-self-start sm:col-start-3 sm:row-start-1 sm:min-h-9 sm:justify-self-end"
              disabled={actionDisabled}
            >
              {revoking ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <LogOut aria-hidden="true" />
              )}
              Sign out
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="max-w-sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Sign out this device?</AlertDialogTitle>
              <AlertDialogDescription>
                {session.deviceLabel} will need to sign in and complete
                two-factor authentication again.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="min-h-11 sm:min-h-9">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                className="min-h-11 bg-destructive text-destructive-foreground hover:bg-destructive/90 sm:min-h-9"
                onClick={() => onRevoke(session.commandId)}
              >
                Sign out device
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

export function AccountSessions() {
  const queryClient = useQueryClient();
  const sessionsQuery = useQuery(accountSessionsQueryOptions());
  const sessions = sessionsQuery.data?.sessions ?? [];
  const otherSessionCount = sessions.filter((session) => !session.current).length;
  const canRevokeOthers = otherSessionCount > 0 || Boolean(sessionsQuery.data?.hasMore);

  const revokeOne = useMutation({
    mutationFn: (commandId: string) =>
      revokeAccountSession({ data: { commandId } }),
    onSuccess: async (_result, commandId) => {
      queryClient.setQueryData<AccountSessionsResponse>(
        queryKeys.auth.sessions(),
        (current) =>
          current
            ? {
                ...current,
                sessions: current.sessions.filter(
                  (session) => session.commandId !== commandId,
                ),
              }
            : current,
      );
      toast.success("Device signed out");
      await queryClient.invalidateQueries({
        queryKey: queryKeys.auth.sessions(),
      });
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Could not sign out this device"));
      void queryClient.invalidateQueries({
        queryKey: queryKeys.auth.sessions(),
      });
    },
  });

  const revokeOthers = useMutation({
    mutationFn: () => revokeOtherAccountSessions(),
    onSuccess: async (result) => {
      queryClient.setQueryData<AccountSessionsResponse>(
        queryKeys.auth.sessions(),
        (current) =>
          current
            ? {
                sessions: current.sessions.filter((session) => session.current),
                hasMore: false,
              }
            : current,
      );
      toast.success(
        result.revokedCount === 0
          ? "No other signed-in devices were found"
          : `${result.revokedCount} ${result.revokedCount === 1 ? "device" : "devices"} signed out`,
      );
      await queryClient.invalidateQueries({
        queryKey: queryKeys.auth.sessions(),
      });
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Could not sign out other devices"));
      void queryClient.invalidateQueries({
        queryKey: queryKeys.auth.sessions(),
      });
    },
  });

  return (
    <Card className="max-w-4xl rounded-xl shadow-none">
      <CardHeader className="gap-3 border-b p-4 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <MonitorSmartphone className="h-4 w-4" aria-hidden="true" />
            Active sessions
            {!sessionsQuery.isPending && !sessionsQuery.error && (
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                {sessionsQuery.data?.hasMore
                  ? `${sessions.length}+`
                  : sessions.length}
              </Badge>
            )}
          </CardTitle>
          <CardDescription className="text-xs sm:text-sm">
            Review where this account is signed in and remove devices you no
            longer recognize.
          </CardDescription>
        </div>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 w-full shrink-0 sm:min-h-9 sm:w-auto"
              disabled={
                !canRevokeOthers ||
                revokeOne.isPending ||
                revokeOthers.isPending
              }
            >
              {revokeOthers.isPending ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <LogOut aria-hidden="true" />
              )}
              Sign out other devices
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="max-w-sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Sign out every other device?</AlertDialogTitle>
              <AlertDialogDescription>
                Your current session will stay active. Every other device must
                sign in and complete two-factor authentication again.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="min-h-11 sm:min-h-9">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                className="min-h-11 bg-destructive text-destructive-foreground hover:bg-destructive/90 sm:min-h-9"
                onClick={() => revokeOthers.mutate()}
              >
                Sign out other devices
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardHeader>

      <CardContent className="p-0">
        {sessionsQuery.isPending ? (
          <AccountSessionsLoading />
        ) : sessionsQuery.error ? (
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-2">
              <AlertCircle
                className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
                aria-hidden="true"
              />
              <div>
                <p className="text-sm font-medium">Sessions are unavailable</p>
                <p className="text-xs text-muted-foreground">
                  Nothing was changed. Retry to load the current session authority.
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 shrink-0 sm:min-h-9"
              onClick={() => void sessionsQuery.refetch()}
              disabled={sessionsQuery.isFetching}
            >
              <RefreshCw
                className={sessionsQuery.isFetching ? "animate-spin" : ""}
                aria-hidden="true"
              />
              Retry
            </Button>
          </div>
        ) : sessions.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-sm font-medium">No active session was returned</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Refresh this page before changing account security settings.
            </p>
          </div>
        ) : (
          <>
            <div className="divide-y">
              {sessions.map((session) => (
                <AccountSessionRow
                  key={session.commandId}
                  session={session}
                  actionDisabled={revokeOne.isPending || revokeOthers.isPending}
                  revoking={
                    revokeOne.isPending &&
                    revokeOne.variables === session.commandId
                  }
                  onRevoke={(commandId) => revokeOne.mutate(commandId)}
                />
              ))}
            </div>
            {sessionsQuery.data?.hasMore && (
              <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">
                Only the 25 most recent sessions are shown. “Sign out other
                devices” still revokes every other session.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
