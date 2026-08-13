import { afterEach, describe, expect, it, vi } from "vitest";

type TestApiWorker = {
  env: Env;
  ctx: ExecutionContext;
  fetch(request: Request): Promise<Response>;
  queue(batch: MessageBatch<Record<string, unknown>>): Promise<void>;
  scheduled(controller: ScheduledController): Promise<void>;
};

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    env: Env;
    ctx: ExecutionContext;

    constructor(ctx?: ExecutionContext, env?: Env) {
      this.env = env ?? ({} as Env);
      this.ctx =
        ctx ??
        ({
          waitUntil: vi.fn(),
          passThroughOnException: vi.fn(),
        } as unknown as ExecutionContext);
    }
  },
}));

describe("API Worker startup boundaries", () => {
  afterEach(() => {
    vi.doUnmock("./app");
    vi.doUnmock("./queue-consumer");
    vi.doUnmock("./scheduled-maintenance");
    vi.doUnmock("./agent-access/oauth");
    vi.doUnmock("./agent-access/artifact-delivery");
    vi.doUnmock("./agent-access/runtime");
    vi.resetModules();
  });

  it("does not load HTTP, queue, or scheduled graphs when the entrypoint module is imported", async () => {
    const loaded = {
      app: false,
      queue: false,
      scheduled: false,
    };

    vi.doMock("./app", () => {
      loaded.app = true;
      return {
        default: {
          fetch: vi.fn(() => new Response("ok")),
        },
      };
    });
    vi.doMock("./queue-consumer", () => {
      loaded.queue = true;
      return {
        handleQueueBatch: vi.fn(),
      };
    });
    vi.doMock("./scheduled-maintenance", () => {
      loaded.scheduled = true;
      return {
        runScheduledMaintenance: vi.fn(),
      };
    });
    await import("./worker");

    expect(loaded).toEqual({
      app: false,
      queue: false,
      scheduled: false,
    });
  });

  it("loads only the HTTP app graph for fetch invocations", async () => {
    const loaded = {
      app: false,
      queue: false,
      scheduled: false,
    };
    const fetch = vi.fn(() => new Response("ok"));

    vi.doMock("./app", () => {
      loaded.app = true;
      return { default: { fetch } };
    });
    vi.doMock("./queue-consumer", () => {
      loaded.queue = true;
      return { handleQueueBatch: vi.fn() };
    });
    vi.doMock("./scheduled-maintenance", () => {
      loaded.scheduled = true;
      return { runScheduledMaintenance: vi.fn() };
    });

    const { default: ApiWorker } = await import("./worker");
    const worker = new ApiWorker(
      undefined as never,
      undefined as never,
    ) as unknown as TestApiWorker;
    const response = await worker.fetch(
      new Request("https://api.example.test/api/v1/health"),
    );

    expect(await response.text()).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(loaded).toEqual({
      app: true,
      queue: false,
      scheduled: false,
    });
  });

  it("loads only the agent runtime graph for exact agent paths", async () => {
    const appFetch = vi.fn(() => new Response("app"));
    const agentFetch = vi.fn(() => new Response("agent"));
    let agentLoaded = false;
    vi.doMock("./app", () => ({ default: { fetch: appFetch } }));
    vi.doMock("./agent-access/runtime", () => {
      agentLoaded = true;
      return {
        shouldHandleAgentAccessRequest: (request: Request) =>
          new URL(request.url).pathname === "/api/v1/mcp/dashboard",
        handleAgentAccessRequest: agentFetch,
      };
    });

    const { default: ApiWorker } = await import("./worker");
    expect(agentLoaded).toBe(false);
    const worker = new ApiWorker(
      undefined as never,
      undefined as never,
    ) as unknown as TestApiWorker;
    const response = await worker.fetch(
      new Request("https://api.example.test/api/v1/mcp/dashboard"),
    );

    expect(await response.text()).toBe("agent");
    expect(agentFetch).toHaveBeenCalledTimes(1);
    expect(appFetch).not.toHaveBeenCalled();
  });

  it("serves only health probes while the database migration freeze is active", async () => {
    const fetch = vi.fn(() => new Response("healthy"));
    vi.doMock("./app", () => ({ default: { fetch } }));
    vi.doMock("./queue-consumer", () => ({ handleQueueBatch: vi.fn() }));
    vi.doMock("./scheduled-maintenance", () => ({ runScheduledMaintenance: vi.fn() }));

    const { default: ApiWorker } = await import("./worker");
    const worker = new ApiWorker(
      undefined as never,
      { DATABASE_MIGRATION_FREEZE: "1" } as Env,
    ) as unknown as TestApiWorker;

    const blocked = await worker.fetch(
      new Request("https://api.example.test/api/v1/products"),
    );
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toMatchObject({
      code: "DATABASE_MIGRATION_IN_PROGRESS",
    });
    expect(fetch).not.toHaveBeenCalled();

    const health = await worker.fetch(
      new Request("https://api.example.test/api/v1/health"),
    );
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("healthy");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("loads only the queue graph for queue invocations", async () => {
    const loaded = {
      app: false,
      queue: false,
      scheduled: false,
    };
    const handleQueueBatch = vi.fn();

    vi.doMock("./app", () => {
      loaded.app = true;
      return { default: { fetch: vi.fn() } };
    });
    vi.doMock("./queue-consumer", () => {
      loaded.queue = true;
      return { handleQueueBatch };
    });
    vi.doMock("./scheduled-maintenance", () => {
      loaded.scheduled = true;
      return { runScheduledMaintenance: vi.fn() };
    });

    const { default: ApiWorker } = await import("./worker");
    const worker = new ApiWorker(
      undefined as never,
      undefined as never,
    ) as unknown as TestApiWorker;
    const batch = { messages: [] } as unknown as MessageBatch<
      Record<string, unknown>
    >;

    await worker.queue(batch);

    expect(handleQueueBatch).toHaveBeenCalledWith(
      batch,
      worker.env,
      worker.ctx,
    );
    expect(loaded).toEqual({
      app: false,
      queue: true,
      scheduled: false,
    });
  });

  it("loads only the scheduled graph for cron invocations", async () => {
    const loaded = {
      app: false,
      queue: false,
      scheduled: false,
    };
    const runScheduledMaintenance = vi.fn();
    const purgeExpiredOAuthData = vi.fn();
    const purgeExpiredAgentArtifacts = vi.fn();

    vi.doMock("./app", () => {
      loaded.app = true;
      return { default: { fetch: vi.fn() } };
    });
    vi.doMock("./queue-consumer", () => {
      loaded.queue = true;
      return { handleQueueBatch: vi.fn() };
    });
    vi.doMock("./scheduled-maintenance", () => {
      loaded.scheduled = true;
      return { runScheduledMaintenance };
    });
    vi.doMock("./agent-access/oauth", () => ({ purgeExpiredOAuthData }));
    vi.doMock("./agent-access/artifact-delivery", () => ({ purgeExpiredAgentArtifacts }));

    const { default: ApiWorker } = await import("./worker");
    const worker = new ApiWorker(
      undefined as never,
      undefined as never,
    ) as unknown as TestApiWorker;
    const controller = {
      cron: "*/15 * * * *",
      scheduledTime: 1783166400000,
      noRetry: vi.fn(),
    } as unknown as ScheduledController;

    await worker.scheduled(controller);

    expect(runScheduledMaintenance).toHaveBeenCalledWith(
      worker.env,
      worker.ctx,
      {
        cron: "*/15 * * * *",
        scheduledTime: 1783166400000,
      },
    );
    expect(purgeExpiredOAuthData).toHaveBeenCalledWith(worker.env);
    expect(purgeExpiredAgentArtifacts).toHaveBeenCalledWith(worker.env);
    expect(loaded).toEqual({
      app: false,
      queue: false,
      scheduled: true,
    });
  });

  it("retries queues and skips cron work while the database migration freeze is active", async () => {
    const handleQueueBatch = vi.fn();
    const runScheduledMaintenance = vi.fn();
    vi.doMock("./app", () => ({ default: { fetch: vi.fn() } }));
    vi.doMock("./queue-consumer", () => ({ handleQueueBatch }));
    vi.doMock("./scheduled-maintenance", () => ({ runScheduledMaintenance }));
    vi.doMock("./agent-access/oauth", () => ({ purgeExpiredOAuthData: vi.fn() }));
    vi.doMock("./agent-access/artifact-delivery", () => ({
      purgeExpiredAgentArtifacts: vi.fn(),
    }));

    const { default: ApiWorker } = await import("./worker");
    const worker = new ApiWorker(
      undefined as never,
      { DATABASE_MIGRATION_FREEZE: "true" } as Env,
    ) as unknown as TestApiWorker;
    const retryAll = vi.fn();
    const batch = {
      messages: [],
      retryAll,
    } as unknown as MessageBatch<Record<string, unknown>>;
    const controller = {
      cron: "*/15 * * * *",
      scheduledTime: 1783166400000,
    } as unknown as ScheduledController;

    await worker.queue(batch);
    await worker.scheduled(controller);

    expect(retryAll).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(handleQueueBatch).not.toHaveBeenCalled();
    expect(runScheduledMaintenance).not.toHaveBeenCalled();
  });
});
