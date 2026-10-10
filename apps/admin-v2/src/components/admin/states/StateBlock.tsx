import type { ComponentType, ReactNode } from "react";
import { cn } from "@scalius/shared/utils";

export type StateIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

/**
 * The one shape of every centred state (Polaris EmptyState): an icon in a
 * soft circle, a title, one sentence, then the actions in a row (primary
 * last on wide screens, first and full width on phones). The caller picks the
 * heading level, so a state that stands for the page names it in its h1.
 */
export function StateBlock({
  slot,
  kind,
  icon: Icon,
  title,
  titleAs: Title = "h2",
  description,
  actions,
  footer,
  className,
}: {
  /** Omitted when an outer element already carries the slot. */
  slot?: "empty-state" | "error-state";
  kind?: string;
  icon?: StateIcon;
  title: ReactNode;
  titleAs?: "h1" | "h2" | "h3";
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot={slot}
      data-state-kind={kind}
      className={cn("flex flex-col items-center gap-4 px-4 py-12 text-center", className)}
    >
      {Icon ? (
        <span className="flex size-12 items-center justify-center rounded-full bg-secondary text-muted-foreground">
          <Icon aria-hidden className="size-6" />
        </span>
      ) : null}
      <div className="flex max-w-md flex-col gap-1">
        <Title className="text-heading-md text-balance">{title}</Title>
        {description ? <p className="text-body text-pretty text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? (
        <div className="flex w-full flex-col-reverse items-stretch justify-center gap-2 sm:w-auto sm:flex-row sm:items-center">
          {actions}
        </div>
      ) : null}
      {footer}
    </div>
  );
}
