import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { postApiV1AdminConversationsByIdSearch } from "@scalius/api-client/sdk";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { apiData } from "~/lib/api";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { inboxMessages } from "~/i18n/inbox";

/** Private text travels only in POST bodies; position pages load on demand, newest first. */
export function ConversationFind({ conversationId, onSelect, onClose }: { conversationId: string; onSelect: (seq: number) => void; onClose: () => void }) {
  const t = useMessages(inboxMessages);
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<{ query: string; seq: number } | null>(null);
  const autoSelected = useRef<string | null>(null);
  const paging = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const current = useRef({ conversationId, query: input.trim() });
  current.current = { conversationId, query: input.trim() };
  useEffect(() => { field.current?.focus(); return () => { current.current = { conversationId: "", query: "" }; }; }, []);
  useEffect(() => { const timeout = setTimeout(() => setQuery(input.trim()), 300); return () => clearTimeout(timeout); }, [input]);
  useEffect(() => { autoSelected.current = null; setSelected(null); }, [conversationId, query]);
  const results = useInfiniteQuery({ queryKey: ["conversations", "find", conversationId, query], enabled: Boolean(query), gcTime: 0,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => apiData(postApiV1AdminConversationsByIdSearch({ path: { id: conversationId }, body: { q: query, cursor: pageParam } })),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const hits = results.data?.pages.flatMap((page) => page.items) ?? [];
  const last = results.data?.pages.at(-1);
  const index = selected?.query === query ? hits.findIndex((hit) => hit.seq === selected.seq) : -1;
  const waiting = input.trim() !== query;
  useEffect(() => {
    const first = results.data?.pages[0]?.items[0] ?? results.data?.pages.flatMap((page) => page.items)[0];
    if (!query || waiting || !first || autoSelected.current === query) return;
    autoSelected.current = query;
    setSelected({ query, seq: first.seq });
    onSelect(first.seq);
  }, [query, waiting, results.data, onSelect]);
  const choose = (seq: number) => { setSelected({ query, seq }); onSelect(seq); };
  const older = async () => {
    if (!query || waiting || paging.current || results.isFetching) return;
    const next = hits[index + 1];
    if (next) { choose(next.seq); return; }
    if (!results.hasNextPage && !results.isError) return;
    paging.current = true;
    try {
      const loaded = results.isError && !results.data ? await results.refetch() : await results.fetchNextPage();
      if (current.current.query !== query || current.current.conversationId !== conversationId) return;
      const hit = loaded.data?.pages.flatMap((page) => page.items)[index + 1];
      if (hit) { autoSelected.current = query; choose(hit.seq); }
    } finally { paging.current = false; }
  };
  const newer = () => { if (!waiting && !paging.current && index > 0) choose(hits[index - 1]!.seq); };
  const canOlder = Boolean(query) && !waiting && !results.isPending && (index + 1 < hits.length || results.hasNextPage || results.isError);
  const count = !query || waiting ? "" : results.isPending ? t("loading") : hits.length
    ? t("matchCount", { current: Math.max(0, index + 1), count: hits.length, more: results.hasNextPage ? "+" : "" })
    : last?.scanExhausted ? t("noFindResults") : results.isError ? "" : t("searchContinue");
  return <section aria-label={t("find")} className="shrink-0 border-b p-2" onKeyDown={(event) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    else if (event.key === "Enter" && event.target === field.current) { event.preventDefault(); if (event.shiftKey) newer(); else void older(); }
  }}>
    <div className="flex items-center gap-1"><Search aria-hidden className="hidden size-4 shrink-0 sm:block" />
      <Input ref={field} type="search" aria-label={t("find")} placeholder={t("find")} className="min-w-0 flex-1" value={input} maxLength={100} onChange={(event) => setInput(event.target.value)} />
      <span role="status" className="whitespace-nowrap text-caption text-muted-foreground">{count}</span>
      <Button variant="ghost" size="icon" aria-label={t(results.isError ? "retry" : "olderMatch")} disabled={!canOlder} aria-busy={results.isFetchingNextPage || undefined} aria-disabled={results.isFetching || undefined} onClick={() => void older()}><ChevronUp aria-hidden /></Button>
      <Button variant="ghost" size="icon" aria-label={t("newerMatch")} disabled={waiting || index <= 0} aria-disabled={results.isFetchingNextPage || undefined} onClick={newer}><ChevronDown aria-hidden /></Button>
      <Button variant="ghost" size="icon" aria-label={t("closeFind")} onClick={onClose}><X aria-hidden /></Button>
    </div>
  </section>;
}
