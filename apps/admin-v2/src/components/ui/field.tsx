import * as React from "react";

import { cn } from "@scalius/shared/utils";
import { useMessages } from "~/i18n";
import { fieldMessages } from "~/i18n/field";
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
  /** The help or error element's id, when another part of the page refers to it (default `<id>-help`, `<id>-error`). */
  noteId?: string;
  /** Reads the error out as it appears (a field checked when it is left, not on a submit that lists every error). */
  announceError?: boolean;
  /** A link at the end of the label line ("Manage policies"). Text size, never a button. */
  labelAction?: React.ReactNode;
  children: React.ReactNode;
};

/**
 * The one field (DESIGN.md F1): label above, control, then help or error
 * under it, 4px apart (S2, S3). The control gets the field's id, its help or
 * error as `aria-describedby`, and `aria-invalid` while there is an error.
 */
export function Field({ label, id, help, error, optional, hideLabel, labelAction, noteId: fixedNoteId, announceError = false, className, children, ...props }: FieldProps) {
  const t = useMessages(fieldMessages);
  const ownId = React.useId();
  const controlId = id ?? ownId;
  const hasError = error !== undefined && error !== null && error !== false && error !== "";
  const hasHelp = !hasError && help !== undefined && help !== null && help !== false && help !== "";
  const noteId = !hasError && !hasHelp ? undefined : fixedNoteId ?? (hasError ? `${controlId}-error` : `${controlId}-help`);
  const state = React.useMemo<FieldControlState>(
    // A field with no label (the card title names it) lends no id: a picker inside keeps its own name.
    () => ({ id: label === undefined && id === undefined ? undefined : controlId, describedBy: noteId, invalid: hasError }),
    [label, id, controlId, noteId, hasError],
  );
  const labelNode = label === undefined ? null : (
    <Label data-slot="field-label" id={`${controlId}-field-label`} htmlFor={controlId} className={cn(hideLabel && "sr-only")}>
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
        <p data-slot="field-error" id={noteId} role={announceError ? "alert" : undefined} className="text-body text-destructive">{error}</p>
      ) : hasHelp ? (
        <p data-slot="field-help" id={noteId} className="text-body text-muted-foreground">{help}</p>
      ) : null}
    </div>
  );
}

/**
 * A single checkbox, switch or radio with its label after it on the same line
 * (F2), and help under the label. The control is passed as `control` and must
 * carry `id`. A switch for a setting that applies at once may sit at the end
 * of the row instead (`controlAt="end"`), as in Shopify's settings.
 */
export function ChoiceField({ id, label, help, control, controlAt = "start", className }: {
  id: string;
  label: React.ReactNode;
  help?: React.ReactNode;
  control: React.ReactNode;
  controlAt?: "start" | "end";
  className?: string;
}) {
  return (
    <div data-slot="field" className={cn("flex min-w-0 items-start gap-2", controlAt === "end" && "justify-between gap-3", className)}>
      {/* The control sits on the label's first line (rule 10). */}
      <div data-slot="field-control" className={cn("flex h-lh shrink-0 items-center text-body", controlAt === "end" && "order-last")}>{control}</div>
      <div className="flex min-w-0 flex-col gap-1">
        <Label data-slot="field-label" htmlFor={id}>{label}</Label>
        {help ? <p data-slot="choice-help" id={`${id}-help`} className="text-body text-muted-foreground">{help}</p> : null}
      </div>
    </div>
  );
}

/**
 * The text action at the end of a field's label line (`labelAction`):
 * "Generate code", "Manage policies", "Done". One text line high, so the label
 * stays 4px above its control.
 */
export function FieldAction({ className, type = "button", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cn("rounded-md text-body text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50", className)}
      {...props}
    />
  );
}

/**
 * A label over a group of controls that is not one input (a choice list, a
 * picker with its own buttons): the label names the group for screen readers.
 */
export function FieldSet({ label, help, error, className, children }: {
  label: React.ReactNode;
  help?: React.ReactNode;
  error?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const id = React.useId();
  return (
    <div role="group" aria-labelledby={`${id}-label`} data-slot="field" className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span id={`${id}-label`} data-slot="field-label" className="text-body font-medium">{label}</span>
      <div data-slot="field-control">{children}</div>
      {error ? (
        <p data-slot="field-error" className="text-body text-destructive">{error}</p>
      ) : help ? (
        <p data-slot="field-help" className="text-body text-muted-foreground">{help}</p>
      ) : null}
    </div>
  );
}

/** Fields stacked in a card: 16px apart; 12px inside an `Inset` (`inset`, S4). */
export function FieldGroup({ inset = false, className, ...props }: React.HTMLAttributes<HTMLDivElement> & { inset?: boolean }) {
  return <div data-slot="field-group" className={cn("flex min-w-0 flex-col", inset ? "gap-3" : "gap-4", className)} {...props} />;
}

/**
 * Fields side by side on one grid (S5): equal columns, tops aligned, 16px
 * apart (12px in an `Inset`: `inset`). Two columns go to one when the row's own width
 * is narrow (a phone, a side column), not only when the window is.
 */
export function FieldRow({ columns = 2, inset = false, className, ...props }: React.HTMLAttributes<HTMLDivElement> & {
  /** 1 keeps a lone field full width in a list of rows. */
  columns?: 1 | 2 | 3;
  /** Inside an `Inset`: 12px apart (S4). */
  inset?: boolean;
}) {
  return (
    <div className="@container min-w-0">
      <div
        data-slot="field-row"
        className={cn(
          "grid items-start",
          inset ? "gap-3" : "gap-4",
          // Three columns follow the window (sm), two follow the row's own width.
          columns === 3 ? "sm:grid-cols-3" : columns === 2 ? "@md:grid-cols-2" : undefined,
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
export function ReadOnlyValue({ label, value, help, mono = false, numeric = false, besideControls = false, className }: {
  label: React.ReactNode;
  value: React.ReactNode;
  help?: React.ReactNode;
  /** Codes (SKU, barcode, tracking): monospace, broken anywhere (F5, N4). */
  mono?: boolean;
  /** Money and counts: tabular digits. */
  numeric?: boolean;
  /** In a row of inputs: the value sits on the inputs' line (36px, 44px on phones). */
  besideControls?: boolean;
  className?: string;
}) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div data-slot="field" className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span data-slot="field-label" className="text-body font-medium">{label}</span>
      <div
        data-slot="field-control"
        className={cn(
          "text-body break-words",
          besideControls && "flex min-h-11 items-center sm:min-h-9",
          mono && "font-mono",
          numeric && "tabular-nums",
          empty && "text-muted-foreground",
        )}
      >
        {empty ? "—" : value}
      </div>
      {help ? <p data-slot="field-help" className="text-body text-muted-foreground">{help}</p> : null}
    </div>
  );
}

/**
 * The quiet inset (K3): detail that belongs to one row of a card (an expanded
 * variant, an address, a line item). Fields inside it are 12px apart (`inset` on their FieldRow or FieldGroup).
 */
export function Inset({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="inset" className={cn("min-w-0 rounded-lg border bg-muted/30 p-3", className)} {...props} />;
}
