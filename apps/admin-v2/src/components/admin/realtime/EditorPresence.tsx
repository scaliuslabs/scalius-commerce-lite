/**
 * "Rahim is also editing" and the live save notice for a revision-fenced
 * editor (Shopify and Linear's presence). The editor joins its presence key
 * at once; the visible part (PresenceView.tsx) loads only when someone else
 * is there or has saved, so an editor alone pays almost nothing for it.
 */
import { lazy, Suspense } from "react";
import { useEditorPresence } from "~/lib/realtime/presence";

const PresenceNotice = lazy(() => import("./PresenceView"));

/**
 * `presenceKey` is `presenceKey(prefix, id)` from `@scalius/shared/realtime`
 * (null for a new record). `dirty` picks the notice's advice; `onLoadLatest`
 * loads the other save (keeping unsaved edits where the editor can).
 */
export function EditorPresence({
  presenceKey,
  revision,
  dirty,
  onLoadLatest,
}: {
  presenceKey: string | null;
  revision?: number | null;
  dirty: boolean;
  onLoadLatest?: () => void;
}) {
  const presence = useEditorPresence(presenceKey, revision);
  if (presence.others.length === 0 && !presence.remoteSave) return null;
  return (
    <Suspense fallback={null}>
      <PresenceNotice {...presence} dirty={dirty} onLoadLatest={onLoadLatest} />
    </Suspense>
  );
}
