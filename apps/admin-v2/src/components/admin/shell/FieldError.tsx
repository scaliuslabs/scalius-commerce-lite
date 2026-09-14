import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@scalius/shared/utils";

export interface FieldErrorProps {
  /** Wire this into the field's `aria-describedby`, alongside `aria-invalid`. */
  id?: string;
  /** Nothing renders when there is no message, so it is safe to always mount. */
  children?: ReactNode;
  className?: string;
}

/**
 * Validation message for a single field: icon plus text, announced when it
 * appears. Pair it with `aria-invalid` on the input.
 */
export function FieldError({ id, children, className }: FieldErrorProps) {
  if (children === null || children === undefined || children === false || children === "") {
    return null;
  }
  return (
    <p
      id={id}
      role="alert"
      data-testid="field-error"
      className={cn("flex items-start gap-1.5 text-xs leading-5 text-destructive", className)}
    >
      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

export default FieldError;
