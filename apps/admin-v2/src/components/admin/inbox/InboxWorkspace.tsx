import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { activateInboxDraftAccount, getInboxSearch, setInboxSearch, subscribeInboxDrafts } from "~/lib/inbox-drafts";
import { getDashboardBasePath } from "~/lib/dashboard-base-path";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import { Card } from "~/components/ui/card";
import { useMessages } from "~/i18n";
import { inboxMessages } from "~/i18n/inbox";
import { ContextRail } from "./ContextRail";
import { ConversationPane, NoConversationSelected } from "./ConversationPane";
import { InboxEmpty, InboxList, type InboxView } from "./InboxList";
import { inboxSummaryQueryOptions, type StaffThread } from "~/lib/api-query-options/inbox";
import { validateInboxSearch, type InboxSearch } from "./inbox-search";

type WorkspaceProps = { search: InboxSearch; selectedId: string | null };

export function InboxWorkspace(props: WorkspaceProps) {
  const currentUserId = useRouteContext({ from: "/admin", select: (context) => context.user?.id ?? null });
  return <AccountWorkspace key={currentUserId} {...props} currentUserId={currentUserId} />;
}

/** Layout preferences contain no conversation or search data. Width belongs to this workspace, not the browser. */
function AccountWorkspace({ search, selectedId, currentUserId }: WorkspaceProps & { currentUserId: string | null }) {
  const t = useMessages(inboxMessages);
  const navigate = useNavigate();
  const summary = useQuery(inboxSummaryQueryOptions());
  const initializedScope = useRef(false);
  const query = useSyncExternalStore(subscribeInboxDrafts, () => getInboxSearch(currentUserId), () => "");
  useEffect(() => activateInboxDraftAccount(currentUserId), [currentUserId]);
  const frame = useRef<HTMLDivElement>(null);
  const detailsTrigger = useRef<HTMLButtonElement>(null);
  const [size, setSize] = useState({ width: 0, bottomInset: 0 });
  const [preferences, setPreferences] = useState<{ details?: boolean; hideList?: boolean }>({});
  const preferenceKey = `scalius:inbox-layout:${getDashboardBasePath()}:${currentUserId ?? ""}`;
  useEffect(() => {
    try {
      const value = JSON.parse(localStorage.getItem(preferenceKey) ?? "{}");
      setPreferences({ details: typeof value.details === "boolean" ? value.details : undefined, hideList: value.hideList === true });
    } catch { /* Use the width-based default when storage is unavailable. */ }
  }, [preferenceKey]);
  const remember = (patch: Partial<typeof preferences>) => {
    const next = { ...preferences, ...patch };
    setPreferences(next);
    try { localStorage.setItem(preferenceKey, JSON.stringify(next)); } catch { /* Layout still works in this page. */ }
  };
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const viewport = window.visualViewport;
      // The shell owns height. Only account for a keyboard that overlays its layout viewport.
      const bottomInset = viewport && Math.abs(viewport.scale - 1) > 0.01 ? 0
        : Math.max(0, window.innerHeight - (viewport?.height ?? window.innerHeight) - (viewport?.offsetTop ?? 0));
      setSize((current) => current.width === rect.width && current.bottomInset === bottomInset
        ? current : { width: rect.width, bottomInset });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); window.visualViewport?.removeEventListener("resize", measure); window.visualViewport?.removeEventListener("scroll", measure); };
  }, []);
  const split = size.width >= 768;
  const wide = size.width >= 1024;
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => setSheetOpen(false), [selectedId, wide]);
  const [thread, setThread] = useState<StaffThread>();
  const activeThread = thread?.id === selectedId ? thread : undefined;
  const railOpen = wide && (preferences.details ?? true);
  const listHidden = Boolean(selectedId && (!split || preferences.hideList));
  const detailsOpen = wide ? railOpen : sheetOpen;
  const [listView, setListView] = useState<InboxView>("loading");
  const emptyInPane = split && !selectedId;
  const onSearchChange = useCallback((next: Partial<InboxSearch>) => {
    if (Object.hasOwn(next, "assignee")) {
      try { localStorage.setItem(`${preferenceKey}:scope`, next.assignee ?? "all"); } catch { /* Current view remains usable. */ }
    }
    void navigate({
      to: selectedId ? "/admin/inbox/$conversationId" : "/admin/inbox",
      params: selectedId ? { conversationId: selectedId } : undefined,
      search: (current: InboxSearch) => {
        const merged: InboxSearch = { ...validateInboxSearch(current as Record<string, unknown>), ...next };
        for (const key of Object.keys(merged) as Array<keyof InboxSearch>) if (merged[key] === undefined) delete merged[key];
        return merged;
      }, replace: true,
    } as Parameters<typeof navigate>[0]);
  }, [navigate, selectedId, preferenceKey]);
  useEffect(() => {
    if (initializedScope.current || !summary.data) return;
    initializedScope.current = true;
    if (search.assignee !== undefined || search.status || search.subject || search.unread || search.sort) return;
    let scope: string | null = null;
    try { scope = localStorage.getItem(`${preferenceKey}:scope`); } catch { /* Default from the existing summary. */ }
    const assignee = scope === "me" || scope === "none" ? scope : scope === "all" ? undefined : summary.data.mineOpen > 0 ? "me" : undefined;
    if (assignee) onSearchChange({ assignee });
  }, [summary.data, search, onSearchChange, preferenceKey]);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("q")) onSearchChange({});
  }, [onSearchChange]);

  return (
    <Sheet open={sheetOpen && !wide && Boolean(activeThread)} onOpenChange={setSheetOpen}>
      <div ref={frame} className="flex min-h-0 min-w-0 flex-1 flex-col pb-(--inbox-keyboard)" style={{ "--inbox-keyboard": `${size.bottomInset}px` } as CSSProperties}>
        {listHidden ? <h1 className="sr-only">{t("title")}</h1> : null}
        <Card className="flex min-h-0 flex-1 overflow-clip">
          <InboxList search={search} query={query} onQueryChange={(value) => setInboxSearch(currentUserId, value)}
            active={!sheetOpen || wide} selectedId={selectedId} onSearchChange={onSearchChange}
            emptyElsewhere={emptyInPane} onViewChange={setListView}
            className={listHidden ? "hidden" : split ? "flex w-72 shrink-0 border-e xl:w-80" : "flex min-w-0 flex-1"} />
          {selectedId ? <ConversationPane conversationId={selectedId} currentUserId={currentUserId} search={search}
            active={!sheetOpen || wide} onThread={setThread} className="flex min-w-0 flex-1"
            split={split} listHidden={listHidden} onToggleList={() => remember({ hideList: !preferences.hideList })}
            detailsOpen={detailsOpen} detailsTrigger={detailsTrigger}
            onToggleDetails={() => wide ? remember({ details: !railOpen }) : setSheetOpen((open) => !open)} />
            : !split ? null
              // "Select a conversation" only when there is one to select; an empty view says so here, once.
              : listView === "rows" ? <NoConversationSelected className="flex min-w-0 flex-1" />
                : listView === "loading" ? <section aria-hidden className="flex min-w-0 flex-1" />
                  : <section className="flex min-w-0 flex-1 items-center justify-center">
                    <InboxEmpty kind={listView} onClear={() => {
                      setInboxSearch(currentUserId, "");
                      onSearchChange({ assignee: undefined, subject: undefined, unread: undefined, sort: undefined });
                    }} />
                  </section>}
          {railOpen && activeThread ? <ContextRail thread={activeThread} className="w-72 shrink-0 border-s" /> : null}
        </Card>
      </div>
      <SheetContent className="flex flex-col" aria-describedby={undefined} onCloseAutoFocus={(event) => {
        if (detailsTrigger.current?.isConnected) { event.preventDefault(); detailsTrigger.current.focus(); }
      }}>
        <SheetHeader>
          <SheetTitle>{t("rail")}</SheetTitle>
        </SheetHeader>
        {!wide && sheetOpen && activeThread ? <ContextRail thread={activeThread} className="min-h-0 flex-1" /> : null}
      </SheetContent>
    </Sheet>
  );
}
