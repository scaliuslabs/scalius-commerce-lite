// The refusal census's rule (refusal-census.test.ts seals `refusal-census.snapshot.json` with it).
// Imports only its siblings: the contract lock's judge loads it from a release tag with plain Node.
import { growOnlyBreaks, refusalListBreaks } from "./rules";

/** A site never leaves the census, gives no new reason, and stays governed by every table it named (each table seals its constants' direction). */
export function refusalCensusBreakingChanges(before: unknown, after: unknown): string[] {
  const was = (before ?? {}) as Record<string, { reasons?: string[]; governedBy?: string[] }>;
  const now = (after ?? {}) as Record<string, { reasons?: string[]; governedBy?: string[] }>;
  return Object.entries(was).flatMap(([name, site]) => {
    const next = now[name];
    if (!next) return [`${name}: the check site left the census.`];
    return [...refusalListBreaks(`${name}.reasons`, site.reasons ?? [], next.reasons ?? []), ...growOnlyBreaks(`${name}.governedBy`, site.governedBy ?? [], next.governedBy ?? [])];
  });
}
