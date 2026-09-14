import { describe, expect, it } from "vitest";
import {
  isReadinessStatus,
  isReady,
  mergeReadiness,
  normalizeReadiness,
  normalizeReadinessIssues,
  readiness,
  readinessIssue,
  readinessMessages,
  readinessSummary,
  READINESS_STATUSES,
} from "./readiness";

describe("readiness vocabulary", () => {
  it("exposes exactly the three platform statuses", () => {
    expect([...READINESS_STATUSES]).toEqual(["ready", "incomplete", "error"]);
    expect(isReadinessStatus("ready")).toBe(true);
    expect(isReadinessStatus("complete")).toBe(false);
    expect(isReadinessStatus(undefined)).toBe(false);
  });

  it("builds a ready readiness with no issues", () => {
    expect(readiness.ready()).toEqual({ status: "ready", issues: [] });
    expect(isReady(readiness.ready())).toBe(true);
    expect(isReady(null)).toBe(false);
  });

  it("keeps issue code, message, and optional fix", () => {
    expect(readinessIssue("missing_sender", "  Sender email is required.  ", " Add it in Settings. "))
      .toEqual({
        code: "missing_sender",
        message: "Sender email is required.",
        fix: "Add it in Settings.",
      });
    expect(readinessIssue("", "Something broke")).toEqual({
      code: "unknown",
      message: "Something broke",
    });
    expect(readinessIssue("code", "message")).not.toHaveProperty("fix");
  });
});

describe("readiness issue normalization", () => {
  it("drops empty messages and de-duplicates identical issues", () => {
    expect(normalizeReadinessIssues([
      { code: "a", message: "First" },
      { code: "a", message: "First" },
      { code: "b", message: "   " },
      { code: "c", message: "Second" },
    ])).toEqual([
      { code: "a", message: "First" },
      { code: "c", message: "Second" },
    ]);
  });

  it("keeps same-message issues that carry different codes", () => {
    expect(normalizeReadinessIssues([
      { code: "a", message: "Same" },
      { code: "b", message: "Same" },
    ])).toHaveLength(2);
  });

  it("tolerates undefined and holes", () => {
    expect(normalizeReadinessIssues(undefined)).toEqual([]);
  });
});

describe("readiness producers", () => {
  it("marks incomplete setup with its issues", () => {
    const value = readiness.incomplete([
      readinessIssue("missing_shipping_method", "Add an active shipping method."),
    ]);
    expect(value.status).toBe("incomplete");
    expect(readinessMessages(value)).toEqual(["Add an active shipping method."]);
  });

  it("never returns a not-ready readiness without a visible issue", () => {
    expect(readiness.incomplete([])).toEqual({
      status: "incomplete",
      issues: [{ code: "unknown", message: "Setup is incomplete." }],
    });
    expect(readiness.error([]).status).toBe("error");
  });

  it("from() collapses an empty issue list to ready", () => {
    expect(readiness.from([])).toEqual({ status: "ready", issues: [] });
    expect(readiness.from(undefined)).toEqual({ status: "ready", issues: [] });
    expect(readiness.from([readinessIssue("x", "Broken")]).status).toBe("incomplete");
  });
});

describe("mergeReadiness", () => {
  it("is ready only when every part is ready", () => {
    expect(mergeReadiness(readiness.ready(), readiness.ready()))
      .toEqual({ status: "ready", issues: [] });
    expect(mergeReadiness()).toEqual({ status: "ready", issues: [] });
    expect(mergeReadiness(undefined, null)).toEqual({ status: "ready", issues: [] });
  });

  it("keeps the worst status and every issue in producer order", () => {
    const merged = mergeReadiness(
      readiness.incomplete([readinessIssue("a", "First")]),
      readiness.ready(),
      readiness.error([readinessIssue("b", "Second")]),
    );

    expect(merged.status).toBe("error");
    expect(readinessMessages(merged)).toEqual(["First", "Second"]);
  });

  it("does not repeat the same issue reported by two producers", () => {
    const duplicate = readiness.incomplete([readinessIssue("a", "First")]);
    expect(mergeReadiness(duplicate, duplicate).issues).toHaveLength(1);
  });

  it("treats an unknown status as an error", () => {
    const merged = mergeReadiness(
      { status: "bogus" as never, issues: [readinessIssue("a", "First")] },
    );
    expect(merged.status).toBe("error");
  });
});

describe("normalizeReadiness", () => {
  it("parses a well-formed API payload", () => {
    expect(normalizeReadiness({
      status: "incomplete",
      issues: [{ code: "a", message: "First", fix: "Do the thing" }],
    })).toEqual({
      status: "incomplete",
      issues: [{ code: "a", message: "First", fix: "Do the thing" }],
    });
  });

  it("falls back to ready/incomplete when status is missing or unknown", () => {
    expect(normalizeReadiness({ issues: [] })).toEqual({ status: "ready", issues: [] });
    expect(normalizeReadiness({ issues: [{ code: "a", message: "First" }] }).status)
      .toBe("incomplete");
    expect(normalizeReadiness(null)).toEqual({ status: "ready", issues: [] });
    expect(normalizeReadiness("nonsense")).toEqual({ status: "ready", issues: [] });
  });
});

describe("readinessSummary", () => {
  it("is a compact code list for ops logs, never merchant copy", () => {
    expect(readinessSummary(readiness.ready())).toBe("ready");
    expect(readinessSummary(readiness.incomplete([
      readinessIssue("missing_api_url", "Set the API URL."),
      readinessIssue("missing_media_url", "Set the media URL."),
    ]))).toBe("incomplete:missing_api_url,missing_media_url");
  });
});
