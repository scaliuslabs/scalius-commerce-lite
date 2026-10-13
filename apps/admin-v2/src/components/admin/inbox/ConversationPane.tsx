import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, MessagesSquare, MoreHorizontal, PanelLeftClose, PanelLeftOpen, PanelRight } from "lucide-react";
import { toast } from "~/lib/toast";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { cn } from "@scalius/shared/utils";
import { Badge, type BadgeVariant } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { PresenceSlot, presenceKey } from "~/lib/realtime/store";
import { Skeleton } from "~/components/ui/skeleton";
import { EmptyState } from "~/components/admin/states/EmptyState";
import { ErrorState } from "~/components/admin/states/ErrorState";
import { RecordNotFound } from "~/components/admin/states/NotFound";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { inboxMessages } from "~/i18n/inbox";
import { withDashboardBasePath } from "~/lib/dashboard-base-path";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { getServerFnError } from "~/lib/api-helpers";
import { useInboxShortcuts } from "./use-inbox-shortcuts";
import { matchesShortcut } from "../layout/shortcuts";
import type { DraftMode } from "~/lib/inbox-drafts";
import { ConversationFind } from "./ConversationFind";
import { ConversationAssigneeDialog } from "./ConversationAssigneeDialog";
import { ConversationComposer } from "./ConversationComposer";
import { ConversationMessages, type ConversationFollowRequest } from "./ConversationMessages";
import { threadTitle } from "./conversation-format";
import { threadQueryOptions, type StaffThread } from "~/lib/api-query-options/inbox";
import { useMarkRead, useUpdateThread } from "./inbox-api";
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
  active = true,
  split = false, listHidden = false, onToggleList, detailsOpen = false, onToggleDetails, detailsTrigger,
}: {
  conversationId: string;
  currentUserId: string | null;
  search: InboxSearch;
  className?: string;
  onThread?: (thread: StaffThread | undefined) => void;
  active?: boolean;
  split?: boolean; listHidden?: boolean; onToggleList?: () => void;
  detailsOpen?: boolean; onToggleDetails?: () => void; detailsTrigger?: RefObject<HTMLButtonElement | null>;
}) {
  const t = useMessages(inboxMessages);
  const canReply = useHasPermission(PERMISSIONS.CONVERSATIONS_REPLY);
  const canViewCustomer = useHasPermission(PERMISSIONS.CUSTOMERS_VIEW);
  const thread = useQuery(threadQueryOptions(conversationId));
  const update = useUpdateThread();
  const markRead = useMarkRead();
  const data = thread.data;
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const moreActions = useRef<HTMLButtonElement>(null);
  const closeFind = () => { setFindOpenFor(undefined); moreActions.current?.focus({ preventScroll: true }); };
  const [findOpenFor, setFindOpenFor] = useState<string>();
  const findOpen = findOpenFor === conversationId;
  const [findRequest, setFindRequest] = useState<{ seq: number; serial: number; conversationId: string }>();
  const [focusRequest, setFocusRequest] = useState<{ mode: DraftMode; serial: number; conversationId: string }>();
  useEffect(() => { setFocusRequest(undefined); setAssignmentOpen(false); setFindOpenFor(undefined); setFindRequest(undefined); }, [conversationId]);
  useInboxShortcuts((event) => {
    if (!data || thread.isError || !canReply) return;
    if (matchesShortcut("inboxCompose", event) && event.target instanceof Element && event.target.closest("button, a:not([aria-current=page])")) return;
    const mode = matchesShortcut("inboxCompose", event) || matchesShortcut("inboxReply", event) ? "public" : matchesShortcut("inboxNote", event) ? "internal" : null;
    if (mode) {
      event.preventDefault();
      setFocusRequest((current) => ({ mode, serial: (current?.serial ?? 0) + 1, conversationId: data.id }));
      return;
    }
    if (update.isPending) return;
    if (matchesShortcut("inboxAssign", event)) { event.preventDefault(); setAssignmentOpen(true); }
    else if (matchesShortcut("inboxClose", event)) { event.preventDefault(); change({ status: data.status === "closed" ? "open" : "closed" }, data.status === "closed" ? "toast.reopened" : "toast.closed"); }
  }, active);

  const [followRequest, setFollowRequest] = useState<ConversationFollowRequest>();
  const onReadFrontier = useCallback((seq: number) => {
    if (data) markRead(data, seq);
  }, [data, markRead]);

  useEffect(() => {
    onThread?.(data);
  }, [data, onThread]);

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
      <section className={cn("p-4", className)}>
        {missing ? (
          <RecordNotFound resource={{ noun: "conversation", list: "/admin/inbox" }} />
        ) : (
          <ErrorState layout="card" title={t("threadLoadFailed")} error={thread.error} onRetry={() => void thread.refetch()} />
        )}
      </section>
    );
  }

  const change = (patch: { status?: "open" | "pending" | "closed"; assigneeUserId?: string | null }, message: Parameters<typeof t>[0]) => {
    update.mutate({ id: data.id, version: data.version, ...patch }, {
      onSuccess: () => toast.success(t(message)),
      onError: (error) => toast.error(error instanceof AdminApiResponseError && error.status === 409 ? t("conflict") : getServerFnError(error)),
    });
  };

  return (
    <section aria-labelledby="conversation-title" data-presence-root={presenceKey("conversation", data.id)} className={cn("@container/thread flex min-h-0 flex-col", className)}>
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        {!split ? <Button variant="ghost" size="icon" asChild>
          <Link to="/admin/inbox" search={search} aria-label={t("back")}><ArrowLeft aria-hidden /></Link>
        </Button> : onToggleList ? <Tooltip><TooltipTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={t(listHidden ? "showList" : "hideList")} aria-pressed={listHidden} onClick={onToggleList}>
            {listHidden ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
          </Button>
        </TooltipTrigger><TooltipContent>{t(listHidden ? "showList" : "hideList")}</TooltipContent></Tooltip> : null}
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 id="conversation-title" className="truncate text-heading-md" title={data.customerName?.trim() || t("unknownCustomer")}>
            {data.customerName?.trim() || t("unknownCustomer")}
          </h2>
          <p className="truncate text-body text-muted-foreground" title={threadTitle(t, data)}>
            {threadTitle(t, data)}{!split && data.assigneeName ? ` · ${data.assigneeName}` : ""}
          </p>
        </div>
        <div className="hidden @3xl/thread:block"><PresenceSlot presenceKey={presenceKey("conversation", data.id)} dirty={false} readOnly notices={false} /></div>
        {split && data.status !== "open" ? <Badge variant={statusBadge(data.status)}>{t(`status.${data.status}`)}</Badge> : null}
        {canReply && split ? <div className="hidden shrink-0 items-center gap-2 @2xl/thread:flex">
          <Button type="button" size="sm" variant="ghost" disabled={update.isPending}
            onClick={() => setAssignmentOpen(true)}>
            {data.assigneeName ?? t("unassigned")}
          </Button>
          <Button type="button" size="sm" variant="outline" loading={update.isPending}
            onClick={() => change({ status: data.status === "closed" ? "open" : "closed" }, data.status === "closed" ? "toast.reopened" : "toast.closed")}>
            {t(data.status === "closed" ? "reopen" : "close")}
          </Button>
        </div> : null}
        {onToggleDetails ? <Tooltip><TooltipTrigger asChild>
          <Button ref={detailsTrigger} variant="ghost" size="icon" aria-label={t("rail")} aria-pressed={detailsOpen} onClick={onToggleDetails}><PanelRight aria-hidden /></Button>
        </TooltipTrigger><TooltipContent>{t("rail")}</TooltipContent></Tooltip> : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button ref={moreActions} variant="ghost" size="icon" aria-label={t("moreActions")}><MoreHorizontal aria-hidden /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {canReply ? <>
              <DropdownMenuItem disabled={update.isPending} onSelect={() => setAssignmentOpen(true)}>
                {t("assigneeFilter")}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={update.isPending} onSelect={() => change({ status: "pending" }, "toast.waiting")}>{t("markWaiting")}</DropdownMenuItem>
              <DropdownMenuItem disabled={update.isPending} onSelect={() => change({ status: data.status === "closed" ? "open" : "closed" }, data.status === "closed" ? "toast.reopened" : "toast.closed")}>
                {t(data.status === "closed" ? "reopen" : "close")}
              </DropdownMenuItem>
            </> : null}
<DropdownMenuItem onSelect={() => setFindOpenFor(data.id)}>{t("find")}</DropdownMenuItem>
            {data.customerId && canViewCustomer ? <DropdownMenuItem asChild><Link to="/admin/customers/$customerId/edit" params={{ customerId: data.customerId }}>{t("viewCustomer")}</Link></DropdownMenuItem> : null}
            <DropdownMenuItem onSelect={() => { void navigator.clipboard.writeText(new URL(withDashboardBasePath(`/admin/inbox/${encodeURIComponent(data.id)}`), window.location.origin).href).then(() => toast.success(t("linkCopied"))).catch(() => toast.error(t("copyFailed"))); }}>{t("copyLink")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      {canReply ? <ConversationAssigneeDialog open={assignmentOpen} onOpenChange={setAssignmentOpen} selectedId={data.assigneeUserId} currentUserId={currentUserId}
        onSelect={(assigneeUserId) => change({ assigneeUserId }, assigneeUserId ? "toast.assigned" : "toast.unassigned")} /> : null}
      {findOpen ? <ConversationFind key={data.id} conversationId={data.id} onClose={closeFind} onSelect={(seq) => setFindRequest((current) => ({ seq, serial: (current?.serial ?? 0) + 1, conversationId: data.id }))} /> : null}
      <ConversationMessages finding={findOpen} findRequest={findRequest?.conversationId === data.id ? findRequest : undefined} onCloseFind={closeFind} thread={data} currentUserId={currentUserId} active={active && !findOpen} onReadFrontier={onReadFrontier}
        followRequest={followRequest} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-4" />
      <footer className="shrink-0 border-t p-2 sm:p-3">
        {canReply ? (
          <ConversationComposer key={data.id} conversationId={data.id} focusRequest={focusRequest?.conversationId === data.id ? focusRequest : undefined}
            onPosted={(posted) => { setFindOpenFor(undefined); setFollowRequest({ conversationId: posted.id, seq: posted.messages.at(-1)?.seq ?? 0 }); }} />
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
      <EmptyState icon={MessagesSquare} title={t("pickThread")} description={t("pickThreadBody")} help={false} card={false} />
    </section>
  );
}
