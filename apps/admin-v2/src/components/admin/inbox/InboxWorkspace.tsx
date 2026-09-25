import { useCallback, useState } from "react";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { Card } from "~/components/ui/card";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { useMessages } from "~/i18n";
import { inboxMessages } from "~/i18n/inbox";
import { ContextRail } from "./ContextRail";
import { ConversationPane, NoConversationSelected } from "./ConversationPane";
import { InboxList } from "./InboxList";
import type { StaffThread } from "~/lib/api-query-options/inbox";
import type { InboxSearch } from "./inbox-search";

/**
 * The inbox (Shopify Inbox layout): the list, the open conversation and its
 * context side by side on wide screens; on phones the list and the
 * conversation are separate pages.
 */
export function InboxWorkspace({ search, selectedId }: { search: InboxSearch; selectedId: string | null }) {
  const t = useMessages(inboxMessages);
  const navigate = useNavigate();
  const currentUserId = useRouteContext({ from: "/admin", select: (context) => context.user?.id ?? null });
  const [thread, setThread] = useState<StaffThread | undefined>(undefined);

  const onSearchChange = useCallback((next: Partial<InboxSearch>) => {
    void navigate({
      to: selectedId ? "/admin/inbox/$conversationId" : "/admin/inbox",
      params: selectedId ? { conversationId: selectedId } : undefined,
      search: (current: InboxSearch) => {
        const merged: InboxSearch = { ...current, ...next };
        for (const key of Object.keys(merged) as Array<keyof InboxSearch>) {
          if (merged[key] === undefined) delete merged[key];
        }
        return merged;
      },
      replace: true,
    } as Parameters<typeof navigate>[0]);
  }, [navigate, selectedId]);

  return (
    <div className="flex flex-col">
      <PageHeader title={t("title")} />
      <Card className="grid h-[calc(100svh-10rem)] min-h-96 grid-cols-1 overflow-clip lg:grid-cols-[20rem_minmax(0,1fr)] xl:grid-cols-[20rem_minmax(0,1fr)_18rem]">
        <InboxList
          search={search}
          selectedId={selectedId}
          onSearchChange={onSearchChange}
          className={selectedId ? "hidden border-e lg:flex" : "flex border-e"}
        />
        {selectedId ? (
          <ConversationPane
            conversationId={selectedId}
            currentUserId={currentUserId}
            search={search}
            onThread={setThread}
            className="flex"
          />
        ) : (
          <NoConversationSelected className="hidden lg:flex" />
        )}
        {selectedId && thread && thread.id === selectedId ? (
          <ContextRail thread={thread} className="hidden border-s xl:flex" />
        ) : (
          <div aria-hidden className="hidden border-s xl:block" />
        )}
      </Card>
    </div>
  );
}
