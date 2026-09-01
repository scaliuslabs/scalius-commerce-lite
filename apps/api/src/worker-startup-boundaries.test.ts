import { afterEach, describe, expect, it, vi } from "vitest";

type TestApiWorker = {
  env: Env;
  ctx: ExecutionContext;
  fetch(request: Request): Promise<Response>;
  queue(batch: MessageBatch<Record<string, unknown>>): Promise<void>;
  scheduled(controller: ScheduledController): Promise<void>;
};

type RuntimeAppName = "probe" | "public" | "admin" | "system" | "docs";
type ExpectedRuntime = RuntimeAppName | "direct";

function mockRuntimeApps(loaded: Record<RuntimeAppName, boolean>) {
  for (const name of Object.keys(loaded) as RuntimeAppName[]) {
    vi.doMock(`./runtime/${name}-app`, () => {
      loaded[name] = true;
      return {
        default: {
          fetch: vi.fn(() => new Response(name)),
        },
      };
    });
  }
}

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
    vi.doUnmock("./runtime/probe-app");
    vi.doUnmock("./runtime/public-app");
    vi.doUnmock("./runtime/admin-app");
    vi.doUnmock("./runtime/system-app");
    vi.doUnmock("./runtime/docs-app");
    vi.doUnmock("./queue-consumer");
    vi.doUnmock("./scheduled-maintenance");
    vi.doUnmock("./agent-access/oauth");
    vi.doUnmock("./agent-access/artifact-delivery");
    vi.doUnmock("./agent-access/runtime");
    vi.resetModules();
  });

  it("does not load HTTP route families, queue, or scheduled graphs when the entrypoint module is imported", async () => {
    const loaded = {
      probe: false,
      public: false,
      admin: false,
      system: false,
      docs: false,
      queue: false,
      scheduled: false,
    };

    mockRuntimeApps(loaded);
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
      probe: false,
      public: false,
      admin: false,
      system: false,
      docs: false,
      queue: false,
      scheduled: false,
    });
  });

  it("skips public cache purges only when the runtime exposes no cache", async () => {
    const { PublicApi } = await import("./worker");
    const withoutCache = new PublicApi(
      undefined as never,
      undefined as never,
    );

    await expect(withoutCache.purgeGroups(["products"])).resolves.toBeUndefined();

    const purge = vi.fn().mockResolvedValue({
      success: false,
      errors: [{ code: 1001, message: "failed" }],
    });
    const withCache = new PublicApi(
      { cache: { purge } } as unknown as ExecutionContext,
      undefined as never,
    );

    await expect(withCache.purgeGroups(["products"])).rejects.toThrow(
      "Public API cache purge failed (1001)",
    );
    expect(purge).toHaveBeenCalledWith({ tags: ["products"] });
  });

  it.each([
    ["direct", "/api/v1/health"],
    ["probe", "/api/v1/readyz"],
    ["admin", "/api/v1/admin/dashboard/activity"],
    ["system", "/api/v1/auth/me"],
    ["system", "/api/v1/payment/stripe/session"],
    ["system", "/api/v1/webhooks/stripe"],
    ["docs", "/api/v1/openapi.json"],
    ["docs", "/api/v1/docs"],
    ["public", "/api/v1/seo"],
    ["public", "/api/v1/products"],
  ] satisfies ReadonlyArray<readonly [ExpectedRuntime, string]>)(
    "loads only the %s HTTP route family for %s",
    async (expected, path) => {
      const loaded: Record<RuntimeAppName, boolean> = {
        probe: false,
        public: false,
        admin: false,
        system: false,
        docs: false,
      };
      mockRuntimeApps(loaded);
      vi.doMock("./app", () => ({
        default: { fetch: vi.fn(() => new Response("legacy")) },
      }));

      const workerModule = await import("./worker");
      const WorkerClass = expected === "public"
        ? workerModule.PublicApi
        : workerModule.default;
      const worker = new WorkerClass(
        undefined as never,
        undefined as never,
      ) as unknown as TestApiWorker;
      const response = await worker.fetch(
        new Request(`https://api.example.test${path}`),
      );

      if (expected === "direct") {
        expect(await response.json()).toMatchObject({ status: "ok" });
      } else {
        expect(await response.text()).toBe(expected);
      }
      expect(loaded).toEqual({
        probe: expected === "probe",
        public: expected === "public",
        admin: expected === "admin",
        system: expected === "system",
        docs: expected === "docs",
      });
    },
  );

  it("loads only the agent runtime graph for exact agent paths", async () => {
    const agentFetch = vi.fn(() => new Response("agent"));
    const loaded: Record<RuntimeAppName, boolean> = {
      probe: false,
      public: false,
      admin: false,
      system: false,
      docs: false,
    };
    let agentLoaded = false;
    mockRuntimeApps(loaded);
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
    expect(loaded).toEqual({
      probe: false,
      public: false,
      admin: false,
      system: false,
      docs: false,
    });
  });

  it("returns unknown paths without initializing an HTTP route family", async () => {
    const loaded: Record<RuntimeAppName, boolean> = {
      probe: false,
      public: false,
      admin: false,
      system: false,
      docs: false,
    };
    mockRuntimeApps(loaded);

    const { default: ApiWorker } = await import("./worker");
    const worker = new ApiWorker(
      undefined as never,
      undefined as never,
    ) as unknown as TestApiWorker;
    const response = await worker.fetch(
      new Request("https://api.example.test/api/v1/unknown"),
    );

    expect(response.status).toBe(404);
    expect(loaded).toEqual({
      probe: false,
      public: false,
      admin: false,
      system: false,
      docs: false,
    });
  });

  it("evaluates a requested route family once per isolate", async () => {
    let adminLoads = 0;
    vi.doMock("./runtime/admin-app", () => {
      adminLoads += 1;
      return { default: { fetch: vi.fn(() => new Response("admin")) } };
    });

    const { default: ApiWorker } = await import("./worker");
    const worker = new ApiWorker(
      undefined as never,
      undefined as never,
    ) as unknown as TestApiWorker;
    await worker.fetch(new Request("https://api.example.test/api/v1/admin/dashboard/activity"));
    await worker.fetch(new Request("https://api.example.test/api/v1/admin/orders"));

    expect(adminLoads).toBe(1);
  });

  it("serves only health probes while the database migration freeze is active", async () => {
    const fetch = vi.fn(() => new Response("healthy"));
    vi.doMock("./runtime/probe-app", () => ({ default: { fetch } }));
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
    expect(await health.json()).toMatchObject({ status: "ok" });
    expect(fetch).not.toHaveBeenCalled();
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
