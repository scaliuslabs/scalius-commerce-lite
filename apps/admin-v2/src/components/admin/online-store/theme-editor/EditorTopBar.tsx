/**
 * The editor's top bar (research P13): one 48 px row that never wraps from
 * 768 px, with a status slot of fixed width and labels that never change
 * width. Left: back, the sidebar toggle, the theme's state and the one
 * autosave status. Centre: the page switcher, the previewed market and
 * language, the device and the frame's size. Right: the inspector, undo and
 * redo, history, more, and Publish. Narrower windows move the less used
 * controls into More.
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ExternalLink,
  Globe,
  History,
  Keyboard,
  Monitor,
  MoreHorizontal,
  MousePointer2,
  PanelLeftClose,
  Redo2,
  Smartphone,
  Sparkles,
  Trash2,
  Undo2,
} from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Badge } from "~/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { useMessages } from "~/i18n";
import { themeEditorMessages } from "~/i18n/theme-editor";
import { DESKTOP_WIDTHS, scalePercent, type DesktopWidth, type PreviewDevice, type PreviewZoom } from "./canvas-geometry";
import { shortcutCaps } from "./EditorShortcuts";

/**
 * A plain control on the dark bar (the dashboard's top bar tokens), with
 * the app's tooltip and its shortcut. A menu trigger (it forwards its ref)
 * passes `tip={false}`: the menu's own trigger cannot also be a tooltip's.
 */
export const TopBarButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; pressed?: boolean; shortcut?: string; tip?: boolean }>(
  function TopBarButton({ label, pressed, shortcut, tip = true, className, children, ...props }, ref) {
    const button = (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        title={tip ? undefined : label}
        aria-pressed={pressed}
        className={cn(
          "grid size-11 shrink-0 sm:size-9 place-items-center rounded-lg text-topbar-foreground hover:bg-topbar-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-topbar-progress disabled:opacity-40 aria-pressed:bg-topbar-subdued pointer-coarse:size-11 [&_svg]:size-4",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    );
    if (!tip) return button;
    return (
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="bottom">
          {label}
          {shortcut ? <kbd className="ms-2 font-mono text-muted-foreground">{shortcut}</kbd> : null}
        </TooltipContent>
      </Tooltip>
    );
  },
);

export type SaveStatus = "saved" | "unsaved" | "saving" | "failed" | "held" | "conflict" | "readOnly";

const STATUS_DOT: Record<SaveStatus, string> = {
  saved: "bg-success",
  unsaved: "bg-warning",
  saving: "bg-topbar-progress",
  failed: "bg-critical",
  held: "bg-warning",
  conflict: "bg-critical",
  readOnly: "bg-topbar-subdued",
};

export function EditorTopBar({
  status, heldCount, onRetry, onShowProblem, live, canEdit, sidebarOpen, onToggleSidebar, pagePicker, market, device, onDevice, desktopWidth, onDesktopWidth,
  zoom, onZoom, scale, inspector, onInspector, canUndo, canRedo, onUndo, onRedo, onHistory, onShortcuts, onDraftWithAi, draftHere, onOpenPreview,
  canDiscard, onDiscard, canPublish, publishing, onPublish, phone,
}: {
  status: SaveStatus;
  heldCount: number;
  onRetry: () => void;
  /** Opens the first setting to fix. */
  onShowProblem?: () => void;
  /** The draft matches what is live. */
  live: boolean;
  canEdit: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  pagePicker: ReactNode;
  market: ReactNode;
  device: PreviewDevice;
  onDevice: (device: PreviewDevice) => void;
  desktopWidth: DesktopWidth;
  onDesktopWidth: (width: DesktopWidth) => void;
  zoom: PreviewZoom;
  onZoom: (zoom: PreviewZoom) => void;
  scale: number;
  inspector: boolean;
  onInspector: (on: boolean) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onHistory: () => void;
  onShortcuts: () => void;
  onDraftWithAi: (() => void) | null;
  /** The page has sections to draft into (search results have none). */
  draftHere: boolean;
  onOpenPreview: (() => void) | null;
  canDiscard: boolean;
  onDiscard: () => void;
  canPublish: boolean;
  publishing: boolean;
  onPublish: () => void;
  /** Below 768 px: the compact bar. */
  phone: boolean;
}) {
  const t = useMessages(themeEditorMessages);
  /** A width as the merchant reads it: "Fit width", or "1280 px" (no thousands separator). */
  const sizeName = (width: DesktopWidth | 390) => (width === "fill" ? t("widthFill") : t("widthPx", { width: String(width) }));
  const statusText = status === "held" ? (heldCount === 1 ? t("statusHeldOne") : t("statusHeld", { count: heldCount }))
    : status === "saved" && live ? t("status_noChanges")
      : t(`status_${status}`);
  return (
    <header
      data-editor-topbar
      className={cn(
        "grid h-12 items-center gap-2 border-b border-topbar-border bg-topbar px-2 text-topbar-foreground",
        phone ? "grid-cols-[auto_minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]",
      )}
    >
      <div className="flex min-w-0 items-center gap-1">
        <Link
          to="/admin/online-store/theme"
          aria-label={`${t("themeShort")} · ${t("back")}`}
          title={t("back")}
          className="flex h-11 shrink-0 items-center sm:h-9 gap-1 rounded-lg px-2 text-body font-medium text-topbar-foreground hover:bg-topbar-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-topbar-progress"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          {phone ? null : <span className="hidden lg:inline">{t("themeShort")}</span>}
        </Link>
        {phone ? null : (
          <TopBarButton label={t("toggleSidebar")} shortcut={shortcutCaps("sidebar")} pressed={!sidebarOpen} onClick={onToggleSidebar} aria-keyshortcuts="\">
            <PanelLeftClose aria-hidden="true" />
          </TopBarButton>
        )}
        {phone ? null : (
          <Badge variant={live ? "success" : "warning"} className="hidden shrink-0 lg:inline-flex">{t(live ? "live" : "draftBadge")}</Badge>
        )}
        {/* One save status, always there; a phone shows its dot (the words stay for screen readers). */}
        <span role="status" aria-live="polite" data-save-status={status} className={cn("flex min-w-0 shrink-0 items-center gap-1.5 text-body", phone ? "w-6 justify-center px-0" : "w-44 px-1")}>
          {status === "held" && onShowProblem && phone ? (
            // A phone shows only the dot, so the dot is the control: a real, tappable target (its hit area reaches past the dot), never a clipped screen-reader-only button.
            <button
              type="button"
              onClick={onShowProblem}
              className="relative flex size-6 shrink-0 items-center justify-center rounded-full after:absolute after:-inset-2 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-topbar-progress"
            >
              <span className={cn("size-2 rounded-full", STATUS_DOT[status])} aria-hidden="true" />
              <span className="sr-only">{statusText}</span>
            </button>
          ) : (
            <>
              <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[status])} aria-hidden="true" />
              {status === "held" && onShowProblem ? (
                <button type="button" onClick={onShowProblem} className="min-w-0 truncate text-start underline decoration-dotted underline-offset-2 hover:text-topbar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-topbar-progress max-xl:sr-only">
                  {statusText}
                </button>
              ) : (
                <span className={cn("min-w-0 truncate max-xl:sr-only", phone && "sr-only")}>{statusText}</span>
              )}
            </>
          )}
          {status === "failed" ? (
            <button type="button" onClick={onRetry} className="shrink-0 text-body text-topbar-progress underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-topbar-progress">{t("retry")}</button>
          ) : null}
        </span>
      </div>
      <div className="flex min-w-0 items-center justify-center gap-1">
        {pagePicker}
        {phone ? null : market}
        {phone ? null : (
          <div role="radiogroup" aria-label={t("device")} className="hidden items-center gap-0.5 rounded-lg bg-topbar-subdued p-0.5 md:flex">
            {(["desktop", "phone"] as const).map((value) => {
              const Icon = value === "desktop" ? Monitor : Smartphone;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={device === value}
                  aria-label={t(`device_${value}`)}
                  title={t(`device_${value}`)}
                  onClick={() => onDevice(value)}
                  className="grid h-8 w-9 place-items-center rounded-md text-topbar-foreground hover:bg-topbar-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-topbar-progress aria-checked:bg-topbar-primary aria-checked:text-topbar-primary-foreground"
                >
                  <Icon className="size-4" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        )}
        {phone ? null : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t("frameSize", { size: device === "phone" ? t("device_phone") : sizeName(desktopWidth), scale: String(scalePercent(scale)) })}
                // A fixed width: switching device never moves the controls beside it.
                className="hidden h-9 w-24 shrink-0 items-center justify-between gap-1 rounded-lg bg-topbar-subdued px-2.5 text-body text-topbar-foreground hover:bg-topbar-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-topbar-progress md:flex xl:w-44"
              >
                <span className="hidden min-w-0 truncate tabular-nums xl:inline">{device === "phone" ? t("device_phone") : sizeName(desktopWidth)}</span>
                <span className="font-medium tabular-nums">{scalePercent(scale)}%</span>
                <ChevronDown className="size-4 shrink-0 opacity-60" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center">
              <DropdownMenuLabel>{t("frameZoom")}</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={zoom} onValueChange={(value) => onZoom(value as PreviewZoom)}>
                <DropdownMenuRadioItem value="fit">{t("zoomFit")}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="actual">{t("zoomActual")}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              {device === "desktop" ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>{t("frameWidth")}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={String(desktopWidth)} onValueChange={(value) => onDesktopWidth(value === "fill" ? "fill" : Number(value) as DesktopWidth)}>
                    {DESKTOP_WIDTHS.map((width) => (
                      <DropdownMenuRadioItem key={width} value={String(width)}>{sizeName(width)}</DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <div className="flex min-w-0 items-center justify-end gap-1">
        {phone ? null : (
          <TopBarButton label={t(inspector ? "inspectorOff" : "inspectorOn")} pressed={inspector} onClick={() => onInspector(!inspector)} className="hidden lg:grid">
            <MousePointer2 aria-hidden="true" />
          </TopBarButton>
        )}
        <TopBarButton label={t("undo")} shortcut={shortcutCaps("undo")} disabled={!canUndo || !canEdit} onClick={onUndo} aria-keyshortcuts="Meta+Z Control+Z">
          <Undo2 aria-hidden="true" />
        </TopBarButton>
        <TopBarButton label={t("redo")} shortcut={shortcutCaps("redo")} disabled={!canRedo || !canEdit} onClick={onRedo} aria-keyshortcuts="Meta+Shift+Z Control+Y">
          <Redo2 aria-hidden="true" />
        </TopBarButton>
        {phone ? null : (
          <TopBarButton label={t("versions")} onClick={onHistory} className="hidden lg:grid">
            <History aria-hidden="true" />
          </TopBarButton>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <TopBarButton label={t("moreActions")} tip={false}>
              <MoreHorizontal aria-hidden="true" />
            </TopBarButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem className="lg:hidden" onSelect={onHistory}><History aria-hidden="true" />{t("versions")}</DropdownMenuItem>
            <DropdownMenuItem className="lg:hidden" onSelect={() => onInspector(!inspector)}>
              <MousePointer2 aria-hidden="true" />{t(inspector ? "inspectorOff" : "inspectorOn")}
              {inspector ? <Check className="ms-auto" aria-hidden="true" /> : null}
            </DropdownMenuItem>
            {onDraftWithAi ? (
              <DropdownMenuItem disabled={!draftHere} onSelect={onDraftWithAi}>
                <Sparkles aria-hidden="true" />
                <span className="flex flex-col">
                  {t("draftWithAiMenu")}
                  {draftHere ? null : <span className="text-caption text-muted-foreground">{t("aiNotHere")}</span>}
                </span>
              </DropdownMenuItem>
            ) : null}
            {onOpenPreview ? <DropdownMenuItem onSelect={onOpenPreview}><ExternalLink aria-hidden="true" />{t("preview")}</DropdownMenuItem> : null}
            <DropdownMenuItem onSelect={onShortcuts}><Keyboard aria-hidden="true" />{t("shortcuts")}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={!canDiscard} onSelect={onDiscard}><Trash2 aria-hidden="true" />{t("discard")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {canEdit ? (
          <button
            type="button"
            onClick={onPublish}
            disabled={!canPublish || publishing}
            aria-busy={publishing || undefined}
            className="flex h-11 shrink-0 items-center sm:h-9 rounded-lg bg-topbar-primary px-3 text-body font-medium text-topbar-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-topbar-progress disabled:opacity-50 pointer-coarse:h-11"
          >
            {t("publish")}
          </button>
        ) : null}
      </div>
    </header>
  );
}

/** The previewed market and language (research §4 decisions): prices, currency, words and direction. */
export function MarketSwitcher({ options, value, onChange }: {
  options: ReadonlyArray<{ value: string; short: string; label: string }>;
  /** The presence previewed ('' for the root). */
  value: string;
  onChange: (presence: string) => void;
}) {
  const t = useMessages(themeEditorMessages);
  if (options.length < 2) return null;
  const current = options.find((option) => option.value === value) ?? options[0]!;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${current.short} · ${t("marketPicker", { market: current.label })}`}
          className="hidden h-9 shrink-0 items-center gap-1.5 rounded-lg bg-topbar-subdued px-2.5 text-body text-topbar-foreground hover:bg-topbar-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-topbar-progress md:flex"
        >
          <Globe className="size-4" aria-hidden="true" />
          <span className="tabular-nums">{current.short}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center">
        <DropdownMenuLabel>{t("marketPreview")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={current.value} onValueChange={onChange}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value || "root"} value={option.value}>{option.label}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
