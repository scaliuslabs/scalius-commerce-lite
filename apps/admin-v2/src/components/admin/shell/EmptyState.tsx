import type { ComponentType, ReactNode } from "react";
import { useId } from "react";

import { cn } from "@scalius/shared/utils";
import { Button, type ButtonProps } from "~/components/ui/button";

export interface EmptyStateAction {
  label: string;
  onClick?: () => void;
  /** Rendered as a link when set; `onClick` still fires. */
  href?: string;
  disabled?: boolean;
  variant?: ButtonProps["variant"];
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
}

export interface EmptyStateProps {
  heading: string;
  /** One sentence saying what to do next, not what is missing. */
  body?: ReactNode;
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  action?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  /** Draw the bordered card around the state. Default: true. */
  bordered?: boolean;
  /** Tightens the padding for use inside a table body. Default: false. */
  compact?: boolean;
  className?: string;
  children?: ReactNode;
}

function EmptyStateButton({
  action,
  variant,
}: {
  action: EmptyStateAction;
  variant: ButtonProps["variant"];
}) {
  const Icon = action.icon;
  const content = (
    <>
      {Icon ? <Icon className="h-4 w-4" aria-hidden /> : null}
      {action.label}
    </>
  );
  if (action.href) {
    return (
      <Button
        asChild
        variant={action.variant ?? variant}
        className="min-h-11 sm:min-h-9"
      >
        <a href={action.href} onClick={action.onClick}>
          {content}
        </a>
      </Button>
    );
  }
  return (
    <Button
      type="button"
      variant={action.variant ?? variant}
      disabled={action.disabled}
      className="min-h-11 sm:min-h-9"
      onClick={action.onClick}
    >
      {content}
    </Button>
  );
}

/**
 * The state a list or card shows when it has nothing yet: icon, heading, one
 * sentence, and the action that fixes it.
 */
export function EmptyState({
  heading,
  body,
  icon: Icon,
  action,
  secondaryAction,
  bordered = true,
  compact = false,
  className,
  children,
}: EmptyStateProps) {
  const headingId = useId();

  return (
    <div
      data-testid="empty-state"
      aria-labelledby={headingId}
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-2 px-4 py-8" : "gap-3 px-4 py-12",
        bordered ? "rounded-lg border border-dashed border-border bg-card" : undefined,
        className,
      )}
    >
      {Icon ? (
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="h-5 w-5" aria-hidden />
        </span>
      ) : null}
      <h3 id={headingId} className="text-sm font-semibold leading-5">
        {heading}
      </h3>
      {body ? (
        <p className="max-w-prose text-[13px] leading-5 text-muted-foreground">{body}</p>
      ) : null}
      {children}
      {action || secondaryAction ? (
        <div className="mt-1 flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center">
          {action ? <EmptyStateButton action={action} variant="default" /> : null}
          {secondaryAction ? (
            <EmptyStateButton action={secondaryAction} variant="ghost" />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default EmptyState;
