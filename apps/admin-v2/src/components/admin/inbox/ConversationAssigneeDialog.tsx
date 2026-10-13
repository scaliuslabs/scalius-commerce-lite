import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getApiV1AdminConversationsAssignees } from "@scalius/api-client/sdk";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { apiData } from "~/lib/api";
import { useMessages } from "~/i18n";
import { inboxMessages } from "~/i18n/inbox";

/** Explicit 50-person pages: no client search pretending to search the whole team. */
export function ConversationAssigneeDialog({ open, onOpenChange, onSelect, selectedId, currentUserId }: {
  open: boolean; onOpenChange: (open: boolean) => void; onSelect: (id: string | null) => void;
  selectedId: string | null; currentUserId: string | null;
}) {
  const t = useMessages(inboxMessages);
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  useEffect(() => { if (!open) setCursors([undefined]); }, [open]);
  const cursor = cursors.at(-1);
  const page = useQuery({ queryKey: ["conversations", "assignees", cursor], enabled: open,
    queryFn: () => apiData(getApiV1AdminConversationsAssignees({ query: { cursor } })), staleTime: 0 });
  const choose = (id: string | null) => { if (!open) return; onSelect(id); onOpenChange(false); };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent><DialogHeader><DialogTitle>{t("assigneeFilter")}</DialogTitle></DialogHeader>
      <div className="flex h-64 flex-col gap-1 overflow-y-auto">
        {currentUserId ? <Button variant="ghost" onClick={() => choose(currentUserId)}>{t("assignToMe")}</Button> : null}
        <Button variant="ghost" onClick={() => choose(null)}>{t("unassign")}</Button>
        {page.isPending ? <p role="status" className="text-body text-muted-foreground">{t("loading")}</p> : page.isError ? <Button variant="outline" onClick={() => void page.refetch()}>{t("retry")}</Button> : page.data.items.map((person) => (
          <Button key={person.id} variant="ghost" aria-pressed={selectedId === person.id} disabled={page.isFetching} onClick={() => { if (!page.isFetching) choose(person.id); }}>{person.name}</Button>
        ))}
      </div>
      <DialogFooter>
        <Button variant="outline" disabled={cursors.length < 2 || page.isFetching} onClick={() => setCursors((current) => current.slice(0, -1))}>{t("previous")}</Button>
        <Button variant="outline" disabled={!page.data?.nextCursor || page.isFetching} onClick={() => setCursors((current) => [...current, page.data!.nextCursor!])}>{t("next")}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
