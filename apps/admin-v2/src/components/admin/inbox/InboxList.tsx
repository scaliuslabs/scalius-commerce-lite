import { useEffect, useId, useRef, useState } from "react";
import { pollWhileOffline } from "~/lib/admin-query-client";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useInboxShortcuts } from "./use-inbox-shortcuts";
import { matchesShortcut } from "../layout/shortcuts";
import { ChevronDown, Inbox, ListFilter, Search } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ConversationAssigneeDialog } from "./ConversationAssigneeDialog";
import { Checkbox } from "~/components/ui/checkbox";
import { ChoiceField, Field } from "~/components/ui/field";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "~/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { useMediaQuery } from "~/hooks/use-media-query";
import { Skeleton } from "~/components/ui/skeleton";
import { IndexTabs } from "~/components/admin/resource/IndexTabs";
import { EmptyState } from "~/components/admin/resource/EmptyState";
import { useMessages } from "~/i18n";
import { inboxMessages } from "~/i18n/inbox";
import { apiData } from "~/lib/api";
import { postApiV1AdminConversationsQuery } from "@scalius/api-client/sdk";
import { ListDate } from "../data-table/ListDate";
import { threadPreview, threadTitle } from "./conversation-format";
import { inboxKeys, type InboxItem, type InboxQuery } from "~/lib/api-query-options/inbox";
import { INBOX_SUBJECTS, type InboxSearch } from "./inbox-search";

const STATUSES = ["open", "pending", "closed"] as const;
const SEARCH_DEBOUNCE_MS = 300;
let focusSearchOnMount = false;

/**
 * The inbox list (Shopify Inbox): Open / Waiting / Closed, who it's assigned
 * to, what it is about (order, store question, review, warranty claim), a
 * search, and one row per conversation with its unread count.
 */
export function InboxList({
  search,
  query: searchQuery = "",
  onQueryChange = () => {},
  active = true,
  selectedId,
  onSearchChange,
  className,
}: {
  search: InboxSearch;
  query?: string;
  onQueryChange?: (query: string) => void;
  active?: boolean;
  selectedId: string | null;
  onSearchChange: (next: Partial<InboxSearch>) => void;
  className?: string;
}) {
  const t = useMessages(inboxMessages);
  const navigate = useNavigate();
  const phone = useMediaQuery("(max-width: 639px)");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [debouncedQuery, setDebouncedQuery] = useState(searchQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const status: "open" | "pending" | "closed" = search.status ?? "open";
  const assignee = search.assignee ?? "all";
  const subject = search.subject ?? "all";

  // The account-scoped input survives sibling route remounts immediately; only the API read waits.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const query: InboxQuery = {
    status,
    assignee: assignee === "all" ? undefined : assignee,
    subjectType: subject === "all" ? undefined : subject,
    q: debouncedQuery || undefined,
    unread: search.unread, sort: search.sort,
  };
  const list = useInfiniteQuery({
    queryKey: [...inboxKeys.list(query), "pages"],
    queryFn: ({ pageParam }) => apiData(postApiV1AdminConversationsQuery({ body: { ...query, cursor: pageParam } })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: pollWhileOffline(30_000),
  });
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const lastPage = list.data?.pages.at(-1);
  const continuingSearch = lastPage?.scanExhausted === false;
  const filtered = Boolean(searchQuery) || assignee !== "all" || subject !== "all" || search.unread || search.sort;
  useEffect(() => {
    if (focusSearchOnMount && !selectedId) {
      focusSearchOnMount = false;
      inputRef.current?.focus();
    }
  }, [selectedId]);
  useInboxShortcuts((event) => {
    if (matchesShortcut("tableSearch", event)) {
      event.preventDefault();
      if (rootRef.current && getComputedStyle(rootRef.current).display === "none") {
        focusSearchOnMount = true;
        void navigate({ to: "/admin/inbox", search });
      } else inputRef.current?.focus();
      return;
    }
    const direction = matchesShortcut("previousItem", event) ? -1 : matchesShortcut("nextItem", event) ? 1 : 0;
    if (!direction) return;
    const index = items.findIndex((item) => item.id === selectedId);
    const next = items[index < 0 ? (direction === 1 ? 0 : items.length - 1) : index + direction];
    if (!next) return;
    event.preventDefault();
    void navigate({ to: "/admin/inbox/$conversationId", params: { conversationId: next.id }, search });
  }, active);


  return (
    <section ref={rootRef} aria-label={t("title")} className={cn("flex min-h-0 flex-col", className)}>
      <header className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <h1 className="text-heading-lg">{t("title")}</h1>
        <DropdownMenu><DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="sm">{t(`status.${status}`)}<ChevronDown aria-hidden /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end"><DropdownMenuRadioGroup value={status} onValueChange={(value) => onSearchChange({ status: value === "open" ? undefined : value as InboxSearch["status"] })}>
            {STATUSES.map((value) => <DropdownMenuRadioItem key={value} value={value}>{t(`status.${value}`)}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup></DropdownMenuContent>
        </DropdownMenu>
      </header>
      <IndexTabs label={t("assigneeFilter")} tabs={[{ value: "me", label: t("mine") }, { value: "none", label: t("unassigned") }, { value: "all", label: t("all") }]}
        value={assignee === "me" || assignee === "none" ? assignee : "all"} onChange={(value) => onSearchChange({ assignee: value === "all" ? undefined : value as InboxSearch["assignee"] })} />
      <div className="flex shrink-0 items-center gap-2 border-b p-3">
        <div className="relative min-w-0 flex-1">
          <Search aria-hidden className="pointer-events-none absolute inset-s-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input ref={inputRef} type="search" maxLength={100} value={searchQuery} onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); onQueryChange(""); } }}
            placeholder={t("search")} aria-label={t("search")}
            // eslint-disable-next-line shadcn/no-restyle -- room for the inline search icon
            className="ps-9" />
        </div>
        <Popover open={filtersOpen && !phone} onOpenChange={setFiltersOpen}>
          <Dialog open={filtersOpen && phone} onOpenChange={setFiltersOpen}>
            {phone ? <DialogTrigger asChild><Button variant="outline" size="icon" aria-label={t("filters")}><ListFilter aria-hidden /></Button></DialogTrigger>
              : <PopoverTrigger asChild><Button variant="outline" size="icon" aria-label={t("filters")}><ListFilter aria-hidden /></Button></PopoverTrigger>}
            <PopoverContent align="end">{!phone ? <InboxFilters search={search} onSearchChange={onSearchChange} /> : null}</PopoverContent>
            <DialogContent><DialogHeader><DialogTitle>{t("filters")}</DialogTitle></DialogHeader>{phone ? <InboxFilters search={search} onSearchChange={onSearchChange} /> : null}</DialogContent>
          </Dialog>
        </Popover>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.isPending ? (
          <ul aria-busy className="divide-y">
            {Array.from({ length: 6 }, (_, index) => (
              <li key={index} className="flex flex-col gap-2 px-3 py-3">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-full" />
              </li>
            ))}
          </ul>
        ) : list.isError ? (
          <div className="flex flex-col items-start gap-2 p-4">
            <p className="text-body text-destructive">{t("loadFailed")}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void list.refetch()}>{t("retry")}</Button>
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title={continuingSearch ? t("searchContinue") : filtered ? t("empty.filtered") : t(`empty.${status}`)}
            description={continuingSearch ? t("searchContinueHelp") : filtered ? t("empty.filteredBody") : t(`empty.${status}Body`)}
            help={!filtered && status === "open"}
            action={filtered ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  onQueryChange("");
                  onSearchChange({ assignee: undefined, subject: undefined, unread: undefined, sort: undefined });
                }}
              >
                {t("clearFilters")}
              </Button>
            ) : undefined}
          />
        ) : (
          <ul className="divide-y">
            {items.map((item) => (
              <InboxRow key={item.id} item={item} search={search} selected={item.id === selectedId} />
            ))}
          </ul>
        )}
        {list.hasNextPage ? (
          <div className="flex justify-center p-3">
            <Button type="button" size="sm" variant="ghost" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t(continuingSearch && items.length === 0 ? "searchContinue" : "loadMore")}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function InboxRow({ item, search, selected }: { item: InboxItem; search: InboxSearch; selected: boolean }) {
  const t = useMessages(inboxMessages);
  const title = item.customerName?.trim() || t("unknownCustomer");
  return (
    <li>
      <Link
        to="/admin/inbox/$conversationId"
        params={{ conversationId: item.id }}
        search={search}
        aria-current={selected ? "page" : undefined}
        data-state={selected ? "selected" : undefined}
        className="relative flex min-w-0 flex-col gap-0.5 px-3 py-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[state=selected]:bg-accent"
      >
        <div className="flex items-center gap-2">
          {item.unread > 0 ? <span aria-hidden className="size-2 shrink-0 rounded-full bg-info" /> : null}
          <span className={item.unread > 0 ? "min-w-0 flex-1 truncate font-semibold" : "min-w-0 flex-1 truncate font-medium"}>{title}</span>
          <ListDate value={item.lastMessageAt} compact className="shrink-0 text-caption" />
        </div>
        <p className="truncate text-body text-muted-foreground">{threadPreview(t, item) || t("attachmentOnly")}</p>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-body text-muted-foreground">{threadTitle(t, item)}</span>
          {item.unread > 0 ? <Badge variant="info">{t("unread", { count: item.unread })}</Badge> : null}
        </div>
        <span className="sr-only">{t(`status.${item.status}`)}{item.assigneeName ? ` · ${t("assignedTo", { name: item.assigneeName })}` : ""}</span>
      </Link>
    </li>
  );
}

function InboxFilters({ search, onSearchChange }: { search: InboxSearch; onSearchChange: (next: Partial<InboxSearch>) => void }) {
  const t = useMessages(inboxMessages);
  const canAssign = useHasPermission(PERMISSIONS.CONVERSATIONS_REPLY);
  const [teamOpen, setTeamOpen] = useState(false);
  const unreadId = useId();
  return <div className="flex flex-col gap-3">
    {canAssign && search.assignee !== "me" && search.assignee !== "none" ? <>
      <Button variant="outline" onClick={() => setTeamOpen(true)}>{t(search.assignee ? "selectedTeammate" : "chooseTeammate")}</Button>
      <ConversationAssigneeDialog open={teamOpen} onOpenChange={setTeamOpen} selectedId={search.assignee ?? null} currentUserId={null} onSelect={(id) => onSearchChange({ assignee: id ?? "none" })} />
    </> : null}
    <SearchableSelect ariaLabel={t("subjectFilter")} value={search.subject ?? "all"}
      onValueChange={(value) => onSearchChange({ subject: value === "all" ? undefined : value as InboxSearch["subject"] })}
      triggerClassName="w-full" options={[{ value: "all", label: t("subject.all") }, ...INBOX_SUBJECTS.map((value) => ({ value, label: t(`subject.${value}`) }))]} />
    <ChoiceField id={unreadId} label={t("unreadOnly")} control={<Checkbox id={unreadId} checked={search.unread ?? false} onCheckedChange={(checked) => onSearchChange({ unread: checked === true ? true : undefined })} />} />
    <Field label={t("sort")}><SearchableSelect value={search.sort ?? "latest"} onValueChange={(value) => onSearchChange({ sort: value === "waiting_longest" ? value : undefined })} options={[{ value: "latest", label: t("sortLatest") }, { value: "waiting_longest", label: t("sortWaiting") }]} /></Field>
    <Button variant="ghost" onClick={() => onSearchChange({ assignee: undefined, subject: undefined, unread: undefined, sort: undefined })}>{t("clearFilters")}</Button>
  </div>;
}
