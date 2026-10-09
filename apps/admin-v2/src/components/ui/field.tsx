import * as React from "react";

import { cn } from "@scalius/shared/utils";
import { useMessages } from "~/i18n";
import { formMessages } from "~/i18n/forms";
import { FieldContext, type FieldControlState } from "./field-context";
import { Label } from "./label";

export { useFieldControl } from "./field-context";

type FieldProps = Omit<React.HTMLAttributes<HTMLDivElement>, "children"> & {
  /**
   * Sentence case, one to three words. Never the unit or currency: those go
   * inside the control. Leave it out only when the card title names the one
   * control (the control then carries an `aria-label`).
   */
  label?: React.ReactNode;
  /** The control's id. Made up when left out; `Input`, `Textarea`, `NumberInput`, `MoneyInput`, `SearchableSelect` and `DateInput` pick it up. */
  id?: string;
  /** One line under the control. */
  help?: React.ReactNode;
  /** Replaces the help while the value is wrong, and marks the control invalid. */
  error?: React.ReactNode;
  /** Adds "(optional)" after the label. Required fields carry no mark. */
  optional?: boolean;
  /** Keeps the label for screen readers only (a field in a table row whose column says it). */
  hideLabel?: boolean;
  /** A link at the end of the label line ("Manage policies"). Text size, never a button. */
  labelAction?: React.ReactNode;
  children: React.ReactNode;
};

/**
 * The one field (DESIGN.md F1): label above, control, then help or error
 * under it, 4px apart (S2, S3). The control gets the field's id, its help or
 * error as `aria-describedby`, and `aria-invalid` while there is an error.
 */
export function Field({ label, id, help, error, optional, hideLabel, labelAction, className, children, ...props }: FieldProps) {
  const t = useMessages(formMessages);
  const ownId = React.useId();
  const controlId = id ?? ownId;
  const hasError = error !== undefined && error !== null && error !== false && error !== "";
  const hasHelp = !hasError && help !== undefined && help !== null && help !== false && help !== "";
  const noteId = hasError ? `${controlId}-error` : hasHelp ? `${controlId}-help` : undefined;
  const state = React.useMemo<FieldControlState>(
    () => ({ id: controlId, describedBy: noteId, invalid: hasError }),
    [controlId, noteId, hasError],
  );
  const labelNode = label === undefined ? null : (
    <Label data-slot="field-label" id={`${controlId}-label`} htmlFor={controlId} className={cn(hideLabel && "sr-only")}>
      {label}
      {optional ? <span className="font-normal text-muted-foreground"> {t("optional")}</span> : null}
    </Label>
  );
  return (
    <div data-slot="field" className={cn("flex min-w-0 flex-col gap-1", className)} {...props}>
      {labelAction && labelNode && !hideLabel ? (
        <div className="flex items-baseline justify-between gap-2">
          {labelNode}
          {labelAction}
        </div>
      ) : labelNode}
      <FieldContext.Provider value={state}>
        <div data-slot="field-control">{children}</div>
      </FieldContext.Provider>
      {hasError ? (
        <p data-slot="field-error" id={noteId} className="text-body text-destructive">{error}</p>
      ) : hasHelp ? (
        <p data-slot="field-help" id={noteId} className="text-body text-muted-foreground">{help}</p>
      ) : null}
    </div>
  );
}

/**
 * A single checkbox, switch or radio with its label after it on the same line
 * (F2), and help under the label. The control is passed as `control` and must
 * carry `id`.
 */
export function ChoiceField({ id, label, help, control, className }: {
  id: string;
  label: React.ReactNode;
  help?: React.ReactNode;
  control: React.ReactNode;
  className?: string;
}) {
  return (
    <div data-slot="field" className={cn("flex min-w-0 items-start gap-2", className)}>
      {/* The control sits on the label's first line (rule 10). */}
      <div data-slot="field-control" className="flex h-lh shrink-0 items-center text-body">{control}</div>
      <div className="flex min-w-0 flex-col gap-1">
        <Label data-slot="field-label" htmlFor={id} className="font-normal">{label}</Label>
        {help ? <p data-slot="field-help" id={`${id}-help`} className="text-body text-muted-foreground">{help}</p> : null}
      </div>
    </div>
  );
}

/** Fields stacked in a card: 16px apart, 12px inside an `Inset` (S4). */
export function FieldGroup({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="field-group" className={cn("flex min-w-0 flex-col gap-4 in-data-[slot=inset]:gap-3", className)} {...props} />;
}

/**
 * Fields side by side on one grid (S5): equal columns, tops aligned, 16px
 * apart (12px in an `Inset`). The row goes to one column when its own width
 * is narrow (a phone, a side column), not only when the window is.
 */
export function FieldRow({ columns = 2, className, ...props }: React.HTMLAttributes<HTMLDivElement> & { columns?: 2 | 3 }) {
  return (
    <div className="@container min-w-0">
      <div
        data-slot="field-row"
        className={cn(
          "grid items-start gap-4 in-data-[slot=inset]:gap-3",
          columns === 3 ? "@lg:grid-cols-3" : "@md:grid-cols-2",
          className,
        )}
        {...props}
      />
    </div>
  );
}

/**
 * A value that cannot be edited here (view-only permission, a locked order):
 * the field's label over plain text, never a disabled input (R5). An empty
 * value reads "—".
 */
export function ReadOnlyValue({ label, value, help, mono = false, className }: {
  label: React.ReactNode;
  value: React.ReactNode;
  help?: React.ReactNode;
  /** Codes (SKU, barcode, tracking): monospace, broken anywhere (F5, N4). */
  mono?: boolean;
  className?: string;
}) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div data-slot="field" className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span data-slot="field-label" className="text-body font-medium">{label}</span>
      <div data-slot="field-control" className={cn("text-body wrap-anywhere", mono && "font-mono", empty && "text-muted-foreground")}>
        {empty ? "—" : value}
      </div>
      {help ? <p data-slot="field-help" className="text-body text-muted-foreground">{help}</p> : null}
    </div>
  );
}

/**
 * The quiet inset (K3): detail that belongs to one row of a card (an expanded
 * variant, an address, a line item). Fields inside it are 12px apart.
 */
export function Inset({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="inset" className={cn("min-w-0 rounded-lg border bg-muted/30 p-3", className)} {...props} />;
}
