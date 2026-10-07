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

/** A plain control on the dark bar (the dashboard's top bar tokens). Menus open from it (it forwards its ref). */
export const TopBarButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; pressed?: boolean }>(
  function TopBarButton({ label, pressed, className, children, ...props }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        title={label}
        aria-pressed={pressed}
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-lg text-topbar-foreground hover:bg-topbar-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-topbar-progress disabled:opacity-40 aria-pressed:bg-topbar-subdued pointer-coarse:size-11 [&_svg]:size-4",
          className,
        )}
        {...props}
      >
        {children}
      </button>
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
  status, heldCount, onRetry, live, canEdit, sidebarOpen, onToggleSidebar, pagePicker, market, device, onDevice, desktopWidth, onDesktopWidth,
  zoom, onZoom, scale, inspector, onInspector, canUndo, canRedo, onUndo, onRedo, onHistory, onShortcuts, onDraftWithAi, onOpenPreview,
  canDiscard, onDiscard, canPublish, publishing, onPublish, phone,
}: {
  status: SaveStatus;
  heldCount: number;
  onRetry: () => void;
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
  const statusText = status === "held" ? (heldCount === 1 ? t("statusHeldOne") : t("statusHeld", { count: heldCount })) : t(`status_${status}`);
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
          aria-label={t("back")}
          title={t("back")}
          className="flex h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-body font-medium text-topbar-foreground hover:bg-topbar-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-topbar-progress"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          {phone ? null : <span className="hidden lg:inline">{t("themeShort")}</span>}
        </Link>
        {phone ? null : (
          <TopBarButton label={t("toggleSidebar")} pressed={!sidebarOpen} onClick={onToggleSidebar} aria-keyshortcuts="\">
            <PanelLeftClose aria-hidden="true" />
          </TopBarButton>
        )}
        {phone ? null : (
          <Badge variant={live ? "success" : "warning"} className="hidden shrink-0 lg:inline-flex">{t(live ? "live" : "draftBadge")}</Badge>
        )}
        {/* One save status, always there; a phone shows its dot (the words stay for screen readers). */}
        <span role="status" aria-live="polite" data-save-status={status} className={cn("flex min-w-0 shrink-0 items-center gap-1.5 px-1 text-body", phone ? "w-6" : "w-44")}>
          <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[status])} aria-hidden="true" />
          <span className={cn("min-w-0 truncate max-xl:sr-only", phone && "sr-only")}>{statusText}</span>
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
                aria-label={t("frameSize", { width: device === "phone" ? 390 : desktopWidth, scale: scalePercent(scale) })}
                className="hidden h-9 shrink-0 items-center gap-1.5 rounded-lg bg-topbar-subdued px-2.5 text-body text-topbar-foreground hover:bg-topbar-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-topbar-progress md:flex"
              >
                <span className="hidden tabular-nums xl:inline">{device === "phone" ? t("device_phone") : t("desktopWidth", { width: desktopWidth })}</span>
                <span className="w-9 text-end font-medium tabular-nums">{scalePercent(scale)}%</span>
                <ChevronDown className="size-4 opacity-60" aria-hidden="true" />
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
                  <DropdownMenuRadioGroup value={String(desktopWidth)} onValueChange={(value) => onDesktopWidth(Number(value) as DesktopWidth)}>
                    {DESKTOP_WIDTHS.map((width) => (
                      <DropdownMenuRadioItem key={width} value={String(width)}>{t("desktopWidth", { width })}</DropdownMenuRadioItem>
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
        <TopBarButton label={t("undo")} disabled={!canUndo || !canEdit} onClick={onUndo} aria-keyshortcuts="Meta+Z Control+Z">
          <Undo2 aria-hidden="true" />
        </TopBarButton>
        {phone ? null : (
          <TopBarButton label={t("redo")} disabled={!canRedo || !canEdit} onClick={onRedo} className="hidden md:grid" aria-keyshortcuts="Meta+Shift+Z Control+Y">
            <Redo2 aria-hidden="true" />
          </TopBarButton>
        )}
        {phone ? null : (
          <TopBarButton label={t("versions")} onClick={onHistory} className="hidden lg:grid">
            <History aria-hidden="true" />
          </TopBarButton>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <TopBarButton label={t("moreActions")}>
              <MoreHorizontal aria-hidden="true" />
            </TopBarButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem className="md:hidden" disabled={!canRedo || !canEdit} onSelect={onRedo}><Redo2 aria-hidden="true" />{t("redo")}</DropdownMenuItem>
            <DropdownMenuItem className="lg:hidden" onSelect={onHistory}><History aria-hidden="true" />{t("versions")}</DropdownMenuItem>
            <DropdownMenuItem className="lg:hidden" onSelect={() => onInspector(!inspector)}>
              <MousePointer2 aria-hidden="true" />{t(inspector ? "inspectorOff" : "inspectorOn")}
              {inspector ? <Check className="ms-auto" aria-hidden="true" /> : null}
            </DropdownMenuItem>
            {onDraftWithAi ? <DropdownMenuItem onSelect={onDraftWithAi}><Sparkles aria-hidden="true" />{t("draftWithAiMenu")}</DropdownMenuItem> : null}
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
            className="flex h-9 shrink-0 items-center rounded-lg bg-topbar-primary px-3 text-body font-medium text-topbar-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-topbar-progress disabled:opacity-50 pointer-coarse:h-11"
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
          aria-label={t("marketPicker", { market: current.label })}
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
