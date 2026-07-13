import { assertDemoApplyAuthorization } from "./authorization.mjs";
import { createResumeRecord, restoreResumeState } from "./resume-journal.mjs";

export class DemoApplyPhaseBlockedError extends Error {
  constructor(phase) {
    super(`Demo apply is blocked at ${phase.name}: ${phase.blockers.map((item) => item.message).join(" ")}`);
    this.name = "DemoApplyPhaseBlockedError";
    this.phase = phase.name;
    this.blockers = phase.blockers;
  }
}

export async function runDemoApplyLifecycle({
  manifest,
  publicationIntent = {},
  authorization,
  lifecycle,
  resumeRecords = [],
  bindCommand = (command) => command,
  executeCommand,
  recordResume = async () => undefined,
  now = () => new Date(),
}) {
  if (typeof executeCommand !== "function") throw new Error("Demo lifecycle apply needs a command executor.");
  const intentFingerprint = assertDemoApplyAuthorization({ authorization, manifest, publicationIntent });
  const resume = restoreResumeState(resumeRecords, intentFingerprint);
  const outputs = new Map(resume.authorities);
  const phases = [];

  for (const phase of lifecycle.phases) {
    if (phase.state === "blocked") throw new DemoApplyPhaseBlockedError(phase);
    if (phase.state === "skipped") {
      phases.push({ name: phase.name, state: "skipped", outcomes: [] });
      continue;
    }
    const outcomes = [];
    for (const intent of phase.commands) {
      const command = await bindCommand(intent, { outputs, completed: resume.completed, phase: phase.name });
      const outcome = await executeCommand(command, { phase: phase.name });
      if (!["applied", "already_applied", "adopted_after_ambiguous_response"].includes(outcome.status)) {
        throw new Error(`Demo apply stopped after ${intent.logicalKey} returned ${outcome.status}.`);
      }
      if (!outcome.authority) throw new Error(`Demo apply outcome for ${intent.logicalKey} did not return resumable authority.`);
      outputs.set(intent.logicalKey, outcome.authority);
      resume.completed.add(intent.logicalKey);
      const record = createResumeRecord({
        intentFingerprint,
        phase: phase.name,
        logicalKey: intent.logicalKey,
        status: outcome.status,
        authority: outcome.authority,
        timestamp: now().toISOString(),
      });
      await recordResume(record);
      outcomes.push(outcome);
    }
    phases.push({ name: phase.name, state: "complete", outcomes });
  }

  return { status: "complete", intentFingerprint, phases, authorities: outputs };
}
