import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";

interface PageHeaderProps {
  title: ReactNode;
  /** Shows a back arrow to this dashboard path (detail pages). */
  backTo?: string;
  /** Status badge or short context shown after the title. */
  badge?: ReactNode;
  /** Buttons on the right; put the primary action last. */
  actions?: ReactNode;
}

/** The one page header: optional back arrow, title, actions on the right. */
export function PageHeader({ title, backTo, badge, actions }: PageHeaderProps) {
  const t = useMessages(resourceMessages);
  return (
    <div className="mb-4 flex flex-wrap items-start gap-2">
      {backTo ? (
        <Button variant="ghost" size="icon" asChild>
          <Link to={backTo} aria-label={t("back")}>
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
      ) : null}
      {/* Titles wrap, never truncate (only table cells truncate). */}
      <div className="flex min-h-9 min-w-0 flex-1 basis-64 flex-wrap items-center gap-2">
        <h1 className="min-w-0 break-words text-heading-lg">{title}</h1>
        {badge}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
