// The rule of a checker sealed by what it decides on a fixed corpus (the buyer-page chrome's stylesheet
// checker: plugins/buyer-chrome-verdicts.test.ts seals `buyer-chrome-css.verdicts.json` with it), and of
// its version file (`buyer-chrome-css.version.json`). A raised version is the checker's own business:
// what a theme feels is the verdicts. A sample it accepted that it now refuses is a new refusal (after
// the lock a security entry); a sample it refused that it now accepts is growth and names nothing. The
// corpus only grows. What the corpus does not hold, the seal cannot judge: a new refusal of a sheet no
// sample resembles passes it (promise.md says so). Imports nothing (the contract lock's judge loads it).

interface Verdicts {
  version?: number;
  verdicts?: Record<string, string>;
}

const ACCEPTED = "accepted";

export function verdictsBreakingChanges(before: unknown, after: unknown): string[] {
  const was = ((before ?? {}) as Verdicts).verdicts ?? {};
  const now = ((after ?? {}) as Verdicts).verdicts ?? {};
  return Object.entries(was).flatMap(([sample, verdict]) => {
    if (!(sample in now)) return [`verdicts ${JSON.stringify(sample)}: the sample left the corpus.`];
    return verdict === ACCEPTED && now[sample] !== ACCEPTED ? [`verdicts ${JSON.stringify(sample)}: accepted before, refused now (${now[sample]}): a new refusal.`] : [];
  });
}

/** A checker's version only rises, and the file it seals never changes without it. */
export function checkerVersionBreakingChanges(before: unknown, after: unknown): string[] {
  const was = (before ?? {}) as { version?: number; sha256?: string };
  const now = (after ?? {}) as { version?: number; sha256?: string };
  if ((now.version ?? 0) < (was.version ?? 0)) return [`version: went back from ${String(was.version)} to ${String(now.version)}.`];
  if (now.version === was.version && now.sha256 !== was.sha256) return [`version ${String(now.version)}: the checker changed without raising its version.`];
  return [];
}
