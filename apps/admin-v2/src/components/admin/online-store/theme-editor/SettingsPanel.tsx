/**
 * The selected item's settings (research P4): its name with a breadcrumb,
 * Back (Esc) to the tree where the pane takes the tree's place, a note on
 * why buyers may not see it, its settings, and its actions at the foot
 * (hide, duplicate, remove). From 1600 px the pane is the always-mounted
 * right column and shows an empty state until something is selected.
 */
import type { ReactNode } from "react";
import { ArrowLeft, Copy, Eye, EyeOff, MousePointerClick, Trash2, X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { themeEditorMessages } from "~/i18n/theme-editor";
import { EDITOR_PARTS, selectedModule, type EditorPage } from "./editor-pages";

export interface PaneActions {
  hidden?: boolean;
  onToggleHidden?: () => void;
  onDuplicate?: () => void;
  onRemove?: () => void;
}

export function SettingsPane({ title, crumbs, note, notices, onBack, closes = false, actions, readOnly, children }: {
  title: string;
  /** Where it is: the page, then its section for a block. */
  crumbs: readonly string[];
  note?: string;
  /** Notices above the settings (shared on every page, an AI draft, a language). */
  notices?: ReactNode;
  /** Back to the tree, or (with `closes`, in the right column beside the tree) close the settings. */
  onBack: () => void;
  closes?: boolean;
  actions?: PaneActions;
  readOnly: boolean;
  children: ReactNode;
}) {
  const t = useMessages(themeEditorMessages);
  return (
    <div data-settings-pane className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-12 shrink-0 items-center gap-1 border-b border-border bg-card px-2 py-1.5">
        {closes ? null : (
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("backToTree")} aria-keyshortcuts="Escape" onClick={onBack}>
            <ArrowLeft aria-hidden="true" />
          </Button>
        )}
        <div className="min-w-0 flex-1 px-1">
          <h2 className="truncate text-heading-sm">{title}</h2>
          {crumbs.length > 0 ? (
            <nav aria-label={t("breadcrumb")}>
              <ol className="flex min-w-0 items-center gap-1 text-body text-muted-foreground">
                {crumbs.map((crumb, index) => (
                  <li key={index} className="flex min-w-0 items-center gap-1">
                    {index > 0 ? <span aria-hidden="true">›</span> : null}
                    <span className="truncate">{crumb}</span>
                  </li>
                ))}
              </ol>
            </nav>
          ) : null}
        </div>
        {closes ? (
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("closeSettings")} aria-keyshortcuts="Escape" onClick={onBack}>
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="space-y-4 px-4 py-4">
          {note ? <p role="status" className="text-body text-muted-foreground">{note}</p> : null}
          {notices}
          <fieldset disabled={readOnly} className="min-w-0 space-y-4">{children}</fieldset>
        </div>
      </div>
      {actions && !readOnly && (actions.onToggleHidden || actions.onDuplicate || actions.onRemove) ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-border bg-card px-4 py-3">
          {actions.onToggleHidden ? (
            <Button type="button" variant="outline" size="sm" onClick={actions.onToggleHidden}>
              {actions.hidden ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
              {t(actions.hidden ? "show" : "hide")}
            </Button>
          ) : null}
          {actions.onDuplicate ? (
            <Button type="button" variant="outline" size="sm" onClick={actions.onDuplicate}><Copy aria-hidden="true" />{t("duplicate")}</Button>
          ) : null}
          {actions.onRemove ? (
            <Button type="button" variant="ghost" size="icon-sm" className="ms-auto" aria-label={t("remove")} title={t("remove")} onClick={actions.onRemove}><Trash2 aria-hidden="true" /></Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The right column's empty state (from 1600 px): what selecting does. */
export function SettingsEmpty() {
  const t = useMessages(themeEditorMessages);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-body text-muted-foreground" data-settings-empty>
      <MousePointerClick className="size-5" aria-hidden="true" />
      <p className="font-medium text-foreground">{t("nothingSelected")}</p>
      <p>{t("nothingSelectedHelp")}</p>
    </div>
  );
}

/** The title of a selected part (null for a section or block, whose name the editor knows). */
export function usePartTitle() {
  const t = useMessages(themeEditorMessages);
  return (selected: string, page: EditorPage): string | null => {
    const module = selectedModule(selected);
    if (module) return t(`module_${module}`);
    switch (selected) {
      case EDITOR_PARTS.announcement: return t("announcement");
      case EDITOR_PARTS.header: return t("headerRow");
      case EDITOR_PARTS.footer: return t("footerRow");
      case EDITOR_PARTS.page: return t(page.kind === "home" ? "homeSettings" : "pageSettings");
      case EDITOR_PARTS.productMain: return t("productMain");
      case EDITOR_PARTS.productApps: return t("appBlocks");
      case EDITOR_PARTS.listing: return t("listingMain");
      case EDITOR_PARTS.listingToolbar: return t("listingToolbar");
      case EDITOR_PARTS.listingFilters: return t("listingFilters");
      case EDITOR_PARTS.cart: return t("cartMain");
      case EDITOR_PARTS.pageContent: return t("pageContent");
      default: return null;
    }
  };
}

/** Whether a selected part has settings to show (the forms themselves load with SelectionPanes). */
export function partHasSettings(selected: string, page: EditorPage): boolean {
  if (selectedModule(selected)) return true;
  if (selected === EDITOR_PARTS.page) return page.kind === "home" || page.kind === "landing";
  return (Object.values(EDITOR_PARTS) as string[]).includes(selected);
}
