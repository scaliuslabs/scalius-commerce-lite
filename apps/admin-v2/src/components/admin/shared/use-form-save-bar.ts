import type { FieldValues, Path, PathValue, UseFormReturn } from "react-hook-form";
import { translate } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { SaveNotCompleted, useSaveBar } from "./SaveBar";

export { SaveNotCompleted };

interface FormSaveBarOptions<T extends FieldValues, R extends FieldValues> {
  form: UseFormReturn<T, unknown, R>;
  saving: boolean;
  /** The merchant may not save (role, fail-closed lock). */
  locked?: boolean;
  /** Saves valid values; throws when the save failed. */
  save: (values: R) => Promise<unknown>;
  /** Fields the server set on save (a new id, the next revision), from what `save` resolved with. */
  savedValues?: (result: unknown) => Partial<T>;
  /** After a revision conflict: loads the latest saved record under the merchant's edits. */
  reload?: () => Promise<unknown>;
}

/** A deep copy of form values (plain objects, arrays, dates; files and other instances as they are). */
export function copyValues<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copyValues) as T;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyValues(item)])) as T;
  }
  return value;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Makes `saved` the form's last-saved values without losing work: a field the
 * merchant changed since `before` was taken (while a save was on its way, or
 * before a reload) keeps the edit and stays dirty; every other field takes
 * its saved value.
 */
export function rebaseForm<T extends FieldValues, C, R extends FieldValues>(
  form: UseFormReturn<T, C, R>,
  before: T,
  saved: T,
) {
  const current = form.getValues();
  form.reset(saved, { keepValues: true });
  for (const key of Object.keys({ ...saved, ...current }) as Array<Path<T>>) {
    const edited = !same(current[key], before[key]);
    const next = (edited ? current[key] : saved[key]) as PathValue<T, Path<T>>;
    // Marks the edits dirty again (reset cleared the list) and puts saved values in place.
    if (!same(next, current[key]) || !same(next, saved[key])) form.setValue(key, next, { shouldDirty: true });
  }
}

/**
 * Puts a react-hook-form editor on the page's contextual save bar. The bar
 * appears once the form is dirty; Save validates and runs `save`, then the
 * values sent become the last-saved ones (edits typed meanwhile stay unsaved),
 * and Discard returns to the last saved values. Call it inside a `SaveBarProvider`.
 */
export function useFormSaveBar<T extends FieldValues, R extends FieldValues>({
  form,
  saving,
  locked = false,
  save,
  savedValues,
  reload,
}: FormSaveBarOptions<T, R>) {
  const { isDirty, errors } = form.formState;
  useSaveBar({
    dirty: isDirty,
    saving,
    invalid: locked || Object.keys(errors).length > 0,
    save: () =>
      new Promise<void>((resolve, reject) => {
        form
          .handleSubmit(
            async (values) => {
              const sent = copyValues(form.getValues());
              const result = await save(values);
              rebaseForm(form, sent, { ...sent, ...savedValues?.(result) });
              resolve();
            },
            () => reject(new SaveNotCompleted(translate(resourceMessages, "fixFields"))),
          )()
          .catch(reject);
      }),
    discard: () => form.reset(),
    reload,
  });
}
