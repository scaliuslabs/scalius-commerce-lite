import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type Ref } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { useMessages } from "~/i18n";
import { themeEditorMessages } from "~/i18n/theme-editor";
import type { FrameBox } from "./canvas-geometry";
import type { CanvasTextResult, CanvasTextTarget } from "./canvas-text";
import type { ThemePreviewRect } from "@scalius/shared/theme-editor-bridge";

export interface CanvasTextSession {
  nonce: number;
  target: CanvasTextTarget;
  label: string;
  multiline: boolean;
  maxLength: number;
  rect: ThemePreviewRect;
}
export interface CanvasTextHandle {
  /** Context switches wait for composition and a successful commit. */
  finish: (after?: () => void) => void;
}

/** A native buffer above the iframe: a render swap cannot replace its caret or IME. */
export function CanvasTextEditor({ session, box, rect, controlRef, onCommit, onClose, onDirtyChange }: {
  session: CanvasTextSession;
  box: FrameBox;
  rect?: ThemePreviewRect;
  controlRef: Ref<CanvasTextHandle>;
  onCommit: (value: string, baseline: string) => CanvasTextResult;
  onClose: (restoreFocus: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const t = useMessages(themeEditorMessages);
  const hintId = useId();
  const input = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const ended = useRef(false);
  const closed = useRef(false);
  const pending = useRef<(() => void) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishRef = useRef<(after?: () => void, replacement?: string) => void>(() => {});
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const [panelHeight, setPanelHeight] = useState(180);
  const [failure, setFailure] = useState<Extract<CanvasTextResult, { ok: false }> | null>(null);
  const latestRect = useRef(session.rect);
  if (rect) latestRect.current = rect;
  const finish = (after?: () => void, replacement?: string) => {
    if (closed.current) { after?.(); return; }
    if (composing.current || ended.current) { if (after || !pending.current) pending.current = () => finishRef.current(after, replacement); return; }
    // Blur never accepts an intervening change. Replace rechecks the value we showed.
    if (failure?.reason === "changed" && replacement === undefined) {
      if (after) input.current?.focus();
      return;
    }
    const result = commitRef.current((input.current?.value ?? session.target.baseline).replace(/\r\n?/g, "\n"), replacement ?? session.target.baseline);
    if (!result.ok) { setFailure(result); input.current?.focus(); return; }
    closed.current = true;
    onClose(Boolean(root.current?.contains(document.activeElement)));
    after?.();
  };
  finishRef.current = finish;
  useImperativeHandle(controlRef, () => ({ finish }));
  useEffect(() => {
    input.current?.focus();
    return () => { if (timer.current !== null) clearTimeout(timer.current); };
  }, []);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => setPanelHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const cancel = () => { closed.current = true; pending.current = null; onClose(true); };
  const [x, y, width, height] = latestRect.current;
  // Rects are already in iframe viewport coordinates. Keep the editor inside
  // the visible canvas, with enough room for the existing dashboard writing control.
  const inlineWidth = Math.min(box.screenWidth, Math.max(240, width * box.scale));
  const style = {
    "--ox": `${box.offsetX + Math.max(0, Math.min(x * box.scale, box.screenWidth - inlineWidth))}px`,
    "--oy": `${Math.max(0, Math.min(y * box.scale, box.screenHeight - panelHeight))}px`,
    "--ow": `${inlineWidth}px`,
    "--mh": `${box.screenHeight}px`,
    "--oh": `${Math.min(320, Math.max(80, height * box.scale))}px`,
  } as CSSProperties;
  const props = {
    defaultValue: session.target.baseline,
    maxLength: session.maxLength,
    "aria-label": session.label,
    "aria-describedby": hintId,
    "aria-invalid": failure !== null,
    onChange: () => {
      onDirtyChange?.(input.current?.value !== session.target.baseline);
      if (failure?.reason === "too-long") setFailure(null);
    },
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: () => {
      composing.current = false;
      ended.current = true;
      timer.current = setTimeout(() => {
        ended.current = false;
        const next = pending.current;
        pending.current = null;
        next?.();
      }, 0);
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current || ended.current) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
      else if (event.key === "Enter" && (!session.multiline || event.metaKey || event.ctrlKey)) {
        event.preventDefault(); event.stopPropagation(); finish();
      }
    },
  };
  return <div ref={root} data-canvas-text-editor style={style}
    className="pointer-events-auto absolute left-(--ox) top-(--oy) z-20 max-h-(--mh) w-(--ow) overflow-y-auto rounded-xl bg-card p-2 shadow-popover"
    // macOS buttons may not take focus: do not let their pointer-down blur
    // commit before a Cancel/Done/Replace click can run.
    onMouseDown={(event) => { if (event.target !== input.current) event.preventDefault(); }}
    onBlur={(event) => { if (!root.current?.contains(event.relatedTarget as Node | null)) finish(); }}>
    <p className="mb-1 text-body font-medium">{session.label}</p>
    {session.multiline
      ? <Textarea {...props} ref={(node) => { input.current = node; }} className="h-(--oh)" />
      : <Input {...props} ref={(node) => { input.current = node; }} />}
    <p id={hintId} role={failure ? "alert" : undefined} className="mt-1 text-body text-muted-foreground">
      {failure ? t(failure.reason === "changed" ? "canvasTextChanged" : failure.reason === "too-long" ? "canvasTextTooLong" : "canvasTextMissing") : t(session.multiline ? "canvasTextMultiline" : "canvasTextSingle")}
    </p>
    <div className="mt-1 flex flex-wrap justify-end gap-1">
      <Button type="button" variant="ghost" className="min-h-11" onClick={cancel}>{t("canvasTextCancel")}</Button>
      {failure?.reason === "changed"
        ? <Button type="button" className="min-h-11" onClick={() => finish(undefined, failure.current)}>{t("canvasTextReplace")}</Button>
        : <Button type="button" className="min-h-11" onClick={() => finish()}>{t("canvasTextDone")}</Button>}
    </div>
  </div>;
}
