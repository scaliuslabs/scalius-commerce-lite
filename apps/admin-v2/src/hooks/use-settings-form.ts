import { useCallback, useContext, useEffect, useRef, useState, type SetStateAction } from "react";
import { announceSave } from "~/lib/realtime/store";
import { PresenceScopeContext } from "~/lib/realtime/store";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "~/lib/toast";
import { useSaveBar, type SaveBarEntry } from "~/components/admin/shared/SaveBar";
import { readSettingsRevisionConflict } from "~/lib/admin-api-error";
import { translate } from "~/i18n";
import { saveBarMessages } from "~/i18n/save-bar";
import type { MergeOptions } from "~/lib/three-way-merge";
import { sameFormValue } from "~/lib/form-values";

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
  /** The same editable representation for cached reads, reloads and save acknowledgements. */
  toDraft?: (values: T) => T;
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
  /**
   * Fields that must keep one person's version together when two saves meet
   * (lib/three-way-merge.ts). Every other field merges on its own.
   */
  coupled?: MergeOptions["coupled"];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/**
 * The incoming saved version with the draft's edits on top. Nested settings
 * objects merge field by field: an edit to `a.x` keeps the other save's
 * `a.y`, never the whole `a` the draft started from (which a later save would
 * write back over theirs).
 */
export function mergeUneditedFields<T extends object>(current: T, baseline: T, incoming: T): T {
  const next = { ...incoming };
  for (const key of Object.keys({ ...baseline, ...current }) as (keyof T)[]) {
    const mine: unknown = current[key];
    const base: unknown = baseline[key];
    if (sameFormValue(mine, base)) continue;
    const theirs: unknown = incoming[key];
    next[key] = (isPlainObject(mine) && isPlainObject(base) && isPlainObject(theirs)
      ? mergeUneditedFields(mine, base, theirs)
      : mine) as T[keyof T];
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

function formValues<T extends object>(defaults: T, data: Partial<T> | undefined, toDraft?: (values: T) => T): T {
  const values = { ...defaults, ...withoutRevision(data ?? {}) } as T;
  return toDraft ? toDraft(values) : values;
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
  toDraft,
  successMessage = translate(saveBarMessages, "saved"),
  errorMessage = translate(saveBarMessages, "notSavedOne"),
  invalidateQueryKeys = [],
  isValid,
  canEdit = true,
  label,
  fields,
  coupled,
}: UseSettingsFormOptions<T, SaveResult, R>) {
  const queryClient = useQueryClient();
  // The settings page's presence key: a save here tells its other viewers at once.
  const scopeKey = useContext(PresenceScopeContext);

  const { data, dataUpdatedAt, error, isError, isLoading } = useQuery({
    queryKey: queryKey as unknown[],
    queryFn: fetchFn,
  });
  const dataUpdateCount =
    queryClient.getQueryState(queryKey as unknown[])?.dataUpdateCount ?? 0;
  const hasLoaded = data !== undefined && !isError;

  const defaultValuesRef = useRef(defaultValues);
  const toDraftRef = useRef(toDraft);
  toDraftRef.current = toDraft;
  // Route loaders prefetch settings: seed from the cache so navigation never
  // flashes default values.
  const [{ values, savedValues }, setDraft] = useState(() => {
    const cached = queryClient.getQueryData<Partial<T>>(queryKey as unknown[]);
    const initial = formValues(defaultValues, cached, toDraft);
    return { values: initial, savedValues: initial };
  });
  const inSaveBarRef = useRef(false);
  const ignoredReadUpdates = useRef(-1);

  // A refresh may acknowledge normalization even when structural sharing keeps
  // the same data object. Preserve local edits against the prior saved snapshot.
  useEffect(() => {
    if (data && dataUpdateCount > ignoredReadUpdates.current) {
      const nextValues = formValues(defaultValuesRef.current, data, toDraftRef.current);
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

  // The saved version the draft was edited from: the merge's base.
  const savedValuesRef = useRef(savedValues);
  savedValuesRef.current = savedValues;

  /**
   * Someone saved first: merge their version with this draft field by field
   * (lib/three-way-merge.ts) and save again at their revision. A field both
   * changed differently goes to the merchant's side-by-side choice; cancelling
   * it keeps the draft unsaved and the conflict on screen.
   */
  const mergeAfterConflict = async (draft: T): Promise<{ values: T; theirs: T; revision: R } | null> => {
    const latest = await fetchFn();
    const revision = readRevision(latest);
    if (revision === undefined) return null;
    const theirs = formValues(defaultValuesRef.current, latest, toDraftRef.current);
    const { mergeSettingsDraft } = await import("~/lib/merge-document");
    const values = await mergeSettingsDraft(savedValuesRef.current, theirs, draft, { coupled, fields });
    return values ? { values, theirs, revision: revision as R } : null;
  };

  const mutation = useMutation({
    // The revision the cached document was loaded at. Cards that share a
    // document read it at save time, so one save bar never conflicts with itself.
    mutationFn: async (draft: T): Promise<{ result: SaveResult; submitted: T; merged: boolean }> => {
      try {
        const result = await saveFn(draft, readRevision(queryClient.getQueryData(queryKey as unknown[])) as R);
        return { result, submitted: draft, merged: false };
      } catch (error) {
        if (!readSettingsRevisionConflict(error)) throw error;
        const merged = await mergeAfterConflict(draft).catch(() => null);
        if (!merged) throw error;
        // The form shows the merged draft over the other save while it saves.
        setDraft((current) => ({
          values: mergeUneditedFields(current.values, draft, merged.values),
          savedValues: merged.theirs,
        }));
        const result = await saveFn(merged.values, merged.revision);
        return { result, submitted: merged.values, merged: true };
      }
    },
    onSuccess: async ({ result, submitted: submittedValues, merged }) => {
      if (merged) void import("~/lib/merge-document").then(({ mergedMessage }) => toast.success(mergedMessage()));
      if (scopeKey) {
        // The fields this save changed (names, never values), so other viewers can say what merged.
        const base = savedValuesRef.current as Record<string, unknown>;
        const sent = submittedValues as Record<string, unknown>;
        announceSave(scopeKey, null, Object.keys(sent).filter((key) => !sameFormValue(sent[key], base[key])));
      }
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
      const nextValues = formValues(defaultValuesRef.current, canonicalValues ?? submittedValues, toDraftRef.current);
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

  const isDirty = !sameFormValue(values, savedValues);
  const reset = useCallback(() => {
    setDraft((current) => ({ ...current, values: current.savedValues }));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!hasLoaded) {
      toast.error(translate(saveBarMessages, "reloadFirst"));
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
    save: () => mutation.mutateAsync(values).then(({ result }) => result),
    discard: reset,
    reload: reloadLatest,
  });

  return {
    values,
    savedValues,
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

