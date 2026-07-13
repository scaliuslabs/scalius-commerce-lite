interface UpdateMediaSelectionOptions {
  selectedIds: readonly string[];
  visibleIds: readonly string[];
  targetId: string;
  anchorId: string | null;
  extendRange: boolean;
}

interface MediaSelectionUpdate {
  selectedIds: string[];
  anchorId: string;
}

/**
 * Applies the library's shared selection contract.
 *
 * A normal activation toggles one asset and establishes the range anchor.
 * Shift-activation adds the inclusive visible range without discarding any
 * individually selected assets. Hidden or stale IDs can never enter a range.
 */
export function updateMediaSelection({
  selectedIds,
  visibleIds,
  targetId,
  anchorId,
  extendRange,
}: UpdateMediaSelectionOptions): MediaSelectionUpdate {
  const targetIndex = visibleIds.indexOf(targetId);
  if (targetIndex === -1) {
    return { selectedIds: [...selectedIds], anchorId: targetId };
  }

  const anchorIndex = anchorId ? visibleIds.indexOf(anchorId) : -1;
  if (extendRange && anchorIndex !== -1) {
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    const next = new Set(selectedIds);
    for (const id of visibleIds.slice(start, end + 1)) next.add(id);
    return { selectedIds: [...next], anchorId: anchorId as string };
  }

  const next = selectedIds.includes(targetId)
    ? selectedIds.filter((id) => id !== targetId)
    : [...selectedIds, targetId];

  return { selectedIds: next, anchorId: targetId };
}

export function selectAllVisibleMedia(visibleIds: readonly string[]): string[] {
  return [...new Set(visibleIds)];
}

/** Resolves selection IDs against ordered sources, keeping the first fresh row. */
export function resolveSelectedMedia<T extends { id: string }>(
  selectedIds: readonly string[],
  ...sources: (readonly T[])[]
): T[] {
  const byId = new Map<string, T>();
  for (const source of sources) {
    for (const item of source) {
      if (!byId.has(item.id)) byId.set(item.id, item);
    }
  }
  return selectedIds.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
}
