import { useState, useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getServerFnError } from "~/lib/api-helpers";

interface UseEntityFormSubmitOptions<TValues> {
  /** Display name for toast messages, e.g. "Category", "Page" */
  entityName: string;
  isEdit: boolean;
  /** Required when isEdit is true */
  entityId?: string;
  createFn: (data: TValues) => Promise<unknown>;
  updateFn: (data: TValues & { id: string }) => Promise<unknown>;
  /** Query keys to invalidate on success */
  invalidateKeys: readonly (readonly unknown[])[];
  /** Route to navigate to on success, e.g. "/admin/categories" */
  navigateTo: string;
  /** Optional pre-submit transform. Return the modified values. */
  transformValues?: (values: TValues) => TValues;
  /** Optional: called with the error and message. Return true to suppress the default toast. */
  onError?: (
    error: unknown,
    message: string,
    setFieldError: (field: string, message: string) => void,
  ) => boolean;
  /** Optional: called on success with the result. If provided, suppresses default toast + navigation. */
  onSuccess?: (result: unknown) => void;
}

export function useEntityFormSubmit<
  TValues extends Record<string, unknown>,
>({
  entityName,
  isEdit,
  entityId,
  createFn,
  updateFn,
  invalidateKeys,
  navigateTo,
  transformValues,
  onError,
  onSuccess,
}: UseEntityFormSubmitOptions<TValues>) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const handleSubmit = useCallback(
    async (
      values: TValues,
      setFieldError?: (field: string, message: string) => void,
    ) => {
      try {
        setIsSubmitting(true);

        const finalValues = transformValues ? transformValues(values) : values;

        let result: unknown;
        if (isEdit) {
          const id =
            entityId || (finalValues as Record<string, unknown>).id as string;
          if (!id) throw new Error(`${entityName} ID is required for update`);
          result = await updateFn({
            ...finalValues,
            id,
          } as TValues & { id: string });
        } else {
          result = await createFn(finalValues);
        }

        await Promise.all(
          invalidateKeys.map((key) =>
            queryClient.invalidateQueries({ queryKey: key as unknown[] }),
          ),
        );

        if (onSuccess) {
          onSuccess(result);
        } else {
          toast.success(
            isEdit
              ? `${entityName} updated successfully!`
              : `${entityName} created successfully!`,
          );
          void navigate({ to: navigateTo });
        }

        return result;
      } catch (error: unknown) {
        const errorMessage = getServerFnError(
          error,
          `Failed to save ${entityName.toLowerCase()}`,
        );
        const handled = onError?.(
          error,
          errorMessage,
          setFieldError ?? (() => {}),
        );
        if (!handled) {
          toast.error(`Failed to save ${entityName.toLowerCase()}`, {
            description: errorMessage,
            duration: 6000,
          });
        }
      } finally {
        setIsSubmitting(false);
      }
    },
    [
      isEdit,
      entityId,
      entityName,
      createFn,
      updateFn,
      invalidateKeys,
      navigateTo,
      transformValues,
      onError,
      onSuccess,
      navigate,
      queryClient,
    ],
  );

  return { isSubmitting, handleSubmit } as const;
}
