import type { ReactNode } from "react";

import { cn } from "@scalius/shared/utils";

export type StatusTone =
  | "success"
  | "attention"
  | "warning"
  | "critical"
  | "info"
  | "neutral";

/**
 * Tone classes. Each tone carries its own light and dark values so a badge
 * never depends on the surface it sits on.
 */
export const STATUS_TONE_CLASSES: Record<StatusTone, string> = {
  success:
    "border-emerald-200/60 bg-emerald-50 text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-900/30 dark:text-emerald-300",
  attention:
    "border-amber-200/60 bg-amber-50 text-amber-800 dark:border-amber-800/60 dark:bg-amber-900/30 dark:text-amber-300",
  warning:
    "border-orange-200/60 bg-orange-50 text-orange-800 dark:border-orange-800/60 dark:bg-orange-900/30 dark:text-orange-300",
  critical:
    "border-red-200/60 bg-red-50 text-red-700 dark:border-red-800/60 dark:bg-red-900/30 dark:text-red-300",
  info: "border-blue-200/60 bg-blue-50 text-blue-700 dark:border-blue-800/60 dark:bg-blue-900/30 dark:text-blue-300",
  neutral:
    "border-border bg-muted text-muted-foreground dark:bg-muted/50 dark:text-muted-foreground",
};

const DOT_TONE_CLASSES: Record<StatusTone, string> = {
  success: "bg-emerald-500",
  attention: "bg-amber-500",
  warning: "bg-orange-500",
  critical: "bg-red-500",
  info: "bg-blue-500",
  neutral: "bg-muted-foreground/60",
};

export interface StatusBadgeProps {
  /** Default: "neutral". */
  tone?: StatusTone;
  children: ReactNode;
  /** Show the leading dot. Default: true. */
  dot?: boolean;
  /**
   * Extra context only screen readers need, e.g. "Payment status:".
   * Colour alone never carries the meaning; the label always does.
   */
  srLabel?: string;
  className?: string;
}

/**
 * The single badge used for every status in the dashboard. Pick the tone by
 * meaning (success / attention / warning / critical / info / neutral), never by
 * colour, and keep the label a readable word.
 */
export function StatusBadge({
  tone = "neutral",
  children,
  dot = true,
  srLabel,
  className,
}: StatusBadgeProps) {
  return (
    <span
      data-testid="status-badge"
      data-tone={tone}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium leading-5",
        STATUS_TONE_CLASSES[tone],
        className,
      )}
    >
      {srLabel ? <span className="sr-only">{srLabel} </span> : null}
      {dot ? (
        <span
          aria-hidden
          data-testid="status-badge-dot"
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT_TONE_CLASSES[tone])}
        />
      ) : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

export default StatusBadge;
