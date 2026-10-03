import * as React from "react";

/**
 * Where an input inside a form says why it refused what was typed. Kept apart
 * from `input-refusals.ts` (and from react-hook-form) so an input such as
 * `MoneyInput` adds no form library to a page that has no form.
 */
export interface RefusalSink {
  /** Why `name` refuses what was typed; `null` once it no longer does. */
  report(name: string, reason: string | null): void;
}

/** Provided by `<Form>` for a form made with `useFormWithRefusals`; null anywhere else. */
export const InputRefusalsContext = React.createContext<RefusalSink | null>(null);

/**
 * For an input inside a `useFormWithRefusals` form: reports why `name` (the
 * form's field name) refuses what was typed. Undefined anywhere else, so the
 * input can be used with or without a form.
 */
export function useRefusalReporter(name: string | undefined): ((reason: string | null) => void) | undefined {
  const refusals = React.useContext(InputRefusalsContext);
  React.useEffect(() => () => {
    if (name) refusals?.report(name, null);
  }, [refusals, name]);
  return React.useMemo(
    () => (refusals && name ? (reason: string | null) => refusals.report(name, reason) : undefined),
    [refusals, name],
  );
}
