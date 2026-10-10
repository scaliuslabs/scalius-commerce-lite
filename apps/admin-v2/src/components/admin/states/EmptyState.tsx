import type { ReactNode } from "react";
import { SearchX } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { useMessages } from "~/i18n";
import { statesMessages } from "~/i18n/states";
import { HELP_LINKS } from "~/lib/help-links";
import { StateBlock, type StateIcon } from "./StateBlock";

/**
 * First use (polish bar E1): nothing has been made yet. One card with an
 * icon, an action title ("Add your first product"), one sentence, one
 * primary action, an optional secondary link and the community help link.
 * Draw it instead of the list: no tabs, search, headings or totals around it.
 * Pass `card={false}` when it already sits inside a card.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  help = true,
  card = true,
}: {
  icon: StateIcon;
  title: string;
  description?: string;
  /** The one primary action, usually a `Button` or a `Button asChild` link. */
  action?: ReactNode;
  /** A secondary action or link ("Import products", "Learn more"). */
  secondaryAction?: ReactNode;
  help?: boolean;
  card?: boolean;
}) {
  const t = useMessages(statesMessages);
  const block = (
    <StateBlock
      slot="empty-state"
      kind="first-use"
      icon={icon}
      title={title}
      description={description}
      actions={action || secondaryAction ? <>{secondaryAction}{action}</> : null}
      footer={
        help ? (
          <a
            href={HELP_LINKS.questions}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md text-body text-link hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("emptyHelp")}
          </a>
        ) : null
      }
    />
  );
  return card ? <Card>{block}</Card> : block;
}

/**
 * Filtered empty (E2): the list has records, but none match. Sits where the
 * rows go, inside the table's card, and offers "Clear filters".
 */
export function FilteredEmptyState({
  title,
  description,
  onClearFilters,
}: {
  /** "No orders match these filters"; defaults to a generic line. */
  title?: string;
  description?: string;
  onClearFilters?: () => void;
}) {
  const t = useMessages(statesMessages);
  return (
    <StateBlock
      slot="empty-state"
      kind="filtered"
      icon={SearchX}
      title={title ?? t("filteredTitle")}
      description={description ?? t("filteredBody")}
      actions={
        onClearFilters ? (
          <Button type="button" variant="outline" onClick={onClearFilters}>
            {t("clearFilters")}
          </Button>
        ) : null
      }
    />
  );
}

/** Section empty (E3): a card with nothing in it yet says so in one muted line. */
export function SectionEmpty({ children }: { children: ReactNode }) {
  return (
    <p data-slot="empty-state" data-state-kind="section" className="text-body text-muted-foreground">
      {children}
    </p>
  );
}
