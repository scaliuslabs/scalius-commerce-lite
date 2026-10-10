/**
 * One editor's presence, loaded by `PresenceSlot` (lib/realtime/store.tsx)
 * after the first render: joins the editor's key, reports the field this tab
 * is in and whether its draft is dirty, and shows the avatars in the slot. The
 * banner, field rings and save notice (PresenceLayer) float and take no space.
 */
import { useEffect, useRef } from "react";
import { reportFocus, type PresenceSlotProps } from "~/lib/realtime/store";
import { useEditorPresence } from "~/lib/realtime/editor-presence";
import { fieldKeyOf } from "~/lib/realtime/presence-dom";
import PresenceAvatars from "./PresenceAvatars";
import PresenceLayer from "./PresenceLayer";

/**
 * Reports which field of the editor on `key` this tab is in, and whether its
 * draft is dirty: one document listener, scoped by `data-presence-root`.
 */
export function usePresenceReporter(key: string, dirty: boolean): void {
  const field = useRef<string | null>(null);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    const inEditor = (target: EventTarget | null) =>
      target instanceof Element && target.closest("[data-presence-root]")?.getAttribute("data-presence-root") === key;
    // A field focused before this loaded counts too.
    if (inEditor(document.activeElement)) field.current = fieldKeyOf(document.activeElement);
    const onFocusIn = (event: FocusEvent) => {
      field.current = inEditor(event.target) ? fieldKeyOf(event.target as Element) : null;
      reportFocus(key, field.current, dirtyRef.current);
    };
    const onFocusOut = (event: FocusEvent) => {
      // Focus moving to another field reports there; leaving the editor clears the ring.
      if (inEditor(event.relatedTarget)) return;
      field.current = null;
      reportFocus(key, null, dirtyRef.current);
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      reportFocus(key, null, false);
    };
  }, [key]);
  useEffect(() => {
    reportFocus(key, field.current, dirty);
  }, [key, dirty]);
}

export default function EditorPresenceView({
  presenceKey,
  revision,
  dirty,
  changedFields,
  onLoadLatest,
  notices = true,
  onRemoteSave,
}: PresenceSlotProps & { presenceKey: string }) {
  const presence = useEditorPresence(presenceKey, revision);
  usePresenceReporter(presenceKey, dirty);
  const { others, remoteSave, dismissRemoteSave } = presence;
  // An editor without notices handles another person's save itself.
  useEffect(() => {
    if (notices || !remoteSave) return;
    dismissRemoteSave();
    onRemoteSave?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to the notice only
  }, [remoteSave]);
  return (
    <>
      {others.length > 0 ? <PresenceAvatars people={others} /> : null}
      {notices && (others.length > 0 || remoteSave)
        ? <PresenceLayer presence={{ ...presence, presenceKey, dirty, changedFields, onLoadLatest }} />
        : null}
    </>
  );
}
