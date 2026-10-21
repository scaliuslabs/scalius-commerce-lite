// App background jobs (packages/plugin-sdk/docs/apps.md, "Background jobs"): long
// admin actions an app starts with `ctx.jobs.start(name, { input, key })`.
// The platform keeps the job as a durable row and runs it one step at a
// time, right after the request that started it and on the every-minute
// drain: each step is one invocation of the app's `jobs[name]` handler,
// bounded like any run (platform calls and wall time per run), and gets the
// state the step before returned. Pure and free of zod: the sandbox wrapper
// bundles it. Part of the versioned plugin API.

/** Jobs one manifest declares at most. */
export const PLUGIN_JOBS_MAX = 10;
/** A job's `input` (JSON) at most. */
export const PLUGIN_JOB_INPUT_MAX_BYTES = 16 * 1024;
/** The state a step hands to the next (JSON) at most. */
export const PLUGIN_JOB_STATE_MAX_BYTES = 64 * 1024;
/** A step's `message` at most (plain text, never buyer contact data). */
export const PLUGIN_JOB_MESSAGE_MAX = 200;
/** Jobs `ctx.jobs.list` answers at most. */
export const PLUGIN_JOB_LIST_MAX = 20;
/** Attempts of one step (a throw, a timeout or an invalid answer) before the job fails. */
export const PLUGIN_JOB_STEP_ATTEMPTS = 3;
/** `key` makes a start idempotent: 8 to 200 printable characters. */
export const PLUGIN_JOB_KEY_PATTERN = /^[\x20-\x7E]{8,200}$/u;
/** The job id `ctx.jobs.start` answers. */
export const PLUGIN_JOB_ID_PATTERN = /^job_[a-f0-9]{32}$/u;

/** Why a job failed (`error`): a lower_snake code, never app text. */
export const PLUGIN_JOB_ERROR_CODES = [
  /** `ctx.jobs.cancel`. */
  "cancelled",
  /** A step threw or timed out on every attempt. */
  "job_step_failed",
  /** A step answered something that is not a step result on every attempt. */
  "job_invalid_step",
  /** The app was turned off, failed or uninstalled while the job ran. */
  "app_inactive",
  /** The app's update no longer declares the job. */
  "job_undeclared",
] as const;
export type PluginJobErrorCode = (typeof PLUGIN_JOB_ERROR_CODES)[number];

export type PluginJobStatus = "running" | "done" | "failed";

/** What a job's handler gets on every step. */
export interface PluginJobStepInput {
  id: string;
  name: string;
  /** What `ctx.jobs.start` was given (null without one). */
  input: unknown;
  /** What the step before returned as `state` (null on the first step). */
  state: unknown;
  /** The step's number, from 1. A step repeated after a crash has the same number. */
  step: number;
}

/**
 * What a step answers. `state` is handed to the next step (left out: the
 * state stays as it was); `progress` is shown to staff (`ui.progress`,
 * `ctx.jobs.get`); `done: true` finishes the job. Without `done` the job
 * runs another step.
 */
export interface PluginJobStepResult {
  state?: unknown;
  progress?: { done: number; total: number };
  message?: string | null;
  done?: boolean;
}

/** A job as `ctx.jobs.get` and `list` answer it. */
export interface PluginJob {
  id: string;
  name: string;
  status: PluginJobStatus;
  progress: { done: number; total: number };
  message: string | null;
  /** A `PluginJobErrorCode` when the job failed; null otherwise. */
  error: string | null;
  /** Steps committed so far. */
  steps: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The UTF-8 size of a JSON value, or null when it is not JSON. */
export function pluginJsonBytes(value: unknown): number | null {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? null : new TextEncoder().encode(text).byteLength;
  } catch {
    return null;
  }
}

/**
 * A step's answer as the platform reads it (`state` normalized to JSON, or
 * `keep` when the answer leaves it out; progress whole numbers with
 * `0 <= done <= total`), or why it is not one.
 */
export function checkPluginJobStep(value: unknown):
  | { ok: true; value: { state: { keep: true } | { keep: false; value: unknown }; progress: { done: number; total: number } | null; message: string | null; done: boolean } }
  | { ok: false; message: string } {
  const answer = value === undefined || value === null ? {} : value;
  if (!isRecord(answer)) return { ok: false, message: "A step answers { state?, progress?, message?, done? }." };
  const extra = Object.keys(answer).find((key) => key !== "state" && key !== "progress" && key !== "message" && key !== "done");
  if (extra) return { ok: false, message: `Unknown step result property "${extra}".` };
  if (answer.done !== undefined && typeof answer.done !== "boolean") return { ok: false, message: "done is true or false." };
  let progress: { done: number; total: number } | null = null;
  if (answer.progress !== undefined) {
    const raw = answer.progress;
    const whole = (number: unknown): number is number => typeof number === "number" && Number.isSafeInteger(number) && number >= 0;
    if (!isRecord(raw) || !whole(raw.done) || !whole(raw.total) || raw.done > raw.total || Object.keys(raw).some((key) => key !== "done" && key !== "total")) {
      return { ok: false, message: "progress is { done, total }: whole numbers, done at most total." };
    }
    progress = { done: raw.done, total: raw.total };
  }
  let message: string | null = null;
  if (answer.message !== undefined && answer.message !== null) {
    if (typeof answer.message !== "string" || answer.message.length > PLUGIN_JOB_MESSAGE_MAX) {
      return { ok: false, message: `message is text of at most ${PLUGIN_JOB_MESSAGE_MAX} characters.` };
    }
    message = answer.message;
  }
  let state: { keep: true } | { keep: false; value: unknown } = { keep: true };
  if (answer.state !== undefined) {
    const bytes = pluginJsonBytes(answer.state);
    if (bytes === null) return { ok: false, message: "state must be JSON." };
    if (bytes > PLUGIN_JOB_STATE_MAX_BYTES) return { ok: false, message: `state is at most ${PLUGIN_JOB_STATE_MAX_BYTES / 1024} KiB of JSON.` };
    state = { keep: false, value: JSON.parse(JSON.stringify(answer.state)) as unknown };
  }
  return { ok: true, value: { state, progress, message, done: answer.done === true } };
}
