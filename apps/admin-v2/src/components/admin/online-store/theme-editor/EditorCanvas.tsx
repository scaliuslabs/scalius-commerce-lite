/**
 * The canvas: the real storefront in a frame at a true device width,
 * scaled to fit (canvas-geometry.ts), with the selection chrome in an
 * overlay above it (research P1, P3, P9). Hover is a dashed outline with a
 * name; the selection is a solid outline with its name, a toolbar (move up
 * and down, duplicate, hide, remove) and "+" on its top and bottom edges.
 * Nothing here ever changes the frame's box: only the canvas size, the
 * device, the width and the zoom do. Notices overlay the top of the canvas
 * instead of pushing the frame down.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Copy, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { themeEditorMessages } from "~/i18n/theme-editor";
import { frameBox, type DesktopWidth, type FrameBox, type PreviewDevice, type PreviewZoom } from "./canvas-geometry";
import type { PreviewLayout, PreviewPhase } from "./use-preview";

export interface SelectionActions {
  name: string;
  /** Shared on every page (header, footer): drawn in the shared colour. */
  shared?: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onDuplicate?: () => void;
  hidden?: boolean;
  onToggleHidden?: () => void;
  onRemove?: () => void;
  onAddAbove?: () => void;
  onAddBelow?: () => void;
}

function Outline({ box, rect, tone, dashed, label, children }: {
  box: FrameBox;
  rect: readonly [number, number, number, number];
  tone: "selection" | "shared";
  dashed?: boolean;
  label: string;
  children?: ReactNode;
}) {
  const [x, y, width, height] = rect;
  return (
    <div
      // Positions are measured pixels from the frame's start edge (runtime values as custom properties).
      style={{
        "--ox": `${box.offsetX + x * box.scale}px`,
        "--oy": `${y * box.scale}px`,
        "--ow": `${width * box.scale}px`,
        "--oh": `${height * box.scale}px`,
      } as CSSProperties}
      data-outline={dashed ? "hover" : "selected"}
      className={cn(
        "pointer-events-none absolute left-(--ox) top-(--oy) h-(--oh) w-(--ow) rounded-xs border-2",
        tone === "shared" ? "border-success" : "border-ring",
        dashed && "border-dashed",
      )}
    >
      <span
        className={cn(
          "absolute -top-6 flex h-6 max-w-full items-center gap-1 truncate rounded-t-md px-2 text-caption font-medium",
          tone === "shared" ? "bg-success text-success-foreground" : "bg-ring text-primary-foreground",
          "start-0",
        )}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

export function EditorCanvas({ device, desktopWidth, zoom, phase, frames, activeId, register, layout, hovered, selected, names, actions, notice, onRetry, onScaleChange }: {
  device: PreviewDevice;
  desktopWidth: DesktopWidth;
  zoom: PreviewZoom;
  phase: PreviewPhase;
  frames: ReadonlyArray<{ id: number; src: string }>;
  activeId: number | null;
  register: (id: number) => (element: HTMLIFrameElement | null) => void;
  layout: PreviewLayout;
  hovered: string | null;
  /** The selected mark (a section's, or a fixed part's). */
  selected: string | null;
  names: Readonly<Record<string, { name: string; shared?: boolean }>>;
  actions: SelectionActions | null;
  /** A notice over the top of the canvas (conflict, failed save, version preview). */
  notice?: ReactNode;
  onRetry: () => void;
  onScaleChange: (box: FrameBox) => void;
}) {
  const t = useMessages(themeEditorMessages);
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const box = frameBox(size, device, desktopWidth, zoom);
  const reported = useRef("");
  useLayoutEffect(() => {
    const key = `${box.width}:${box.scale}`;
    if (key !== reported.current) {
      reported.current = key;
      onScaleChange(box);
    }
  });
  const hoverRect = hovered && hovered !== selected ? layout.rects[hovered] : undefined;
  const selectedRect = selected ? layout.rects[selected] : undefined;
  const ready = phase === "ready";
  // Every box here is placed by the same four custom properties (one set of CSS rules).
  const boxStyle = { "--ox": `${box.offsetX}px`, "--ow": `${box.screenWidth}px`, "--oh": `${box.screenHeight}px` } as CSSProperties;
  const frameStyle = { "--ow": `${box.width}px`, "--oh": `${box.height}px`, "--fs": String(box.scale) } as CSSProperties;
  const overlayStyle = { "--oh": `${box.screenHeight}px` } as CSSProperties;
  return (
    <main
      ref={stage}
      aria-label={t("canvas")}
      data-editor-canvas
      // The frame keeps its true width; at 100% wider than the canvas, the canvas scrolls sideways.
      className="relative min-h-0 min-w-0 overflow-x-auto overflow-y-hidden bg-muted"
    >
      <div
        data-preview-box
        style={boxStyle}
        className="absolute left-(--ox) top-4 h-(--oh) w-(--ow) overflow-clip rounded-lg bg-card shadow-card"
      >
        {frames.map((frame) => (
          <iframe
            key={frame.id}
            ref={register(frame.id)}
            src={frame.src}
            title={t("previewFrame")}
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-forms"
            data-preview-frame={frame.id === activeId ? "shown" : "loading"}
            style={frameStyle}
            aria-hidden={frame.id === activeId ? undefined : true}
            tabIndex={frame.id === activeId ? undefined : -1}
            className={cn(
              "absolute left-0 top-0 h-(--oh) w-(--ow) origin-top-left scale-(--fs) border-0 bg-card",
              frame.id !== activeId && "invisible",
            )}
          />
        ))}
        {!ready ? (
          <div className="absolute inset-0 grid place-items-center bg-card p-6 text-center">
            <div className="max-w-sm space-y-3">
              <p role="status" className="text-body text-muted-foreground">
                {phase === "connecting" ? t("previewLoading")
                  : phase === "blocked" ? t("previewBlocked")
                    : phase === "no-url" ? t("previewNeedsUrl")
                      : t("previewFailed")}
              </p>
              {phase === "failed" || phase === "blocked" ? (
                <Button type="button" variant="outline" onClick={onRetry}>{t("previewRetry")}</Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      {ready ? (
        <div data-preview-overlay aria-hidden={actions ? undefined : true} style={overlayStyle} className="pointer-events-none absolute inset-x-0 top-4 h-(--oh) overflow-clip">
          {hoverRect ? (
            <Outline box={box} rect={hoverRect} tone={names[hovered!]?.shared ? "shared" : "selection"} dashed label={names[hovered!]?.name ?? ""} />
          ) : null}
          {selectedRect && actions ? (
            <Outline box={box} rect={selectedRect} tone={actions.shared ? "shared" : "selection"} label={actions.name}>
              <div
                role="toolbar"
                aria-label={t("selectionToolbar", { name: actions.name })}
                className="pointer-events-auto absolute -top-9 end-0 flex items-center gap-0.5 rounded-lg bg-card p-0.5 shadow-popover"
              >
                {actions.onMoveUp ? (
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t("moveUp")} disabled={!actions.canMoveUp} onClick={actions.onMoveUp}><ArrowUp aria-hidden="true" /></Button>
                ) : null}
                {actions.onMoveDown ? (
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t("moveDown")} disabled={!actions.canMoveDown} onClick={actions.onMoveDown}><ArrowDown aria-hidden="true" /></Button>
                ) : null}
                {actions.onDuplicate ? (
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t("duplicate")} onClick={actions.onDuplicate}><Copy aria-hidden="true" /></Button>
                ) : null}
                {actions.onToggleHidden ? (
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t(actions.hidden ? "show" : "hide")} onClick={actions.onToggleHidden}>
                    {actions.hidden ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
                  </Button>
                ) : null}
                {actions.onRemove ? (
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t("remove")} onClick={actions.onRemove}><Trash2 aria-hidden="true" /></Button>
                ) : null}
              </div>
              {actions.onAddAbove ? (
                <Button type="button" variant="outline" size="icon-sm" aria-label={t("addSectionAbove")} onClick={actions.onAddAbove} className="pointer-events-auto absolute -top-3.5 left-1/2 -translate-x-1/2">
                  <Plus aria-hidden="true" />
                </Button>
              ) : null}
              {actions.onAddBelow ? (
                <Button type="button" variant="outline" size="icon-sm" aria-label={t("addSectionBelow")} onClick={actions.onAddBelow} className="pointer-events-auto absolute -bottom-3.5 left-1/2 -translate-x-1/2">
                  <Plus aria-hidden="true" />
                </Button>
              ) : null}
            </Outline>
          ) : null}
        </div>
      ) : null}
      {notice ? (
        <div className="pointer-events-none absolute inset-x-4 top-6 z-10 flex justify-center">
          <div className="pointer-events-auto max-w-xl rounded-lg shadow-popover">{notice}</div>
        </div>
      ) : null}
    </main>
  );
}
