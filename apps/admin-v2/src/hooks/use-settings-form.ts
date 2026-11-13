import { useCallback, useContext, useEffect, useRef, useState, type SetStateAction } from "react";
import { announceSave } from "~/lib/realtime/store";
import { PresenceScopeContext } from "~/lib/realtime/store";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "~/lib/toast";
import { useSaveBar, type SaveBarEntry, type SaveProblem } from "~/components/admin/shared/SaveBar";
import { readSettingsRevisionConflict } from "~/lib/admin-api-error";
import { translate } from "~/i18n";
import { saveBarMessages } from "~/i18n/save-bar";
import { threeWayMerge, type MergeOptions } from "~/lib/three-way-merge";
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
  /**
   * Inside a page save bar: what blocks saving when no field on screen shows
   * it (a default that no longer fits). Save lists each in the banner and
   * moves to its `target`. Any problem blocks saving, like `isValid`.
   */
  problems?: (values: T) => SaveProblem[];
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
 * A card's draft: what the merchant typed (`values`), the latest saved
 * version under it (`savedValues`, what Discard returns to), and the version
 * the edits were made against (`base`, `baseRevision`): the save asserts
 * `baseRevision`, so a refetch never moves the version an edit claims.
 */
export interface SettingsDraft<T, R> {
  values: T;
  savedValues: T;
  savedRevision: R | undefined;
  base: T;
  baseRevision: R | undefined;
}

export function freshDraft<T, R>(values: T, revision: R | undefined): SettingsDraft<T, R> {
  return { values, savedValues: values, savedRevision: revision, base: values, baseRevision: revision };
}

/**
 * A newer saved version arrives under the draft (a realtime refetch, another
 * card's save, a focus refetch). Untouched fields take it. The edits move onto
 * it only when the other save changed none of the fields they changed (the
 * three-way merge a refused save would make anyway); otherwise the edits keep
 * the version they were made against, so the save is refused and the merchant
 * chooses field by field, never a silent overwrite of the other save.
 */
export function rebaseSettingsDraft<T extends object, R>(
  draft: SettingsDraft<T, R>,
  incoming: T,
  revision: R | undefined,
  coupled?: MergeOptions["coupled"],
): SettingsDraft<T, R> {
  if (sameFormValue(draft.values, draft.savedValues)) return freshDraft(incoming, revision);
  const values = mergeUneditedFields(draft.values, draft.savedValues, incoming);
  const clean = threeWayMerge(draft.base, incoming, draft.values, { coupled }).clashes.length === 0;
  return clean
    ? { values, savedValues: incoming, savedRevision: revision, base: incoming, baseRevision: revision }
    : { ...draft, values, savedValues: incoming, savedRevision: revision };
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
  problems,
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
  const [draftState, setDraft] = useState<SettingsDraft<T, R>>(() => {
    const cached = queryClient.getQueryData<Partial<T>>(queryKey as unknown[]);
    return freshDraft(formValues(defaultValues, cached, toDraft), readRevision(cached) as R | undefined);
  });
  const { values, savedValues } = draftState;
  const coupledRef = useRef(coupled);
  coupledRef.current = coupled;
  const inSaveBarRef = useRef(false);
  const ignoredReadUpdates = useRef(-1);

  // A refresh may acknowledge normalization even when structural sharing keeps
  // the same data object. Preserve local edits against the prior saved snapshot.
  useEffect(() => {
    if (data && dataUpdateCount > ignoredReadUpdates.current) {
      const nextValues = formValues(defaultValuesRef.current, data, toDraftRef.current);
      setDraft((current) => rebaseSettingsDraft(current, nextValues, readRevision(data) as R | undefined, coupledRef.current));
    }
  }, [data, dataUpdatedAt, dataUpdateCount]);

  /** Loads the latest saved version under the draft, keeping edited fields. */
  const reloadLatest = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKey as unknown[] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key's content, not its identity
    [queryClient, JSON.stringify(queryKey)],
  );

  // The version the draft was edited from: the merge's base and the revision a save asserts.
  const draftRef = useRef(draftState);
  draftRef.current = draftState;

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
    const values = await mergeSettingsDraft(draftRef.current.base, theirs, draft, { coupled, fields });
    return values ? { values, theirs, revision: revision as R } : null;
  };

  const mutation = useMutation({
    // The revision the edits were made against. Cards that share a document
    // rebase onto the cached one at save time (another card's save just moved
    // it), so one save bar never conflicts with itself; a field both changed
    // keeps the old revision and the server refuses it.
    mutationFn: async (typed: T): Promise<{ result: SaveResult; submitted: T; merged: boolean }> => {
      const cached = queryClient.getQueryData<Partial<T>>(queryKey as unknown[]);
      const pinned = { ...draftRef.current, values: typed };
      const cachedRevision = readRevision(cached) as R | undefined;
      const current = cached && cachedRevision !== undefined && !sameFormValue(cachedRevision, pinned.baseRevision)
        ? rebaseSettingsDraft(pinned, formValues(defaultValuesRef.current, cached, toDraftRef.current), cachedRevision, coupled)
        : pinned;
      const draft = current.values;
      try {
        const result = await saveFn(draft, current.baseRevision as R);
        return { result, submitted: draft, merged: false };
      } catch (error) {
        if (!readSettingsRevisionConflict(error)) throw error;
        const merged = await mergeAfterConflict(draft).catch(() => null);
        if (!merged) throw error;
        // The form shows the merged draft over the other save while it saves.
        setDraft((current) => ({
          values: mergeUneditedFields(current.values, draft, merged.values),
          savedValues: merged.theirs,
          savedRevision: merged.revision,
          base: merged.theirs,
          baseRevision: merged.revision,
        }));
        const result = await saveFn(merged.values, merged.revision);
        return { result, submitted: merged.values, merged: true };
      }
    },
    onSuccess: async ({ result, submitted: submittedValues, merged }) => {
      if (merged) void import("~/lib/merge-document").then(({ mergedMessage }) => toast.success(mergedMessage()));
      if (scopeKey) {
        // The fields this save changed (names, never values), so other viewers can say what merged.
        const base = draftRef.current.base as Record<string, unknown>;
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
      setDraft((current) => {
        const revision = (savedRevision ?? current.savedRevision) as R | undefined;
        return {
          values: mergeUneditedFields(current.values, submittedValues, nextValues),
          savedValues: nextValues,
          savedRevision: revision,
          base: nextValues,
          baseRevision: revision,
        };
      });

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

  // An edit changes the fields it names and keeps the rest of the document: a setter that returns
  // only its own fields (a message editor's `templates`) never drops what the read also carried
  // (its language, the store), which would leave the form unsaved after the edit is undone.
  const setValues = useCallback((next: SetStateAction<T>) => {
    setDraft((current) => {
      const values = { ...current.values, ...(typeof next === "function" ? (next as (previous: T) => T)(current.values) : next) };
      // Back to the saved version: the next edit is made against the latest one.
      return sameFormValue(values, current.savedValues) ? freshDraft(current.savedValues, current.savedRevision) : { ...current, values };
    });
  }, []);

  const setValue = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, [setValues]);

  const isDirty = !sameFormValue(values, savedValues);
  const reset = useCallback(() => {
    setDraft((current) => freshDraft(current.savedValues, current.savedRevision));
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
    problems: canEdit && hasLoaded && problems ? problems(values) : undefined,
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

