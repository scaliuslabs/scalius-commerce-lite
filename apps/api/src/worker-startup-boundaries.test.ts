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

// Platform origins normally come from KV/D1; keep the boundary tests hermetic.
vi.mock("@scalius/core/modules/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/platform")>()),
  resolvePlatformConfig: vi.fn(async () => ({
    storefrontUrl: "https://storefront.example.test",
    apiUrl: "https://api.example.test",
    dashboardUrl: "https://dashboard.example.test",
    mediaUrl: "https://cdn.example.test",
    customerAuthCookieDomain: "",
    corsAllowedOrigins: [],
    setupTokenRequired: false,
    identityHandoff: {
      enabled: false,
      issuer: "",
      audience: "",
      jwksUrl: "",
      localLoginDisabled: false,
    },
  })),
}));

const MASTER_SECRET = "worker-boundary-master-secret-with-more-than-32-chars";

/** The only secret Wrangler installs; everything else is derived per invocation. */
function runtimeEnv(overrides: Partial<Env> = {}): Env {
  return { SCALIUS_SECRET: MASTER_SECRET, ...overrides } as Env;
}

/** The env every downstream graph receives: bindings plus derived secrets and origins. */
const composedEnv = expect.objectContaining({
  SCALIUS_SECRET: MASTER_SECRET,
  JWT_SECRET: expect.any(String),
  API_TOKEN: expect.any(String),
  STOREFRONT_URL: "https://storefront.example.test",
});

describe("API Worker startup boundaries", () => {
  afterEach(() => {
    vi.doUnmock("./app");
    vi.doUnmock("@scalius/database/client");
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
    vi.unstubAllGlobals();
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

  it("validates public reads directly under versioned keys without loading other route families", async () => {
    const loaded: Record<RuntimeAppName, boolean> = {
      probe: false,
      public: false,
      admin: false,
      system: false,
      docs: false,
    };
    mockRuntimeApps(loaded);
    const validate = vi.fn(async () => [{ s: 1, floor: 0, pv: null, pr: null, dep: null, seq: null }]);
    vi.doMock("@scalius/database/client", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@scalius/database/client")>()),
      getDb: () => ({ all: validate }),
    }));
    const match = vi.fn(async (_key: string) => undefined);
    const put = vi.fn(async (_key: string, response: Response) => { await response.arrayBuffer(); });
    vi.stubGlobal("caches", { default: { match, put } });
    const waits: Promise<unknown>[] = [];
    const cachedFetch = vi.fn(async (_request: Request) => new Response("cached"));
    const kvGet = vi.fn(async () => "a1b2c3d4e5f60718");
    const { default: ApiWorker } = await import("./worker");
    const worker = new ApiWorker(
      {
        waitUntil: (promise: Promise<unknown>) => { waits.push(promise); },
        exports: { PublicApi: { fetch: cachedFetch } },
      } as unknown as ExecutionContext,
      runtimeEnv({
        CACHE: { get: kvGet } as unknown as KVNamespace,
        CF_VERSION_METADATA: { id: "version-a", tag: "", timestamp: "" },
      }),
    ) as unknown as TestApiWorker;

    await worker.fetch(new Request("https://api.example.test/api/v1/products?page=2&limit=10"));
    // Retired generation hints cannot change a strict cache key.
    await worker.fetch(new Request("https://api.example.test/api/v1/products", {
      headers: { "X-Scalius-Cache-Generation": "feedc0de" },
    }));

    await Promise.all(waits);
    expect(kvGet).not.toHaveBeenCalled();
    expect(cachedFetch).not.toHaveBeenCalled();
    expect(match.mock.calls.map(([key]) => key)).toEqual([
      "https://api.example.test/api/v1/products?limit=10&page=2&__cv=version-a",
      "https://api.example.test/api/v1/products?__cv=version-a",
    ]);
    expect(put).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(loaded).toEqual({ probe: false, public: true, admin: false, system: false, docs: false });
  });

  it("serves public reads uncached when no Worker version is available", async () => {
    const loaded: Record<RuntimeAppName, boolean> = {
      probe: false,
      public: false,
      admin: false,
      system: false,
      docs: false,
    };
    mockRuntimeApps(loaded);
    const cachedFetch = vi.fn();
    const { default: ApiWorker } = await import("./worker");
    const worker = new ApiWorker(
      { waitUntil: vi.fn(), exports: { PublicApi: { fetch: cachedFetch } } } as unknown as ExecutionContext,
      runtimeEnv(),
    ) as unknown as TestApiWorker;

    const response = await worker.fetch(new Request("https://api.example.test/api/v1/products"));

    expect(await response.text()).toBe("public");
    expect(cachedFetch).not.toHaveBeenCalled();
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
      const WorkerClass = workerModule.default;
      const worker = new WorkerClass(
        undefined as never,
        runtimeEnv(),
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
      runtimeEnv(),
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
      runtimeEnv(),
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
      runtimeEnv(),
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
      runtimeEnv(),
    ) as unknown as TestApiWorker;
    const batch = { messages: [] } as unknown as MessageBatch<
      Record<string, unknown>
    >;

    await worker.queue(batch);

    expect(handleQueueBatch).toHaveBeenCalledWith(
      batch,
      composedEnv,
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
      runtimeEnv(),
    ) as unknown as TestApiWorker;
    const controller = {
      cron: "*/15 * * * *",
      scheduledTime: 1783166400000,
      noRetry: vi.fn(),
    } as unknown as ScheduledController;

    await worker.scheduled(controller);

    expect(runScheduledMaintenance).toHaveBeenCalledWith(
      composedEnv,
      worker.ctx,
      {
        cron: "*/15 * * * *",
        scheduledTime: 1783166400000,
      },
    );
    expect(purgeExpiredOAuthData).toHaveBeenCalledWith(composedEnv);
    expect(purgeExpiredAgentArtifacts).toHaveBeenCalledWith(composedEnv);
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

  describe("missing SCALIUS_SECRET", () => {
    it.each([
      ["/api/v1/admin/dashboard/activity"],
      ["/api/v1/auth/me"],
      ["/api/v1/products"],
      ["/api/v1/mcp/dashboard"],
      ["/api/v1/unknown"],
    ])("fails closed with 503 RUNTIME_SECRET_MISSING for %s without loading a route family", async (path) => {
      const loaded: Record<RuntimeAppName, boolean> = {
        probe: false,
        public: false,
        admin: false,
        system: false,
        docs: false,
      };
      mockRuntimeApps(loaded);
      const agentFetch = vi.fn(() => new Response("agent"));
      vi.doMock("./agent-access/runtime", () => ({
        handleAgentAccessRequest: agentFetch,
      }));

      const { default: ApiWorker } = await import("./worker");
      const worker = new ApiWorker(
        undefined as never,
        { CACHE: { get: vi.fn() } } as unknown as Env,
      ) as unknown as TestApiWorker;
      const response = await worker.fetch(new Request(`https://api.example.test${path}`));

      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        code: "RUNTIME_SECRET_MISSING",
        error: expect.stringContaining("SCALIUS_SECRET"),
      });
      expect(agentFetch).not.toHaveBeenCalled();
      expect(loaded).toEqual({
        probe: false,
        public: false,
        admin: false,
        system: false,
        docs: false,
      });
    });

    it("rejects direct strict public reads before loading the public runtime", async () => {
      const loaded: Record<RuntimeAppName, boolean> = {
        probe: false,
        public: false,
        admin: false,
        system: false,
        docs: false,
      };
      mockRuntimeApps(loaded);

      const { default: ApiWorker } = await import("./worker");
      const worker = new ApiWorker(undefined as never, {} as Env) as unknown as TestApiWorker;
      const response = await worker.fetch(new Request("https://api.example.test/api/v1/products"));

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ code: "RUNTIME_SECRET_MISSING" });
      expect(loaded.public).toBe(false);
    });

    it("still answers /api/v1/meta as a probe so automation can read the schema revision", async () => {
      const probeFetch = vi.fn((_request: Request, _env: Env, _ctx: unknown) => new Response("probe"));
      vi.doMock("./runtime/probe-app", () => ({ default: { fetch: probeFetch } }));

      const { default: ApiWorker } = await import("./worker");
      const worker = new ApiWorker(
        undefined as never,
        { SCALIUS_SECRET: "too-short" } as Env,
      ) as unknown as TestApiWorker;

      const meta = await worker.fetch(new Request("https://api.example.test/api/v1/meta"));
      expect(meta.status).toBe(200);
      expect(await meta.text()).toBe("probe");
    });

    it("still answers /api/v1/health and /api/v1/readyz so operators can see the missing secret", async () => {
      const probeFetch = vi.fn((_request: Request, _env: Env, _ctx: unknown) => new Response("probe"));
      vi.doMock("./runtime/probe-app", () => ({ default: { fetch: probeFetch } }));

      const { default: ApiWorker } = await import("./worker");
      const worker = new ApiWorker(
        undefined as never,
        { SCALIUS_SECRET: "too-short" } as Env,
      ) as unknown as TestApiWorker;

      const health = await worker.fetch(new Request("https://api.example.test/api/v1/health"));
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toMatchObject({ status: "ok" });

      const readyz = await worker.fetch(new Request("https://api.example.test/api/v1/readyz"));
      expect(readyz.status).toBe(200);
      expect(await readyz.text()).toBe("probe");
      // The probe receives the composed env (platform origins, no derived secrets)
      // so its runtime_config check can report exactly what is missing.
      expect(probeFetch).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          SCALIUS_SECRET: "too-short",
          STOREFRONT_URL: "https://storefront.example.test",
        }),
        expect.anything(),
      );
      const probeEnv = probeFetch.mock.calls[0]?.[1] as unknown as Record<string, unknown>;
      expect(probeEnv.JWT_SECRET).toBeUndefined();
      expect(probeEnv.API_TOKEN).toBeUndefined();
    });

    it("retries queue batches and skips cron work instead of running without derived secrets", async () => {
      const handleQueueBatch = vi.fn();
      const runScheduledMaintenance = vi.fn();
      vi.doMock("./queue-consumer", () => ({ handleQueueBatch }));
      vi.doMock("./scheduled-maintenance", () => ({ runScheduledMaintenance }));
      vi.doMock("./agent-access/oauth", () => ({ purgeExpiredOAuthData: vi.fn() }));
      vi.doMock("./agent-access/artifact-delivery", () => ({
        purgeExpiredAgentArtifacts: vi.fn(),
      }));

      const { default: ApiWorker } = await import("./worker");
      const worker = new ApiWorker(undefined as never, {} as Env) as unknown as TestApiWorker;
      const retryAll = vi.fn();
      const batch = { messages: [], retryAll } as unknown as MessageBatch<Record<string, unknown>>;

      await worker.queue(batch);
      await worker.scheduled({
        cron: "*/15 * * * *",
        scheduledTime: 1783166400000,
      } as unknown as ScheduledController);

      expect(retryAll).toHaveBeenCalledWith({ delaySeconds: 60 });
      expect(handleQueueBatch).not.toHaveBeenCalled();
      expect(runScheduledMaintenance).not.toHaveBeenCalled();
    });
  });
});

describe("API Worker trusted front proxy", () => {
  afterEach(() => {
    vi.doUnmock("./runtime/public-app");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function fetchThroughWorker(request: Request) {
    const seen: Request[] = [];
    vi.doMock("./runtime/public-app", () => ({
      default: {
        fetch: vi.fn((incoming: Request) => {
          seen.push(incoming);
          return new Response("public");
        }),
      },
    }));
    const { default: ApiWorker } = await import("./worker");
    const worker = new ApiWorker(undefined as never, runtimeEnv()) as unknown as TestApiWorker;
    const response = await worker.fetch(request);
    return { response, seen };
  }

  it("rewrites the URL and client IP only for a validly signed proxy request", async () => {
    const { deriveRuntimeSecret, RUNTIME_SECRET_PURPOSES } = await import("@scalius/shared/runtime-secrets");
    const { signFrontProxyRequest, FRONT_PROXY_SIGNATURE_HEADER } = await import("@scalius/shared/trusted-front-proxy");
    const secret = await deriveRuntimeSecret(MASTER_SECRET, RUNTIME_SECRET_PURPOSES.FRONT_PROXY_SECRET);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signFrontProxyRequest(secret, {
      timestamp,
      proto: "https",
      host: "shop.example.com",
      pathname: "/api/v1/hero",
      clientIp: "203.0.113.9",
    });

    // POST keeps the request out of the public cache lane so the route family sees it.
    const signed = await fetchThroughWorker(new Request("https://internal.workers.dev/api/v1/hero", {
      method: "POST",
      headers: {
        "X-Forwarded-Host": "shop.example.com",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-For": "203.0.113.9",
        "cf-connecting-ip": "10.0.0.1",
        [FRONT_PROXY_SIGNATURE_HEADER]: signature,
      },
    }));
    expect(signed.response.status).toBe(200);
    expect(signed.seen[0]?.url).toBe("https://shop.example.com/api/v1/hero");
    expect(signed.seen[0]?.headers.get("cf-connecting-ip")).toBe("203.0.113.9");
    expect(signed.seen[0]?.headers.has(FRONT_PROXY_SIGNATURE_HEADER)).toBe(false);

    const forged = await fetchThroughWorker(new Request("https://internal.workers.dev/api/v1/hero", {
      method: "POST",
      headers: {
        "X-Forwarded-Host": "evil.example.com",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-For": "203.0.113.9",
        "cf-connecting-ip": "10.0.0.1",
        [FRONT_PROXY_SIGNATURE_HEADER]: signature,
      },
    }));
    expect(forged.seen[0]?.url).toBe("https://internal.workers.dev/api/v1/hero");
    expect(forged.seen[0]?.headers.get("cf-connecting-ip")).toBe("10.0.0.1");

    const unsigned = await fetchThroughWorker(new Request("https://internal.workers.dev/api/v1/hero", {
      method: "POST",
      headers: { "X-Forwarded-Host": "evil.example.com", "X-Forwarded-Proto": "https" },
    }));
    expect(unsigned.seen[0]?.url).toBe("https://internal.workers.dev/api/v1/hero");
  });
});
