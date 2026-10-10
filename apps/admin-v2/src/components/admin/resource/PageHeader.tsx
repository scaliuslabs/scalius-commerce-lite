import { lazy, Suspense, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ChevronDown } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";

/** A header action given as data, so the header can fold it into "More actions". */
export interface PageAction {
  label: string;
  onAction?: () => void;
  /** A dashboard path: the action is a link. */
  to?: string;
  icon?: ReactNode;
  disabled?: boolean;
  destructive?: boolean;
}

interface PageHeaderProps {
  /** The page title: wraps, never truncates. */
  title: ReactNode;
  /** Shows a back arrow to this dashboard path (detail and form pages). */
  backTo?: string;
  /** The back arrow's name; "Back" by default. */
  backLabel?: string;
  /** Hides the back arrow where the navigation panel shows (from 1100px): settings pages, whose list is in the panel. */
  backOnlyWithoutPanel?: boolean;
  /** Status badges after the title. */
  status?: ReactNode;
  /** One line under the title: "Placed Oct 8 at 3:42 PM · Online store" (P1). */
  meta?: ReactNode;
  /**
   * Who else is on this record (B4's avatars). The space sits on the title
   * line, so people arriving or leaving never move the page; empty renders nothing.
   */
  presence?: ReactNode;
  /**
   * Secondary actions as data: up to two show as buttons from 640px, the rest
   * (all of them on phones) go into "More actions" (C4).
   */
  secondaryActions?: readonly PageAction[];
  /** Other secondary controls (an app's actions menu), before the primary action. */
  actions?: ReactNode;
  /** The page's one primary action, last (C3, C4). */
  primaryAction?: ReactNode;
}

const VISIBLE_SECONDARY = 2;

function ActionButton({ action }: { action: PageAction }) {
  const content = <>{action.icon}{action.label}</>;
  if (action.to) {
    return (
      <Button variant="outline" asChild disabled={action.disabled}>
        <Link to={action.to}>{content}</Link>
      </Button>
    );
  }
  return (
    <Button type="button" variant={action.destructive ? "destructive" : "outline"} disabled={action.disabled} onClick={action.onAction}>
      {content}
    </Button>
  );
}

// The menu loads with the first page that folds an action into it.
const PageHeaderMenu = lazy(() => import("./PageHeaderMenu"));

function MoreActions({ actions, className }: { actions: readonly PageAction[]; className?: string }) {
  const t = useMessages(resourceMessages);
  if (actions.length === 0) return null;
  // Same button while the menu loads: nothing moves.
  const placeholder = <Button type="button" variant="outline" className={className}>{t("moreActions")}<ChevronDown aria-hidden /></Button>;
  return (
    <Suspense fallback={placeholder}>
      <PageHeaderMenu actions={actions} className={className} />
    </Suspense>
  );
}

/**
 * The one page header (Polaris Page): back arrow, title, status and presence
 * on one line, a meta line under it, then secondary actions, "More actions"
 * and the primary action at the end.
 */
export function PageHeader({ title, backTo, backLabel, backOnlyWithoutPanel = false, status, meta, presence, secondaryActions = [], actions, primaryAction }: PageHeaderProps) {
  const t = useMessages(resourceMessages);
  const shown = secondaryActions.slice(0, VISIBLE_SECONDARY);
  const folded = secondaryActions.slice(VISIBLE_SECONDARY);
  const hasActions = secondaryActions.length > 0 || Boolean(actions) || Boolean(primaryAction);
  return (
    <div data-slot="page-header" className="mb-4 flex flex-wrap items-start gap-2">
      {backTo ? (
        <Button variant="ghost" size="icon" asChild className={cn(backOnlyWithoutPanel && "nav:hidden")}>
          <Link to={backTo} aria-label={backLabel ?? t("back")}>
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
      ) : null}
      {/* Titles wrap, never truncate (only table cells truncate); a list's one action stays beside its title on phones. */}
      <div className="flex min-w-0 flex-1 basis-40 flex-col gap-1">
        <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-2">
          <h1 data-slot="page-title" className="min-w-0 break-words text-heading-lg">{title}</h1>
          {status}
          {/* Avatars are 28px on a 36px line: arrivals never change the header's height (W1). */}
          {presence ? <div data-slot="presence" className="flex h-7 items-center empty:hidden">{presence}</div> : null}
        </div>
        {meta ? <p className="text-body text-muted-foreground">{meta}</p> : null}
      </div>
      {hasActions ? (
        <div data-slot="page-actions" className="flex flex-wrap items-center gap-2">
          {/* Phones fold every secondary action into one menu; from 640px two show. */}
          {shown.map((action) => (
            <span key={action.label} className="hidden sm:contents">
              <ActionButton action={action} />
            </span>
          ))}
          <MoreActions actions={folded} className="hidden sm:inline-flex" />
          <MoreActions actions={secondaryActions} className="sm:hidden" />
          {actions}
          {primaryAction}
        </div>
      ) : null}
    </div>
  );
}
