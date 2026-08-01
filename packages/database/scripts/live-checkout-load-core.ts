export interface LoadTimingSample {
  serviceMs: number;
  scheduledMs: number;
  startLagMs: number;
}

export interface LoadTimingSummary {
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface OpenArrivalResult<T> {
  value: T;
  timing: LoadTimingSample;
}

export interface OpenArrivalOptions<T> {
  count: number;
  ratePerSecond: number;
  execute: (sequence: number) => Promise<T>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  leadInMs?: number;
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

function requirePositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number.`);
  }
}

export function assertDisposableLoadTarget(
  apiUrl: string,
  acknowledgedHostname: string,
): URL {
  const parsed = new URL(apiUrl);
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:") {
    throw new Error("Live checkout load targets must use HTTPS.");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname && parsed.pathname !== "/")
  ) {
    throw new Error("Live checkout load target must be a credential-free origin URL.");
  }
  if (!hostname.includes("loadtest")) {
    throw new Error("Live checkout load target hostname must contain loadtest.");
  }
  if (acknowledgedHostname.trim().toLowerCase() !== hostname) {
    throw new Error("LOADTEST_ACK_HOST must exactly match the target hostname.");
  }
  return new URL(parsed.origin);
}

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new Error("Percentile fraction must be between zero and one.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.max(0, index)]!;
}

export function summarizeTimings(
  samples: readonly LoadTimingSample[],
  field: keyof LoadTimingSample,
): LoadTimingSummary {
  const values = samples.map((sample) => sample[field]);
  if (values.length === 0) {
    return { min: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  }
  return {
    min: Math.round(Math.min(...values)),
    p50: Math.round(percentile(values, 0.5)),
    p95: Math.round(percentile(values, 0.95)),
    p99: Math.round(percentile(values, 0.99)),
    max: Math.round(Math.max(...values)),
  };
}

export async function runOpenArrival<T>(
  options: OpenArrivalOptions<T>,
): Promise<readonly OpenArrivalResult<T>[]> {
  requirePositiveInteger(options.count, "Open-arrival count");
  requirePositiveFinite(options.ratePerSecond, "Open-arrival rate");
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>(
    (resolve) => setTimeout(resolve, milliseconds),
  ));
  const leadInMs = options.leadInMs ?? 100;
  if (!Number.isFinite(leadInMs) || leadInMs < 0) {
    throw new Error("Open-arrival lead-in must be a non-negative finite number.");
  }

  const intervalMs = 1_000 / options.ratePerSecond;
  const origin = now() + leadInMs;
  return Promise.all(Array.from({ length: options.count }, async (_, index) => {
    const scheduledAt = origin + index * intervalMs;
    const delay = scheduledAt - now();
    if (delay > 0) await sleep(delay);
    const startedAt = now();
    const value = await options.execute(index + 1);
    const completedAt = now();
    return {
      value,
      timing: {
        serviceMs: completedAt - startedAt,
        scheduledMs: completedAt - scheduledAt,
        startLagMs: Math.max(0, startedAt - scheduledAt),
      },
    };
  }));
}
