// The real API Worker, bundled the way production bundles it, run by Miniflare
// (workerd) for the Workers Free plan budget (free-plan-workerd.test.ts).
//
// Only two things differ from production: D1 calls are forwarded to the test
// process (which holds the migrated, seeded schema in node:sqlite), and every
// entrypoint reports its own CPU. workerd's clock advances while JavaScript
// runs (it only freezes in production), so an invocation's CPU is its wall
// time minus the time spent waiting on the database proxy: the same I/O the
// platform does not charge as CPU.
import type { PasswordHashSpec } from "@scalius/shared/plan-limits";
import ApiWorker from "../worker";

interface HarnessBindings {
  DB_PROXY: { fetch(input: string, init?: RequestInit): Promise<Response> };
}

type Statement = { sql: string; params: unknown[] };

class WaitClock {
  private readonly intervals: Array<[number, number]> = [];
  record(start: number, end: number): void {
    this.intervals.push([start, end]);
  }
  /** Milliseconds during which at least one proxy call was in flight. */
  union(): number {
    const sorted = [...this.intervals].sort((a, b) => a[0] - b[0]);
    let total = 0;
    let current: [number, number] | null = null;
    for (const interval of sorted) {
      if (!current || interval[0] > current[1]) {
        if (current) total += current[1] - current[0];
        current = [interval[0], interval[1]];
      } else if (interval[1] > current[1]) {
        current[1] = interval[1];
      }
    }
    return current ? total + current[1] - current[0] : total;
  }
}

/** A D1Database whose statements run in the test process. */
function remoteD1(proxy: HarnessBindings["DB_PROXY"], clock: WaitClock, calls: { d1: number }): D1Database {
  const send = async (body: unknown): Promise<unknown> => {
    calls.d1 += 1;
    const started = performance.now();
    try {
      const response = await proxy.fetch("http://db/", { method: "POST", body: JSON.stringify(body) });
      if (!response.ok) throw new Error(await response.text());
      return await response.json();
    } finally {
      clock.record(started, performance.now());
    }
  };
  const statement = (sql: string, params: unknown[] = []) => ({
    sql,
    params,
    bind: (...values: unknown[]) => statement(sql, values),
    all: () => send({ op: "all", sql, params }),
    run: () => send({ op: "run", sql, params }),
    raw: () => send({ op: "raw", sql, params }),
    first: async (column?: string) => {
      const result = await send({ op: "all", sql, params }) as { results: Array<Record<string, unknown>> };
      const row = result.results[0];
      return column ? row?.[column] ?? null : row ?? null;
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: (statements: Statement[]) => send({ op: "batch", statements: statements.map(({ sql, params }) => ({ sql, params })) }),
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

interface Timing {
  kind: "fetch" | "queue" | "scheduled";
  cpuMs: number;
  wallMs: number;
  waitMs: number;
  d1Calls: number;
}

let lastTiming: Timing | null = null;

/**
 * What constructing Better Auth costs, in workerd: it is built per request
 * (it closes over the request's bindings), so this is the floor of every
 * request that uses it. The database is a stub: nothing is queried.
 */
async function authConstructCost(bindings: Record<string, unknown>): Promise<Response> {
  const [{ createAuth }, { composeApiRuntimeEnv }] = await Promise.all([
    import("@scalius/core/auth"),
    import("../runtime/runtime-env"),
  ]);
  const stub = {
    prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }), run: async () => ({}), raw: async () => [], first: async () => null }) }),
    batch: async () => [],
  };
  const env = await composeApiRuntimeEnv({
    ...bindings,
    DB: stub,
  } as never);
  const samples: number[] = [];
  const first = performance.now();
  createAuth(env as never);
  const firstMs = performance.now() - first;
  for (let index = 0; index < 10; index += 1) {
    const started = performance.now();
    createAuth(env as never);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return Response.json({ first: firstMs, min: samples[0], median: samples[5], max: samples[9] });
}

/**
 * The CPU of one password hash and one verify at the given cost, in workerd:
 * a request body of `{ spec, runs }`; answers min, median and max milliseconds.
 */
async function passwordCost(request: Request): Promise<Response> {
  const { hashPassword, verifyPassword } = await import("../../../../packages/core/src/auth/password-hash");
  const { spec, runs = 15 } = await request.json() as { spec: PasswordHashSpec; runs?: number };
  const key = btoa("0123456789abcdef0123456789abcdef");
  const password = "Correct-Horse-Battery-9";
  const stored = await hashPassword(password, { spec, pepperKey: key });
  const measure = async (work: () => Promise<unknown>) => {
    await work();
    const samples: number[] = [];
    for (let index = 0; index < runs; index += 1) {
      const started = performance.now();
      await work();
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    return { min: samples[0]!, median: samples[Math.floor(samples.length / 2)]!, max: samples[samples.length - 1]! };
  };
  return Response.json({
    hash: await measure(() => hashPassword(password, { spec, pepperKey: key })),
    verify: await measure(() => verifyPassword(stored, password, { spec, pepperKey: key })),
  });
}

const limiter = { limit: async () => ({ success: true }) };

export default class HarnessWorker extends ApiWorker {
  private async timed<T>(kind: Timing["kind"], work: () => Promise<T>): Promise<T> {
    const clock = new WaitClock();
    const calls = { d1: 0 };
    const tasks: Promise<unknown>[] = [];
    const real = this.ctx;
    const mutable = this as unknown as { env: Record<string, unknown>; ctx: unknown };
    const bindings = this.env as unknown as Record<string, unknown> & HarnessBindings;
    mutable.env = {
      ...bindings,
      DB: remoteD1(bindings.DB_PROXY, clock, calls),
      RL_STRICT: limiter,
      RL_STANDARD: limiter,
      EMAIL: { send: async () => ({ messageId: "harness" }) },
      ASSETS: { fetch: async () => new Response("Not Found", { status: 404 }) },
      CF_VERSION_METADATA: { id: "workerd-harness", tag: "", timestamp: "" },
    };
    mutable.ctx = new Proxy(real, {
      get(target, property) {
        if (property === "waitUntil") {
          return (promise: Promise<unknown>) => {
            tasks.push(Promise.resolve(promise).catch(() => undefined));
            target.waitUntil(promise);
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const started = performance.now();
    try {
      return await work();
    } finally {
      for (let index = 0; index < tasks.length; index += 1) await tasks[index];
      const wallMs = performance.now() - started;
      const waitMs = clock.union();
      lastTiming = { kind, cpuMs: Math.max(0, wallMs - waitMs), wallMs, waitMs, d1Calls: calls.d1 };
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/__harness/last") return Response.json(lastTiming);
    if (pathname === "/__harness/password") return passwordCost(request);
    if (pathname === "/__harness/auth-construct") return authConstructCost(this.env as unknown as Record<string, unknown>);
    return this.timed("fetch", async () => {
      const response = await super.fetch(request);
      // A streamed body is part of the invocation: read it here.
      return new Response(await response.arrayBuffer(), response);
    });
  }

  override async queue(batch: MessageBatch<Record<string, unknown>>): Promise<void> {
    await this.timed("queue", () => super.queue(batch));
  }

  override async scheduled(controller: ScheduledController): Promise<void> {
    await this.timed("scheduled", () => super.scheduled(controller));
  }
}
