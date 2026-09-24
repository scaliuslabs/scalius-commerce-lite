import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useSaveBar, type SaveBarEntry } from "~/components/admin/shared/SaveBar";
import { readSettingsRevisionConflict } from "~/lib/admin-api-error";
import { translate } from "~/i18n";
import { saveBarMessages } from "~/i18n/save-bar";

/**
 * A settings document's revision as its GET returns it (`data.revision`): a
 * number, or one number per document for an endpoint that edits several.
 */
export type SettingsRevision = number | Record<string, number>;

interface UseSettingsFormOptions<T extends object, SaveResult, R extends SettingsRevision> {
  queryKey: readonly unknown[];
  /** The GET payload; its `revision` is kept apart from the form values. */
  fetchFn: () => Promise<Partial<T>>;
  /** Sends the values with the revision they were loaded at (`expectedRevision`). */
  saveFn: (values: T, expectedRevision: R) => Promise<SaveResult>;
  resolveSavedValues?: (result: SaveResult, submittedValues: T) => T | undefined;
  defaultValues: T;
  successMessage?: string;
  errorMessage?: string;
  invalidateQueryKeys?: readonly (readonly unknown[])[];
  /** Inside a page save bar: false blocks saving (the card shows why). */
  isValid?: (values: T) => boolean;
  /** Inside a page save bar: false blocks saving for this role. */
  canEdit?: boolean;
  /** Names this card in the page's "couldn't save" banner. */
  label?: string;
  /** API body path → control id, so a rejected field is marked in place (see `SaveBarEntry.fields`). */
  fields?: SaveBarEntry["fields"];
}

export function mergeUneditedFields<T extends object>(current: T, baseline: T, incoming: T): T {
  const next = { ...incoming };
  for (const key of Object.keys({ ...baseline, ...current }) as (keyof T)[]) {
    if (JSON.stringify(current[key]) !== JSON.stringify(baseline[key])) {
      next[key] = current[key];
    }
  }
  return next;
}

function readRevision(data: unknown): SettingsRevision | undefined {
  const revision = data && typeof data === "object" ? (data as { revision?: unknown }).revision : undefined;
  return typeof revision === "number" || (revision !== null && typeof revision === "object")
    ? revision as SettingsRevision
    : undefined;
}

/** The revision travels beside the values, never inside them. */
function withoutRevision<T extends object>(data: T): T {
  const { revision: _revision, ...fields } = data as T & { revision?: unknown };
  return fields as T;
}

function formValues<T extends object>(defaults: T, data: Partial<T> | undefined): T {
  return { ...defaults, ...withoutRevision(data ?? {}) } as T;
}

/**
 * One settings card: loads its document, keeps the merchant's draft, and saves
 * it at the revision it was loaded at. Inside a page save bar the bar owns
 * Save/Discard and the error banner; a save refused because someone else saved
 * first offers "Reload and keep my edits" there (never a silent overwrite).
 */
export function useSettingsForm<
  T extends object,
  SaveResult = unknown,
  R extends SettingsRevision = number,
>({
  queryKey,
  fetchFn,
  saveFn,
  resolveSavedValues,
  defaultValues,
  successMessage = "Settings saved",
  errorMessage = "Failed to save settings",
  invalidateQueryKeys = [],
  isValid,
  canEdit = true,
  label,
  fields,
}: UseSettingsFormOptions<T, SaveResult, R>) {
  const queryClient = useQueryClient();

  const { data, dataUpdatedAt, error, isError, isLoading } = useQuery({
    queryKey: queryKey as unknown[],
    queryFn: fetchFn,
  });
  const dataUpdateCount =
    queryClient.getQueryState(queryKey as unknown[])?.dataUpdateCount ?? 0;
  const hasLoaded = data !== undefined && !isError;

  const defaultValuesRef = useRef(defaultValues);
  // Route loaders prefetch settings: seed from the cache so navigation never
  // flashes default values.
  const [{ values, savedValues }, setDraft] = useState(() => {
    const cached = queryClient.getQueryData<Partial<T>>(queryKey as unknown[]);
    const initial = cached ? formValues(defaultValues, cached) : defaultValues;
    return { values: initial, savedValues: initial };
  });
  const inSaveBarRef = useRef(false);
  const ignoredReadUpdates = useRef(-1);

  // A refresh may acknowledge normalization even when structural sharing keeps
  // the same data object. Preserve local edits against the prior saved snapshot.
  useEffect(() => {
    if (data && dataUpdateCount > ignoredReadUpdates.current) {
      const nextValues = formValues(defaultValuesRef.current, data);
      setDraft((current) => ({
        values: mergeUneditedFields(current.values, current.savedValues, nextValues),
        savedValues: nextValues,
      }));
    }
  }, [data, dataUpdatedAt, dataUpdateCount]);

  /** Loads the latest saved version under the draft, keeping edited fields. */
  const reloadLatest = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKey as unknown[] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key's content, not its identity
    [queryClient, JSON.stringify(queryKey)],
  );

  const mutation = useMutation({
    // The revision the cached document was loaded at. Cards that share a
    // document read it at save time, so one save bar never conflicts with itself.
    mutationFn: (draft: T) =>
      saveFn(draft, readRevision(queryClient.getQueryData(queryKey as unknown[])) as R),
    onSuccess: async (result, submittedValues) => {
      const savedRevision = readRevision(result);
      const resolved = resolveSavedValues?.(result, submittedValues);
      const canonicalValues = resolved && withoutRevision(resolved);
      if (canonicalValues || savedRevision !== undefined) {
        await queryClient.cancelQueries({ queryKey: queryKey as unknown[] });
        queryClient.setQueryData<Partial<T>>(queryKey as unknown[], (cached) => ({
          ...(canonicalValues ?? cached),
          ...(savedRevision === undefined ? {} : { revision: savedRevision }),
        }) as Partial<T>);
      }
      // Ignore reads published before this write was acknowledged, even if
      // their React effects are still queued.
      ignoredReadUpdates.current =
        queryClient.getQueryState(queryKey as unknown[])?.dataUpdateCount ?? 0;
      const nextValues = canonicalValues ?? submittedValues;
      // Compare with what this request submitted, including edits that revert
      // to the previous saved value while the request is in flight.
      setDraft((current) => ({
        values: mergeUneditedFields(current.values, submittedValues, nextValues),
        savedValues: nextValues,
      }));

      const invalidations = invalidateQueryKeys.map((key) =>
        queryClient.invalidateQueries({ queryKey: key as unknown[] }),
      );
      if (!canonicalValues) {
        invalidations.push(
          queryClient.invalidateQueries({ queryKey: queryKey as unknown[] }),
        );
      }
      await Promise.all(invalidations);
      // A page save bar reports one success for all of its cards.
      if (!inSaveBarRef.current) toast.success(successMessage);
    },
    onError: (error) => {
      // In a save scope the page banner lists the problem instead.
      if (inSaveBarRef.current) return;
      if (readSettingsRevisionConflict(error)) {
        toast.error(translate(saveBarMessages, "conflict"), {
          duration: 10_000,
          action: { label: translate(saveBarMessages, "reloadKeepEdits"), onClick: () => void reloadLatest() },
        });
        return;
      }
      toast.error(error instanceof Error && error.message ? error.message : errorMessage);
    },
  });

  const setValues = useCallback((next: SetStateAction<T>) => {
    setDraft((current) => ({
      ...current,
      values: typeof next === "function"
        ? (next as (previous: T) => T)(current.values)
        : next,
    }));
  }, []);

  const setValue = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, [setValues]);

  const isDirty = JSON.stringify(values) !== JSON.stringify(savedValues);
  const reset = useCallback(() => {
    setDraft((current) => ({ ...current, values: current.savedValues }));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!hasLoaded) {
      toast.error("Reload settings before saving.");
      return;
    }
    await mutation.mutateAsync(values);
  }, [hasLoaded, values, mutation]);

  inSaveBarRef.current = useSaveBar({
    dirty: isDirty,
    saving: mutation.isPending,
    invalid: !canEdit || !hasLoaded || (isValid ? !isValid(values) : false),
    label,
    fields,
    save: () => mutation.mutateAsync(values),
    discard: reset,
    reload: reloadLatest,
  });

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
    refetch: reloadLatest,
  };
}

export function getSettingsLoadErrorMessage(
  error: unknown,
  fallback: string,
): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
