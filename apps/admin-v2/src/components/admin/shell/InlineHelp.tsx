import type { ReactNode } from "react";

import { cn } from "@scalius/shared/utils";

export interface InlineHelpProps {
  /** Wire this into the field's `aria-describedby`. */
  id?: string;
  children: ReactNode;
  className?: string;
}

/**
 * Muted helper text under a field. Say what happens, not what the field "is".
 * Swap it for `FieldError` (same slot, same id) once the field is invalid so
 * the description does not fight with the error.
 */
export function InlineHelp({ id, children, className }: InlineHelpProps) {
  if (children === null || children === undefined || children === false) return null;
  return (
    <p
      id={id}
      data-testid="inline-help"
      className={cn("text-xs leading-5 text-muted-foreground", className)}
    >
      {children}
    </p>
  );
}

export default InlineHelp;
