import { useCallback, useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

interface UseSettingsFormOptions<T extends object> {
  queryKey: readonly unknown[];
  fetchFn: () => Promise<Partial<T>>;
  saveFn: (values: T) => Promise<unknown>;
  defaultValues: T;
  successMessage?: string;
  errorMessage?: string;
}

/**
 * Generic hook for settings forms that follow the common pattern:
 *   1. Fetch settings via TanStack Query
 *   2. Manage N fields as a single object (local state synced from query)
 *   3. Submit all fields via mutation, show toast, invalidate cache
 *
 * Replaces the boilerplate of N useState calls + loading + saving + useEffect + handleSubmit.
 */
export function useSettingsForm<T extends object>({
  queryKey,
  fetchFn,
  saveFn,
  defaultValues,
  successMessage = "Settings saved",
  errorMessage = "Failed to save settings",
}: UseSettingsFormOptions<T>) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: queryKey as unknown[],
    queryFn: fetchFn,
  });

  // Local values state that syncs with query data
  const [values, setValues] = useState<T>(defaultValues);

  // Sync query data to local state when data changes
  useEffect(() => {
    if (data) {
      setValues((prev) => ({ ...prev, ...data }));
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: saveFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKey as unknown[] });
      toast.success(successMessage);
    },
    onError: (error) => {
      toast.error(error instanceof Error && error.message ? error.message : errorMessage);
    },
  });

  const setValue = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSubmit = useCallback(async () => {
    await mutation.mutateAsync(values);
  }, [values, mutation]);

  return {
    values,
    setValue,
    setValues,
    isLoading,
    isSaving: mutation.isPending,
    handleSubmit,
    refetch: () =>
      queryClient.invalidateQueries({ queryKey: queryKey as unknown[] }),
  };
}
