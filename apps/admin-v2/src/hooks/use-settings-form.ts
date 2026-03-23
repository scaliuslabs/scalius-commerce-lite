import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";

interface UseSettingsFormOptions<T extends object> {
  fetchFn: () => Promise<Partial<T>>;
  saveFn: (values: T) => Promise<unknown>;
  defaultValues: T;
  successMessage?: string;
  errorMessage?: string;
}

/**
 * Generic hook for settings forms that follow the common pattern:
 *   1. Fetch settings on mount
 *   2. Manage N fields as a single object
 *   3. Submit all fields, show toast, re-fetch
 *
 * Replaces the boilerplate of N useState calls + loading + saving + useEffect + handleSubmit.
 */
export function useSettingsForm<T extends object>({
  fetchFn,
  saveFn,
  defaultValues,
  successMessage = "Settings saved",
  errorMessage = "Failed to save settings",
}: UseSettingsFormOptions<T>) {
  const [values, setValues] = useState<T>(defaultValues);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const fetchSettings = useCallback(async () => {
    try {
      setIsLoading(true);
      const data = await fetchFn();
      setValues((prev) => ({ ...prev, ...data }));
    } catch (err) {
      console.error("Failed to load settings:", err);
    } finally {
      setIsLoading(false);
    }
  }, [fetchFn]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const setValue = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSubmit = useCallback(async () => {
    try {
      setIsSaving(true);
      await saveFn(values);
      toast.success(successMessage);
      await fetchSettings();
    } catch {
      toast.error(errorMessage);
    } finally {
      setIsSaving(false);
    }
  }, [values, saveFn, successMessage, errorMessage, fetchSettings]);

  return {
    values,
    setValue,
    setValues,
    isLoading,
    isSaving,
    handleSubmit,
    refetch: fetchSettings,
  };
}
