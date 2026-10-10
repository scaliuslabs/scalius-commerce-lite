/**
 * Presence on a list row (DESIGN.md W5): "Rahim is viewing" on an order
 * someone else has open, so two people don't handle the same order. For the
 * list kit:
 *
 *   const open = useListPresence("order");        // lib/realtime/list-presence.ts, once per list
 *   <RowPresence people={open.get(order.id)} />   // in the row's title cell
 *
 * Renders nothing for a row nobody else has open. One small avatar and a
 * short muted line; the row height never changes (the line truncates).
 */
import type { CSSProperties } from "react";
import type { RealtimePresence } from "@scalius/shared/realtime";
import { cn } from "@scalius/shared/utils";
import { useMessages } from "~/i18n";
import { realtimeMessages } from "~/i18n/realtime";
import { initialsOf, presenceVar } from "./presence-style";

export function RowPresence({ people, className }: { people: readonly RealtimePresence[] | undefined; className?: string }) {
  const t = useMessages(realtimeMessages);
  if (!people || people.length === 0) return null;
  const first = people[0]!;
  const name = first.name || "?";
  const line = people.length > 1
    ? t("rowMany", { name, count: people.length - 1 })
    : t(first.editing ? "rowEditing" : "rowViewing", { name });
  return (
    <span data-slot="row-presence" title={line} className={cn("inline-flex min-w-0 items-center gap-1.5 text-body text-muted-foreground", className)}>
      <span
        aria-hidden="true"
        style={{ "--presence": presenceVar(first.id) } as CSSProperties}
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-(--presence) text-caption font-semibold text-(--presence-foreground)"
      >
        {Array.from(initialsOf(name))[0]}
      </span>
      <span className="truncate">{line}</span>
    </span>
  );
}
