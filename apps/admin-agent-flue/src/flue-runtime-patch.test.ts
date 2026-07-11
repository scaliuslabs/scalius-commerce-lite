import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const PATCH_PATH = new URL(
  "../../../patches/@flue__runtime@1.0.0-beta.9.patch",
  import.meta.url,
).pathname;
const RUNTIME_DIST_PATH = new URL(
  "../node_modules/@flue/runtime/dist/",
  import.meta.url,
).pathname;

describe("Flue runtime settlement patch", () => {
  it("canonically settles direct and dispatched continuations through the same outbox", async () => {
    const [patch, conversationRuntime, sqlStore, coordinator] =
      await Promise.all([
        readFile(PATCH_PATH, "utf8"),
        readFile(
          `${RUNTIME_DIST_PATH}conversation-stream-store-Bitz7UoW.mjs`,
          "utf8",
        ),
        readFile(`${RUNTIME_DIST_PATH}sql-run-store-DRLffFXh.mjs`, "utf8"),
        readFile(`${RUNTIME_DIST_PATH}internal.mjs`, "utf8"),
      ]);

    expect(patch).toContain(
      "kind IN ('direct', 'dispatch') AND status = 'running'",
    );
    expect(patch).toContain(
      "kind IN ('direct', 'dispatch') AND status = 'terminalizing'",
    );
    expect(patch).toContain(
      'await settleSubmission(submissions, attempt, ctx, "completed"',
    );
    expect(patch).toContain(
      'if (!await settleSubmission(submissions, attempt, ctx, "completed"',
    );
    expect(patch).toContain(
      'await settleSubmission(submissions, attempt, ctx, "failed"',
    );
    expect(patch).toContain(
      'settleSubmission(submissions, attempt, ctx, "aborted"',
    );
    expect(patch).toContain(
      "-async function settleDirectSubmission(submissions, attempt, ctx, outcome, result, error, conversationWriter)",
    );
    expect(patch).toContain(
      "+async function settleSubmission(submissions, attempt, ctx, outcome, result, error, conversationWriter)",
    );

    // A crash between reserving and appending must be replayable for dispatches
    // too; Node recovery may no longer discard their pending obligations.
    expect(patch).toContain(
      '-\t\t\tif (!submission || submission.kind !== "direct") continue;',
    );
    expect(patch).toContain('+\t\t\tif (!submission) continue;');
    expect(
      patch.match(
        /settlement\.record\.outcome === "aborted"\) (?:this\.)?observers\.fail\(settlement\.submissionId, new SubmissionAbortedError\(\)\)/g,
      ),
    ).toHaveLength(2);

    // Guard the exact regression: no terminal path may fall back to changing
    // only the operational SQL row for dispatch submissions.
    expect(patch).not.toMatch(
      /submission\.kind === "direct" \? await settleSubmission[\s\S]{0,240}: await submissions\.(?:complete|fail)Submission/,
    );

    // Prove pnpm materialized the policy, including the existing two-phase
    // outbox body that is intentionally not duplicated in the compact patch.
    expect(conversationRuntime).toContain("async function settleSubmission(");
    expect(conversationRuntime).toContain(
      'if (!await settleSubmission(submissions, attempt, ctx, "completed"',
    );
    expect(conversationRuntime).toContain(
      "const obligation = pending ?? await submissions.reserveSubmissionSettlement",
    );
    expect(conversationRuntime).toContain(
      "return submissions.finalizeSubmissionSettlement(attempt, eventKey)",
    );
    expect(conversationRuntime).not.toContain(
      'submission.kind === "direct" ? await settleDirectSubmission',
    );
    expect(sqlStore).toContain("kind IN ('direct', 'dispatch')");
    expect(coordinator).not.toContain(
      'if (!submission || submission.kind !== "direct") continue;',
    );
    expect(
      coordinator.match(
        /settlement\.record\.outcome === "aborted"\) (?:this\.)?observers\.fail\(settlement\.submissionId, new SubmissionAbortedError\(\)\)/g,
      ),
    ).toHaveLength(2);
  });
});
