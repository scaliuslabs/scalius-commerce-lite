import type { DraftVariant, VariantGroup } from "./option-matrix-editor-model";

export type VariantEntry =
  | { kind: "group"; group: VariantGroup; open: boolean; repeated?: boolean }
  | { kind: "row"; variant: DraftVariant; depth: 0 | 1; group: VariantGroup | null };

/** The table's lines in order: each group row, then its variants while it is open. */
export function variantEntries(
  rows: readonly DraftVariant[],
  groups: readonly VariantGroup[] | null,
  isOpen: (valueId: string) => boolean,
): VariantEntry[] {
  if (!groups) return rows.map((variant) => ({ kind: "row", variant, depth: 0, group: null }));
  return groups.flatMap((group): VariantEntry[] => {
    const open = isOpen(group.valueId);
    const children = open ? group.variants.map((variant) => ({ kind: "row" as const, variant, depth: 1 as const, group })) : [];
    return [{ kind: "group", group, open }, ...children];
  });
}

export function pageCount(entries: number, size: number): number {
  return Math.max(1, Math.ceil(entries / size));
}

/** One page, plus a repeated group header when it starts inside a group. */
export function pageEntries(entries: readonly VariantEntry[], page: number, size: number): VariantEntry[] {
  const slice = entries.slice(page * size, page * size + size);
  const first = slice[0];
  return first?.kind === "row" && first.group ? [{ kind: "group", group: first.group, open: true, repeated: true }, ...slice] : slice;
}

/** The page that shows a variant, or -1 when no shown entry is that variant. */
export function pageOfVariant(entries: readonly VariantEntry[], variantId: string, size: number): number {
  const index = entries.findIndex((entry) => entry.kind === "row" && entry.variant.id === variantId);
  return index < 0 ? -1 : Math.floor(index / size);
}
