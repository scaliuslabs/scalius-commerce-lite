import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

interface UseSettingsFormOptions<T extends object, SaveResult> {
  queryKey: readonly unknown[];
  fetchFn: () => Promise<Partial<T>>;
  saveFn: (values: T) => Promise<SaveResult>;
  resolveSavedValues?: (result: SaveResult, submittedValues: T) => T | undefined;
  defaultValues: T;
  successMessage?: string;
  errorMessage?: string;
  invalidateQueryKeys?: readonly (readonly unknown[])[];
}

/**
 * Generic hook for settings forms that follow the common pattern:
 *   1. Fetch settings via TanStack Query
 *   2. Manage N fields as a single object (local state synced from query)
 *   3. Submit all fields via mutation, show toast, invalidate cache
 *
 * Replaces the boilerplate of N useState calls + loading + saving + useEffect + handleSubmit.
 */
export function useSettingsForm<T extends object, SaveResult = unknown>({
  queryKey,
  fetchFn,
  saveFn,
  resolveSavedValues,
  defaultValues,
  successMessage = "Settings saved",
  errorMessage = "Failed to save settings",
  invalidateQueryKeys = [],
}: UseSettingsFormOptions<T, SaveResult>) {
  const queryClient = useQueryClient();

  const { data, error, isError, isLoading } = useQuery({
    queryKey: queryKey as unknown[],
    queryFn: fetchFn,
  });
  const hasLoaded = data !== undefined && !isError;

  // Local values state that syncs with query data
  const defaultValuesRef = useRef(defaultValues);
  const [values, setValues] = useState<T>(defaultValues);
  const [savedValues, setSavedValues] = useState<T>(defaultValues);

  // Sync query data to local state when data changes
  useEffect(() => {
    if (data) {
      const nextValues = { ...defaultValuesRef.current, ...data } as T;
      setValues(nextValues);
      setSavedValues(nextValues);
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: saveFn,
    onSuccess: async (result, submittedValues) => {
      const canonicalValues = resolveSavedValues?.(result, submittedValues);
      const nextValues = canonicalValues ?? submittedValues;
      setValues(nextValues);
      setSavedValues(nextValues);

      const invalidations = invalidateQueryKeys.map((key) =>
        queryClient.invalidateQueries({ queryKey: key as unknown[] }),
      );
      if (canonicalValues) {
        await queryClient.cancelQueries({ queryKey: queryKey as unknown[] });
        queryClient.setQueryData(queryKey as unknown[], canonicalValues);
      } else {
        invalidations.push(
          queryClient.invalidateQueries({ queryKey: queryKey as unknown[] }),
        );
      }
      await Promise.all(invalidations);
      toast.success(successMessage);
    },
    onError: (error) => {
      toast.error(error instanceof Error && error.message ? error.message : errorMessage);
    },
  });

  const setValue = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const isDirty = JSON.stringify(values) !== JSON.stringify(savedValues);
  const reset = useCallback(() => {
    setValues(savedValues);
  }, [savedValues]);

  const handleSubmit = useCallback(async () => {
    if (!hasLoaded) {
      toast.error("Reload settings before saving.");
      return;
    }
    await mutation.mutateAsync(values);
  }, [hasLoaded, values, mutation]);

  return {
    values,
    setValue,
    setValues,
    isDirty,
    reset,
    isLoading,
    isLoaded: hasLoaded,
    isLoadError: isError,
    loadError: error,
    isSaving: mutation.isPending,
    handleSubmit,
    refetch: () =>
      queryClient.invalidateQueries({ queryKey: queryKey as unknown[] }),
  };
}

export function getSettingsLoadErrorMessage(
  error: unknown,
  fallback: string,
): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
