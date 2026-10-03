import * as React from "react";
import {
  get,
  useForm,
  type FieldErrors,
  type FieldValues,
  type Resolver,
  type UseFormProps,
  type UseFormReturn,
} from "react-hook-form";
import type { RefusalSink } from "./input-refusal-reporter";

/**
 * A text input knows why it refused what was typed ("1234.50" in a whole-taka
 * amount); the form only sees `NaN`, so its schema can say no more than "not a
 * number". The input tells its form here, and the form's resolver puts the
 * reason on that field's error, so the message under the field, the save
 * banner and every other reader of `formState.errors` agree. `<Form>` hands
 * the form's refusals to its inputs (`input-refusal-reporter.ts`).
 */
interface InputRefusals extends RefusalSink {
  /** Gives each refused field's error its reason. */
  explain(values: FieldValues, errors: FieldErrors): void;
}

function createRefusals(): InputRefusals {
  const reasons = new Map<string, string>();
  return {
    report(name, reason) {
      if (reason) reasons.set(name, reason);
      else reasons.delete(name);
    },
    explain(values, errors) {
      for (const [name, reason] of reasons) {
        const value: unknown = get(values, name);
        // Only while the form still holds the refused value (NaN): a reset or an outside edit drops it.
        const error: { message?: string } | undefined = typeof value === "number" && Number.isNaN(value) ? get(errors, name) : undefined;
        if (error) error.message = reason;
      }
    },
  };
}

/** One per form, found from the form's `control` by `<Form>`. */
const refusalsByForm = new WeakMap<object, InputRefusals>();

/**
 * `useForm` for a form with money fields: a `MoneyInput` inside it can say why
 * it refused the typed amount (a fraction in whole taka) instead of the
 * schema's generic "enter a number". Same options and result as `useForm`.
 */
export function useFormWithRefusals<
  TFieldValues extends FieldValues = FieldValues,
  TContext = unknown,
  TTransformedValues = TFieldValues,
>(props: UseFormProps<TFieldValues, TContext, TTransformedValues>): UseFormReturn<TFieldValues, TContext, TTransformedValues> {
  const [refusals] = React.useState(createRefusals);
  const { resolver } = props;
  const explaining: Resolver<TFieldValues, TContext, TTransformedValues> | undefined = resolver
    ? async (values, context, options) => {
        const result = await resolver(values, context, options);
        refusals.explain(values, result.errors);
        return result;
      }
    : undefined;
  const form = useForm<TFieldValues, TContext, TTransformedValues>({ ...props, resolver: explaining });
  refusalsByForm.set(form.control, refusals);
  return form;
}

/** The refusals of the form that owns `control`, when it was made with `useFormWithRefusals`. */
export function formRefusals(control: object): RefusalSink | null {
  return refusalsByForm.get(control) ?? null;
}
