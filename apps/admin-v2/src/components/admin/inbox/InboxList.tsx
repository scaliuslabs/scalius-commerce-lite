import { useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Inbox, Search } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import { Skeleton } from "~/components/ui/skeleton";
import { IndexTabs } from "~/components/admin/resource/IndexTabs";
import { EmptyState } from "~/components/admin/resource/EmptyState";
import { useMessages } from "~/i18n";
import { inboxMessages } from "~/i18n/inbox";
import { apiData } from "~/lib/api";
import { getApiV1AdminConversations } from "@scalius/api-client/sdk";
import { formatOrderTimestamp } from "../orderview/formatters";
import { threadPreview, threadTitle } from "./conversation-format";
import { inboxKeys, type InboxItem, type InboxQuery } from "~/lib/api-query-options/inbox";
import { INBOX_SUBJECTS, type InboxSearch } from "./inbox-search";

const STATUSES = ["open", "pending", "closed"] as const;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * The inbox list (Shopify Inbox): Open / Waiting / Closed, who it's assigned
 * to, what it is about (order, store question, review, warranty claim), a
 * search, and one row per conversation with its unread count.
 */
export function InboxList({
  search,
  selectedId,
  onSearchChange,
  className,
}: {
  search: InboxSearch;
  selectedId: string | null;
  onSearchChange: (next: Partial<InboxSearch>) => void;
  className?: string;
}) {
  const t = useMessages(inboxMessages);
  const [term, setTerm] = useState(search.q ?? "");
  const status: "open" | "pending" | "closed" = search.status ?? "open";
  const assignee = search.assignee ?? "all";
  const subject = search.subject ?? "all";

  // Typing searches after a pause; the term lives in component state until then.
  useEffect(() => {
    const trimmed = term.trim();
    if (trimmed === (search.q ?? "")) return;
    const timer = setTimeout(() => onSearchChange({ q: trimmed || undefined }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term, search.q, onSearchChange]);

  const query: InboxQuery = {
    status,
    assignee: assignee === "all" ? undefined : assignee,
    subjectType: subject === "all" ? undefined : subject,
    q: search.q || undefined,
  };
  const list = useInfiniteQuery({
    queryKey: [...inboxKeys.list(query), "pages"],
    queryFn: ({ pageParam }) => apiData(getApiV1AdminConversations({ query: { ...query, cursor: pageParam } })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = Boolean(search.q) || assignee !== "all" || subject !== "all";

  return (
    <section aria-label={t("title")} className={cn("flex min-h-0 flex-col", className)}>
      <IndexTabs
        label={t("title")}
        tabs={STATUSES.map((value) => ({ value, label: t(`status.${value}`) }))}
        value={status}
        onChange={(value) => onSearchChange({ status: value === "open" ? undefined : value })}
      />
      <div className="flex flex-col gap-2 border-b p-3">
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder={t("search")}
            aria-label={t("search")}
            // eslint-disable-next-line shadcn/no-restyle -- room for the search icon inside the field
            className="pl-9"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <NativeSelect
            aria-label={t("assigneeFilter")}
            value={assignee}
            onValueChange={(value) => onSearchChange({ assignee: value === "all" ? undefined : (value as InboxSearch["assignee"]) })}
          >
            <option value="all">{t("assignee.all")}</option>
            <option value="me">{t("assignee.me")}</option>
            <option value="none">{t("assignee.none")}</option>
          </NativeSelect>
          <NativeSelect
            aria-label={t("subjectFilter")}
            value={subject}
            onValueChange={(value) => onSearchChange({ subject: value === "all" ? undefined : (value as InboxSearch["subject"]) })}
          >
            <option value="all">{t("subject.all")}</option>
            {INBOX_SUBJECTS.map((value) => (
              <option key={value} value={value}>{t(`subject.${value}`)}</option>
            ))}
          </NativeSelect>
        </div>
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
            title={filtered ? t("empty.filtered") : t(`empty.${status}`)}
            description={filtered ? t("empty.filteredBody") : t(`empty.${status}Body`)}
            action={filtered ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setTerm("");
                  onSearchChange({ q: undefined, assignee: undefined, subject: undefined });
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
              {t("loadMore")}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function InboxRow({ item, search, selected }: { item: InboxItem; search: InboxSearch; selected: boolean }) {
  const t = useMessages(inboxMessages);
  const when = formatOrderTimestamp(item.lastMessageAt);
  const title = item.customerName?.trim() || t("unknownCustomer");
  return (
    <li>
      <Link
        to="/admin/inbox/$conversationId"
        params={{ conversationId: item.id }}
        search={search}
        aria-current={selected ? "page" : undefined}
        data-state={selected ? "selected" : undefined}
        className="flex flex-col gap-1 px-3 py-3 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[state=selected]:bg-accent"
      >
        <div className="flex items-center gap-2">
          {item.unread > 0 ? <span aria-hidden className="size-2 shrink-0 rounded-full bg-info" /> : null}
          <span className={item.unread > 0 ? "min-w-0 flex-1 truncate font-semibold" : "min-w-0 flex-1 truncate font-medium"}>{title}</span>
          {when ? <span className="shrink-0 text-body text-muted-foreground">{when}</span> : null}
        </div>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-body text-muted-foreground">{threadTitle(t, item)}</span>
          {item.unread > 0 ? <Badge variant="info">{t("unread", { count: item.unread })}</Badge> : null}
        </div>
        <p className="line-clamp-2 text-body text-muted-foreground">{threadPreview(t, item) || t("attachmentOnly")}</p>
      </Link>
    </li>
  );
}
