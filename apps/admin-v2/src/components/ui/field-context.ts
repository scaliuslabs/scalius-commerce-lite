import * as React from "react";

/** What a `Field` tells the control inside it. */
export interface FieldControlState {
  id: string;
  /** The help or the error under the control (never both). */
  describedBy?: string;
  invalid: boolean;
}

export const FieldContext = React.createContext<FieldControlState | null>(null);

type ControlProps = {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false" | "grammar" | "spelling";
};

/**
 * Gives a control its field's id, help or error reference and invalid state.
 * Whatever the control sets itself wins. One control per `Field`: a second
 * control inside the same field passes its own `id`.
 */
export function useFieldControl<P extends ControlProps>(props: P): P {
  const field = React.useContext(FieldContext);
  if (!field) return props;
  return {
    ...props,
    id: props.id ?? field.id,
    "aria-describedby": props["aria-describedby"] ?? field.describedBy,
    "aria-invalid": props["aria-invalid"] ?? (field.invalid || undefined),
  };
}
