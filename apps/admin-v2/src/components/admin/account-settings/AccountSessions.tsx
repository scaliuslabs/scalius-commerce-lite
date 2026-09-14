import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  AlertCircle,
  Laptop,
  Loader2,
  LockKeyhole,
  LogOut,
  MonitorSmartphone,
  RefreshCw,
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
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { EmptyState, SettingsSection, StatusBadge } from "~/components/admin/shell";
import { getServerFnError } from "~/lib/api-helpers";
import {
  revokeAccountSession,
  revokeOtherAccountSessions,
  type AccountSession,
  type AccountSessionsResponse,
} from "~/lib/api-functions/auth-management";
import { accountSessionsQueryOptions } from "~/lib/api-query-options/auth-management";
import { queryKeys } from "~/lib/query-keys";
import { formatAdminDate } from "~/lib/admin-time";

function formatSessionRelativeDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return formatDistanceToNow(date, { addSuffix: true });
}

function formatSessionDate(value: string): string {
  return formatAdminDate(value) ?? "Unknown";
}

function SessionDeviceIcon({ type }: { type: AccountSession["deviceType"] }) {
  if (type === "mobile") return <Smartphone aria-hidden="true" />;
  if (type === "tablet") return <Tablet aria-hidden="true" />;
  if (type === "desktop") return <Laptop aria-hidden="true" />;
  return <MonitorSmartphone aria-hidden="true" />;
}

function AccountSessionsLoading() {
  return (
    <div className="divide-y" role="status" aria-label="Loading active sessions">
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
            <StatusBadge tone="info" srLabel="Device:">
              Current
            </StatusBadge>
          )}
          {session.impersonated && (
            <StatusBadge tone="attention" srLabel="Device:">
              Impersonated
            </StatusBadge>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Active {formatSessionRelativeDate(session.lastActiveAt)}
          {session.networkHint ? ` · Network ${session.networkHint}` : ""}
          {` · Expires ${formatSessionDate(session.expiresAt)}`}
        </p>
        <div className="mt-1.5">
          <StatusBadge
            tone={session.twoFactorVerified ? "success" : "attention"}
            srLabel="Two-factor:"
          >
            {session.twoFactorVerified
              ? "Two-factor verified for this session"
              : "Two-factor not verified for this session"}
          </StatusBadge>
        </div>
      </div>

      {session.current ? (
        <div className="col-start-2 flex min-h-11 items-center gap-1.5 justify-self-start text-xs font-medium text-muted-foreground sm:col-start-3 sm:row-start-1 sm:min-h-9 sm:justify-self-end">
          <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />
          Protected
        </div>
      ) : (
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
                variant="destructive"
                className="min-h-11 sm:min-h-9"
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

  const sessionCountLabel = sessionsQuery.data?.hasMore
    ? `${sessions.length}+ signed in`
    : `${sessions.length} signed in`;

  return (
    <SettingsSection
      title="Active sessions"
      description="Every device this account is signed in on. Signing a device out forces a fresh sign-in with two-factor authentication."
      contentClassName="p-0"
      actions={
        <>
          {!sessionsQuery.isPending && !sessionsQuery.error ? (
            <span
              data-testid="account-sessions-count"
              className="mr-auto text-xs text-muted-foreground"
            >
              {sessionCountLabel}
            </span>
          ) : null}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 shrink-0 sm:min-h-9"
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
                  variant="destructive"
                  className="min-h-11 sm:min-h-9"
                  onClick={() => revokeOthers.mutate()}
                >
                  Sign out other devices
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      }
    >
      {sessionsQuery.isPending ? (
        <AccountSessionsLoading />
      ) : sessionsQuery.error ? (
        <EmptyState
          bordered={false}
          icon={AlertCircle}
          heading="Sessions are unavailable"
          body="Device access cannot be changed until the session list loads."
          action={{
            label: "Retry",
            icon: RefreshCw,
            variant: "outline",
            disabled: sessionsQuery.isFetching,
            onClick: () => void sessionsQuery.refetch(),
          }}
        />
      ) : sessions.length === 0 ? (
        <EmptyState
          bordered={false}
          icon={MonitorSmartphone}
          heading="No active session was returned"
          body="Retry before changing device access."
          action={{
            label: "Retry",
            icon: RefreshCw,
            variant: "outline",
            disabled: sessionsQuery.isFetching,
            onClick: () => void sessionsQuery.refetch(),
          }}
        />
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
    </SettingsSection>
  );
}
