import type { StorefrontThemeDocument } from "./document";

/** Stable descriptors let the editor translate the same changes saved in history. */
export interface ThemeDocumentChange {
  kind: "added" | "removed" | "reordered" | "settings";
  page: string;
  sectionId?: string;
  path?: string;
}

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => equal(value, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
  }
  return false;
}

function compareSections(page: string, before: readonly { id: string }[], after: readonly { id: string }[]): ThemeDocumentChange[] {
  const previous = new Map(before.map((section) => [section.id, section]));
  const current = new Map(after.map((section) => [section.id, section]));
  const changes: ThemeDocumentChange[] = [];
  for (const section of before) if (!current.has(section.id)) changes.push({ kind: "removed", page, sectionId: section.id });
  for (const section of after) {
    if (!previous.has(section.id)) changes.push({ kind: "added", page, sectionId: section.id });
    else if (!equal(previous.get(section.id), section)) changes.push({ kind: "settings", page, sectionId: section.id });
  }
  if (!equal(before.filter((section) => current.has(section.id)).map((section) => section.id), after.filter((section) => previous.has(section.id)).map((section) => section.id))) {
    changes.push({ kind: "reordered", page });
  }
  return changes;
}

export function compareThemeDocuments(before: StorefrontThemeDocument, after: StorefrontThemeDocument): ThemeDocumentChange[] {
  const changes = compareSections("home", before.pages.home, after.pages.home);
  for (const key of Object.keys(after) as Array<keyof StorefrontThemeDocument>) {
    if (key !== "pages" && key !== "version" && !equal(before[key], after[key])) changes.push({ kind: "settings", page: "theme", path: key });
  }
  const previous = before.pages as unknown as Record<string, unknown>;
  const current = after.pages as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    if (key === "home") continue;
    if (key === "landing") {
      const a = (previous[key] ?? {}) as Record<string, { title: string; sections: { id: string }[]; overrideCms: boolean }>;
      const b = (current[key] ?? {}) as typeof a;
      for (const slug of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const page = `landing/${slug}`;
        if (!a[slug] || !b[slug]) changes.push({ kind: b[slug] ? "added" : "removed", page });
        else {
          changes.push(...compareSections(page, a[slug].sections, b[slug].sections));
          if (a[slug].title !== b[slug].title || a[slug].overrideCms !== b[slug].overrideCms) changes.push({ kind: "settings", page });
        }
      }
    } else if (current[key] && typeof current[key] === "object" && "blocks" in current[key]) {
      const a = previous[key] as { blocks: { id: string }[] } | undefined;
      const b = current[key] as { blocks: { id: string }[] };
      changes.push(...compareSections(key, a?.blocks ?? [], b.blocks));
    } else if (!equal(previous[key], current[key])) changes.push({ kind: "settings", page: key });
  }
  return changes;
}

export function formatThemeDocumentChanges(changes: readonly ThemeDocumentChange[]): string[] {
  return changes.map((change) => {
    const subject = `${change.page}${change.sectionId ? `: ${change.sectionId}` : ""}`;
    if (change.kind === "settings") return `${subject}: ${change.path ? `${change.path} settings` : "settings"} changed`;
    if (change.kind === "reordered") return `${subject}: sections reordered`;
    return `${subject}: ${change.sectionId ? "section" : "page"} ${change.kind}`;
  });
}
