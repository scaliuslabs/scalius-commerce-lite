import { useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SaveNotCompleted } from "~/components/admin/shared/use-form-save-bar";
import { translate } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { getServerFnError } from "~/lib/api-helpers";

interface UseEntityFormSubmitOptions<TValues> {
  isEdit: boolean;
  /** The record being edited; falls back to `values.id`. */
  entityId?: string;
  createFn: (data: TValues) => Promise<unknown>;
  updateFn: (data: TValues & { id: string }) => Promise<unknown>;
  /** Query keys to invalidate on success */
  invalidateKeys: readonly (readonly unknown[])[];
  /** Optional pre-submit transform. Return the modified values. */
  transformValues?: (values: TValues) => TValues;
  /**
   * Marks fields a failure belongs to and returns the words for the save
   * banner; returning nothing lets the save bar describe the error.
   */
  onError?: (error: unknown, message: string) => string | undefined;
  /** Called with the saved record: reset the form, move to the new record's page. */
  onSuccess: (result: unknown) => void;
}

/**
 * Creates or updates a record and refreshes the listed queries. A failure
 * rejects with `SaveNotCompleted`, whose message the save bar's banner shows
 * while the edits stay in place.
 */
export function useEntityFormSubmit<TValues extends Record<string, unknown>>({
  isEdit,
  entityId,
  createFn,
  updateFn,
  invalidateKeys,
  transformValues,
  onError,
  onSuccess,
}: UseEntityFormSubmitOptions<TValues>) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const queryClient = useQueryClient();

  const handleSubmit = useCallback(
    async (values: TValues) => {
      setIsSubmitting(true);
      try {
        const finalValues = transformValues ? transformValues(values) : values;
        let result: unknown;
        if (isEdit) {
          const id = entityId || ((finalValues as Record<string, unknown>).id as string | undefined);
          if (!id) throw new Error(translate(resourceMessages, "saveFailedHelp"));
          result = await updateFn({ ...finalValues, id });
        } else {
          result = await createFn(finalValues);
        }

        await Promise.all(
          invalidateKeys.map((key) => queryClient.invalidateQueries({ queryKey: key as unknown[] })),
        );
        onSuccess(result);
        return result;
      } catch (error: unknown) {
        const explained = onError?.(error, getServerFnError(error, translate(resourceMessages, "saveFailedHelp")));
        // Unexplained failures go to the save bar as they are; it words network and server errors.
        throw explained ? new SaveNotCompleted(explained) : error;
      } finally {
        setIsSubmitting(false);
      }
    },
    [isEdit, entityId, createFn, updateFn, invalidateKeys, transformValues, onError, onSuccess, queryClient],
  );

  return { isSubmitting, handleSubmit } as const;
}
