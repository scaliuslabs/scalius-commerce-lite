/**
 * One readiness vocabulary for the whole platform.
 *
 * Before this module every surface invented its own shape: `{ ready, issues }`,
 * `{ complete, missing }`, `{ configured, error }`, `{ status, blockers }`.
 * Consumers then had to know which bespoke boolean meant "usable", and adding a
 * new producer meant adding a new one. There is now exactly one answer:
 *
 *   status  "ready" | "incomplete" | "error"
 *   issues  the specific, merchant-actionable reasons it is not ready
 *
 * `incomplete` means a merchant has not finished setup yet (a missing origin, a
 * provider with no credentials). `error` means the platform could not determine
 * setup at all (unreadable credentials, a failed probe) -- a strictly worse
 * state, so merges keep it.
 *
 * Producers may widen the object with typed extras (`{ ...readiness, source }`)
 * but must never rename or drop `status` / `issues`.
 *
 * Dependency-free on purpose: Workers, packages, and the dashboard all import
 * the same helpers.
 */

export type ReadinessStatus = "ready" | "incomplete" | "error";

export interface ReadinessIssue {
  /** Stable machine code, e.g. "missing_shipping_method". Never localized. */
  code: string;
  /** Merchant-facing sentence describing what is wrong. */
  message: string;
  /** Optional merchant-facing sentence describing how to fix it. */
  fix?: string;
}

export interface Readiness {
  status: ReadinessStatus;
  issues: ReadinessIssue[];
}

export const READINESS_STATUSES: readonly ReadinessStatus[] = [
  "ready",
  "incomplete",
  "error",
] as const;

/** Worst-wins ordering: any `error` beats `incomplete`, which beats `ready`. */
const STATUS_SEVERITY: Record<ReadinessStatus, number> = {
  ready: 0,
  incomplete: 1,
  error: 2,
};

export const READINESS_UNKNOWN_ISSUE_CODE = "unknown";

export function isReadinessStatus(value: unknown): value is ReadinessStatus {
  return typeof value === "string"
    && READINESS_STATUSES.includes(value as ReadinessStatus);
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Builds one normalized issue. */
export function readinessIssue(
  code: string,
  message: string,
  fix?: string,
): ReadinessIssue {
  const issue: ReadinessIssue = {
    code: normalizeText(code) || READINESS_UNKNOWN_ISSUE_CODE,
    message: normalizeText(message),
  };
  const normalizedFix = normalizeText(fix);
  if (normalizedFix) issue.fix = normalizedFix;
  return issue;
}

/**
 * Drops empty entries and de-duplicates by `code` + `message` so merged
 * readiness never repeats the same sentence to a merchant.
 */
export function normalizeReadinessIssues(
  issues: readonly ReadinessIssue[] | undefined,
): ReadinessIssue[] {
  const seen = new Set<string>();
  const normalized: ReadinessIssue[] = [];

  for (const candidate of issues ?? []) {
    if (!candidate) continue;
    const issue = readinessIssue(candidate.code, candidate.message, candidate.fix);
    if (!issue.message) continue;
    const key = `${issue.code}|${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(issue);
  }

  return normalized;
}

function build(status: ReadinessStatus, issues: readonly ReadinessIssue[]): Readiness {
  const normalized = normalizeReadinessIssues(issues);
  // A not-ready readiness with no issue would render an empty merchant notice,
  // so degrade to a generic issue instead of showing nothing.
  if (status !== "ready" && normalized.length === 0) {
    return {
      status,
      issues: [readinessIssue(READINESS_UNKNOWN_ISSUE_CODE, "Setup is incomplete.")],
    };
  }
  return { status, issues: normalized };
}

/** The single entry point for producing readiness. */
export const readiness = {
  ready(): Readiness {
    return { status: "ready", issues: [] };
  },
  incomplete(issues: readonly ReadinessIssue[]): Readiness {
    return build("incomplete", issues);
  },
  error(issues: readonly ReadinessIssue[]): Readiness {
    return build("error", issues);
  },
  /** `ready()` when there are no issues, otherwise `incomplete(issues)`. */
  from(issues: readonly ReadinessIssue[] | undefined): Readiness {
    const normalized = normalizeReadinessIssues(issues);
    return normalized.length === 0
      ? { status: "ready", issues: [] }
      : { status: "incomplete", issues: normalized };
  },
} as const;

export function isReady(value: Readiness | null | undefined): boolean {
  return value?.status === "ready";
}

/**
 * Combines readiness from several producers. The worst status wins and every
 * issue is preserved in producer order.
 */
export function mergeReadiness(
  ...parts: readonly (Readiness | null | undefined)[]
): Readiness {
  let status: ReadinessStatus = "ready";
  const issues: ReadinessIssue[] = [];

  for (const part of parts) {
    if (!part) continue;
    const partStatus = isReadinessStatus(part.status) ? part.status : "error";
    if (STATUS_SEVERITY[partStatus] > STATUS_SEVERITY[status]) status = partStatus;
    issues.push(...(part.issues ?? []));
  }

  return status === "ready" ? { status, issues: [] } : build(status, issues);
}

/** Parses untrusted JSON (an API response) back into a Readiness. */
export function normalizeReadiness(value: unknown): Readiness {
  const source = value && typeof value === "object"
    ? (value as { status?: unknown; issues?: unknown })
    : {};
  const issues = normalizeReadinessIssues(
    Array.isArray(source.issues) ? (source.issues as ReadinessIssue[]) : [],
  );
  const status = isReadinessStatus(source.status)
    ? source.status
    : issues.length === 0 ? "ready" : "incomplete";
  return status === "ready" ? { status, issues: [] } : build(status, issues);
}

/** Compact "status:code,code" summary for ops logs. Never merchant copy. */
export function readinessSummary(value: Readiness): string {
  return isReady(value)
    ? "ready"
    : `${value.status}:${value.issues.map((issue) => issue.code).join(",")}`;
}

/** Every merchant-facing message, in order. Convenience for legacy string lists. */
export function readinessMessages(value: Readiness | null | undefined): string[] {
  return (value?.issues ?? []).map((issue) => issue.message);
}
