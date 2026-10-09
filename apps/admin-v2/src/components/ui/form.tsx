import { Controller, FormProvider } from "react-hook-form";
import type { ControllerProps, FieldPath, FieldValues, FormProviderProps } from "react-hook-form";

import { InputRefusalsContext } from "~/lib/input-refusal-reporter";
import { formRefusals } from "~/lib/input-refusals";

/** `FormProvider`, plus the form's input refusals for a form made with `useFormWithRefusals`. */
function Form<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues>(
  props: FormProviderProps<TFieldValues, TContext, TTransformedValues>,
) {
  return (
    <FormProvider {...props}>
      <InputRefusalsContext.Provider value={formRefusals(props.control)}>{props.children}</InputRefusalsContext.Provider>
    </FormProvider>
  );
}

/**
 * One react-hook-form value. Render a `Field` from `components/ui/field` with
 * the value's error: `render={({ field, fieldState }) => <Field label=… error={fieldState.error?.message}>…</Field>}`.
 */
const FormField = <
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
  TTransformedValues extends FieldValues = TFieldValues,
>(props: ControllerProps<TFieldValues, TName, TTransformedValues>) => <Controller {...props} />;

export { Form, FormField };
