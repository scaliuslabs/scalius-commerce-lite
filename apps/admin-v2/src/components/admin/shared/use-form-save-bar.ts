import type { FieldValues, UseFormReturn } from "react-hook-form";
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
}

/**
 * Puts a react-hook-form editor on the page's contextual save bar. The bar
 * appears once the form is dirty; Save validates and runs `save`, and Discard
 * returns to the last saved values. Call it inside a `SaveBarProvider`.
 */
export function useFormSaveBar<T extends FieldValues, R extends FieldValues>({
  form,
  saving,
  locked = false,
  save,
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
              await save(values);
              resolve();
            },
            () => reject(new SaveNotCompleted(translate(resourceMessages, "fixFields"))),
          )()
          .catch(reject);
      }),
    discard: () => form.reset(),
  });
}
