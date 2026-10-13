import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getApiV1AdminConversationsSavedReplies, getApiV1AdminConversationsSavedRepliesByReplyId, postApiV1AdminConversationsSavedReplies, patchApiV1AdminConversationsSavedRepliesByReplyId } from "@scalius/api-client/sdk";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Field } from "~/components/ui/field";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { apiData, type ApiResult } from "~/lib/api";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { getServerFnError } from "~/lib/api-helpers";
import { useMessages } from "~/i18n";
import { inboxMessages } from "~/i18n/inbox";
import { newRequestKey } from "./inbox-api";

type SavedReply = ApiResult<typeof getApiV1AdminConversationsSavedRepliesByReplyId>;
export function SavedRepliesDialog({ open, onOpenChange, mode, onInsert }: { open: boolean; onOpenChange: (open: boolean) => void; mode: "public" | "internal"; onInsert: (body: string) => void }) {
  const t = useMessages(inboxMessages);
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [editing, setEditing] = useState<SavedReply | "new" | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [archive, setArchive] = useState<SavedReply | null>(null);
  const createId = useRef("");
  const lifetime = useRef<object | null>(null);
  useEffect(() => { const token = {}; lifetime.current = token; return () => { lifetime.current = null; }; }, []);
  useEffect(() => { if (!open) { setEditing(null); setArchive(null); setCursors([undefined]); setError(undefined); } }, [open, mode]);
  const replyMode = mode === "public" ? "reply" : "note";
  const page = useQuery({ queryKey: ["conversations", "saved-replies", replyMode, cursors.at(-1)], enabled: open,
    queryFn: () => apiData(getApiV1AdminConversationsSavedReplies({ query: { mode: replyMode, cursor: cursors.at(-1) } })), staleTime: 0 });
  const run = async (work: () => Promise<void>) => {
    if (busy || !open) return;
    const token = lifetime.current;
    setBusy(true); setError(undefined);
    try { await work(); } catch (failure) { if (lifetime.current === token) setError(getServerFnError(failure)); }
    finally { if (lifetime.current === token) setBusy(false); }
  };
  const edit = (reply: SavedReply | "new") => { setEditing(reply); setTitle(reply === "new" ? "" : reply.title); setBody(reply === "new" ? "" : reply.body); createId.current = newRequestKey(); };
  const insert = (reply: SavedReply) => void run(async () => {
    const token = lifetime.current;
    const fresh = await apiData(getApiV1AdminConversationsSavedRepliesByReplyId({ path: { replyId: reply.id } }));
    if (lifetime.current !== token) return;
    if (fresh.archivedAt !== null || fresh.mode !== replyMode) { setError(t("savedReplyChanged")); void page.refetch(); return; }
    onInsert(fresh.body); onOpenChange(false);
  });
  const save = () => void run(async () => {
    if (!editing || !title.trim() || !body.trim()) return;
    if (editing === "new") await apiData(postApiV1AdminConversationsSavedReplies({ body: { id: createId.current, title, body, mode: replyMode } }));
    else {
      try {
        await apiData(patchApiV1AdminConversationsSavedRepliesByReplyId({ path: { replyId: editing.id }, body: { version: editing.version, title, body } }));
      } catch (failure) {
        if (!(failure instanceof AdminApiResponseError) || failure.status !== 409) throw failure;
        const fresh = await apiData(getApiV1AdminConversationsSavedRepliesByReplyId({ path: { replyId: editing.id } }));
        if (!lifetime.current) return;
        // Preserve this user's text. A second explicit Save uses the refreshed CAS version.
        const available = fresh.archivedAt === null && fresh.mode === replyMode;
        setEditing(available ? fresh : null);
        setError(t(available ? "savedReplyConflict" : "savedReplyChanged"));
        void page.refetch();
        return;
      }
    }
    if (!lifetime.current) return;
    setEditing(null); await page.refetch();
  });
  return <>
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent><DialogHeader><DialogTitle>{t(editing === "new" ? "newSavedReply" : editing ? "editSavedReply" : "savedReplies")}</DialogTitle></DialogHeader>
        {error ? <p role="alert" className="text-body text-destructive">{error}</p> : null}
        {editing ? <div className="space-y-4">
          <Field label={t("savedReplyTitle")}><Input value={title} maxLength={80} disabled={busy} onChange={(event) => setTitle(event.target.value)} /></Field>
          <Field label={t("savedReplyBody")}><Textarea value={body} maxLength={5000} disabled={busy} onChange={(event) => setBody(event.target.value)} /></Field>
        </div> : <div className="flex h-64 flex-col gap-2 overflow-y-auto">
          {page.isPending ? <p role="status">{t("loading")}</p> : page.isError ? <Button variant="outline" onClick={() => void page.refetch()}>{t("retry")}</Button> : page.data.items.length === 0 ? <p className="text-body text-muted-foreground">{t("noSavedReplies")}</p> : page.data.items.map((reply) => <div key={reply.id} className="border-b pb-2">
            <Button variant="ghost" disabled={busy} onClick={() => insert(reply)} className="w-full justify-start">{reply.title}</Button>
            <p className="line-clamp-2 wrap-anywhere text-body text-muted-foreground">{reply.body}</p>
            <div className="flex gap-2"><Button size="sm" variant="ghost" disabled={busy} onClick={() => edit(reply)}>{t("editSavedReply")}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => setArchive(reply)}>{t("archiveSavedReply")}</Button></div>
          </div>)}
          <div className="flex justify-between gap-2"><Button variant="ghost" disabled={cursors.length < 2 || busy} onClick={() => setCursors((current) => current.slice(0, -1))}>{t("previous")}</Button><Button variant="ghost" disabled={!page.data?.nextCursor || busy} onClick={() => setCursors((current) => [...current, page.data!.nextCursor!])}>{t("next")}</Button></div>
        </div>}
        <DialogFooter>{editing ? <><Button variant="outline" disabled={busy} onClick={() => setEditing(null)}>{t("cancel")}</Button><Button loading={busy} disabled={!title.trim() || !body.trim()} onClick={save}>{t("saveReply")}</Button></> : <Button variant="outline" disabled={busy} onClick={() => edit("new")}>{t("newSavedReply")}</Button>}</DialogFooter>
      </DialogContent>
    </Dialog>
    <ConfirmDialog open={Boolean(archive)} onOpenChange={(next) => { if (!next && !busy) setArchive(null); }} title={t("archiveReplyTitle", { title: archive?.title ?? "" })}
      description={t("archiveReplyHelp")} confirmLabel={t("archiveSavedReply")} variant="default" isLoading={busy}
      onConfirm={() => void run(async () => {
        if (!archive) return;
        try { await apiData(patchApiV1AdminConversationsSavedRepliesByReplyId({ path: { replyId: archive.id }, body: { version: archive.version, archived: true } })); }
        finally { if (lifetime.current) { setArchive(null); void page.refetch(); } }
      })} />
  </>;
}
