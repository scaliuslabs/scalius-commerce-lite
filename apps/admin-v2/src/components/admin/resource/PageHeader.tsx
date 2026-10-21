import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";

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
   * Secondary actions: at most two buttons, then a "More actions" menu for the
   * rest (C4). They come before the primary action.
   */
  actions?: ReactNode;
  /** The page's one primary action, last (C3, C4). */
  primaryAction?: ReactNode;
}

/**
 * The one page header (Polaris Page): back arrow, title, status and presence
 * on one line, a meta line under it, then secondary actions and the primary
 * action at the end.
 */
export function PageHeader({ title, backTo, backLabel, backOnlyWithoutPanel = false, status, meta, presence, actions, primaryAction }: PageHeaderProps) {
  const t = useMessages(resourceMessages);
  return (
    <div data-slot="page-header" className="mb-4 flex flex-wrap items-start gap-2">
      {backTo ? (
        <Button variant="ghost" size="icon" asChild className={cn(backOnlyWithoutPanel && "nav:hidden")}>
          <Link to={backTo} aria-label={backLabel ?? t("back")}>
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
      ) : null}
      {/* Titles wrap, never truncate (only table cells truncate); a list's one action stays beside its title on phones,
          but a record title keeps at least 192px, so "More actions" drops under it instead of squeezing it to one word a line. */}
      <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
        <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-2">
          <h1 data-slot="page-title" className="min-w-0 break-words text-heading-lg">{title}</h1>
          {status}
          {/* Avatars are 28px on a 36px line: arrivals never change the header's height (W1).
              Phones reserve no box: a long title fills the line, and an empty reserved box
              wrapped onto a line of its own, a gap between the title and the actions. */}
          {presence ? <div data-slot="presence" className="flex h-7 items-center empty:hidden max-sm:contents">{presence}</div> : null}
        </div>
        {meta ? <p className="text-body text-muted-foreground">{meta}</p> : null}
      </div>
      {actions || primaryAction ? (
        // A record page (it has a back arrow) puts its actions on their own line on phones, so the
        // title and meta line keep the width; a list's one action stays beside its title.
        <div data-slot="page-actions" className={cn("flex flex-wrap items-center gap-2", backTo && "max-sm:basis-full")}>
          {actions}
          {primaryAction}
        </div>
      ) : null}
    </div>
  );
}
