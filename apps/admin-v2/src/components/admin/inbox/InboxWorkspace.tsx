import { useCallback, useEffect, useState } from "react";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "~/components/ui/sheet";
import { useMediaQuery } from "~/hooks/use-media-query";
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
  const wide = useMediaQuery("(min-width: 1280px)");
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => setDetailsOpen(false), [selectedId, wide]);
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

  const activeThread = thread?.id === selectedId ? thread : undefined;

  return (
    <Sheet open={detailsOpen && !wide && Boolean(activeThread)} onOpenChange={setDetailsOpen}>
      <div className="flex flex-col">
        <PageHeader title={t("title")} actions={selectedId && !wide ? (
          <SheetTrigger asChild>
            <Button variant="outline" disabled={!activeThread}>{t("rail")}</Button>
          </SheetTrigger>
        ) : undefined} />
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
          {wide && activeThread ? (
            <ContextRail thread={activeThread} className="border-s" />
          ) : (
            <div aria-hidden className="hidden border-s xl:block" />
          )}
        </Card>
      </div>
      <SheetContent className="flex flex-col" aria-describedby={undefined} onCloseAutoFocus={(event) => { if (wide) event.preventDefault(); }}>
        <header className="shrink-0 border-b p-4">
          <div className="flex items-center justify-between gap-2">
            <SheetTitle>{t("rail")}</SheetTitle>
            <SheetClose asChild><Button variant="outline">{t("close")}</Button></SheetClose>
          </div>
        </header>
        {!wide && activeThread ? <ContextRail thread={activeThread} className="min-h-0 flex-1" /> : null}
      </SheetContent>
    </Sheet>
  );
}
