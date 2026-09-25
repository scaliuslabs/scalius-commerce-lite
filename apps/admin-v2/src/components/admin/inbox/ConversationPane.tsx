import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, MessagesSquare } from "lucide-react";
import { toast } from "sonner";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { cn } from "@scalius/shared/utils";
import { Badge, type BadgeVariant } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { EmptyState } from "~/components/admin/resource/EmptyState";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { inboxMessages } from "~/i18n/inbox";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { getServerFnError } from "~/lib/api-helpers";
import { ConversationComposer } from "./ConversationComposer";
import { ConversationMessages } from "./ConversationMessages";
import { threadTitle } from "./conversation-format";
import { threadQueryOptions, useMarkRead, useUpdateThread, type StaffThread } from "./inbox-api";
import type { InboxSearch } from "./inbox-search";

const STATUS_BADGE: Record<string, BadgeVariant> = { open: "attention", pending: "info", closed: "secondary" };

export function statusBadge(status: string): BadgeVariant {
  return STATUS_BADGE[status] ?? "secondary";
}

/** One conversation: header with status and assignment, the messages, the reply box. */
export function ConversationPane({
  conversationId,
  currentUserId,
  search,
  className,
  onThread,
}: {
  conversationId: string;
  currentUserId: string | null;
  search: InboxSearch;
  className?: string;
  onThread?: (thread: StaffThread | undefined) => void;
}) {
  const t = useMessages(inboxMessages);
  const canReply = useHasPermission(PERMISSIONS.CONVERSATIONS_REPLY);
  const thread = useQuery(threadQueryOptions(conversationId));
  const update = useUpdateThread();
  const markRead = useMarkRead();
  const data = thread.data;

  useEffect(() => {
    onThread?.(data);
  }, [data, onThread]);

  useEffect(() => {
    if (data) markRead(data);
  }, [data, markRead]);

  if (thread.isPending) {
    return (
      <section aria-busy className={cn("flex flex-col gap-3 p-4", className)}>
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-16 w-2/3" />
        <Skeleton className="ms-auto h-16 w-1/2" />
      </section>
    );
  }
  if (thread.isError || !data) {
    const missing = thread.error instanceof AdminApiResponseError && thread.error.status === 404;
    return (
      <section className={cn("flex flex-col items-start gap-2 p-4", className)}>
        <p className="text-body text-destructive">{missing ? getServerFnError(thread.error) : t("threadLoadFailed")}</p>
        {!missing ? <Button type="button" size="sm" variant="outline" onClick={() => void thread.refetch()}>{t("retry")}</Button> : null}
      </section>
    );
  }

  const change = (patch: { status?: "open" | "pending" | "closed"; assigneeUserId?: string | null }, message: Parameters<typeof t>[0]) => {
    update.mutate({ id: data.id, version: data.version, ...patch }, {
      onSuccess: () => toast.success(t(message)),
      onError: (error) => toast.error(error instanceof AdminApiResponseError && error.status === 409 ? t("conflict") : getServerFnError(error)),
    });
  };
  const mine = Boolean(currentUserId && data.assigneeUserId === currentUserId);

  return (
    <section aria-labelledby="conversation-title" className={cn("flex min-h-0 flex-col", className)}>
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="icon" asChild className="lg:hidden">
          <Link to="/admin/inbox" search={search} aria-label={t("back")}>
            <ArrowLeft aria-hidden />
          </Link>
        </Button>
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 id="conversation-title" className="break-words text-heading-md">
            {data.customerName?.trim() || t("unknownCustomer")}
          </h2>
          <p className="text-body text-muted-foreground">
            {threadTitle(t, data)}
            {data.assigneeName ? ` · ${t("assignedTo", { name: data.assigneeName })}` : ""}
          </p>
        </div>
        <Badge variant={statusBadge(data.status)}>{t(`status.${data.status}`)}</Badge>
        {canReply ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={update.isPending}
              onClick={() => change({ assigneeUserId: mine ? null : currentUserId }, mine ? "toast.unassigned" : "toast.assigned")}
            >
              {mine ? t("unassign") : t("assignToMe")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              loading={update.isPending}
              onClick={() => change(
                { status: data.status === "closed" ? "open" : "closed" },
                data.status === "closed" ? "toast.reopened" : "toast.closed",
              )}
            >
              {data.status === "closed" ? t("reopen") : t("close")}
            </Button>
          </div>
        ) : null}
      </header>
      <ConversationMessages thread={data} currentUserId={currentUserId} className="min-h-0 flex-1 overflow-y-auto p-4" />
      <footer className="border-t p-3">
        {canReply ? (
          <ConversationComposer key={data.id} conversationId={data.id} />
        ) : (
          <p className="text-body text-muted-foreground">{t("readOnly")}</p>
        )}
      </footer>
    </section>
  );
}

export function NoConversationSelected({ className }: { className?: string }) {
  const t = useMessages(inboxMessages);
  return (
    <section className={cn("flex items-center justify-center", className)}>
      <EmptyState icon={MessagesSquare} title={t("pickThread")} description={t("pickThreadBody")} />
    </section>
  );
}
