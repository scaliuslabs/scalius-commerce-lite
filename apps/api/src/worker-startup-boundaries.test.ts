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

vi.mock("agents", () => ({
  Agent: class {
    env: Env;
    initialState: unknown;
    private currentState: unknown;

    constructor(_ctx?: unknown, env?: Env) {
      this.env = env ?? ({} as Env);
    }

    get state(): unknown {
      return this.currentState ?? this.initialState;
    }

    setState(next: unknown): void {
      this.currentState = next;
    }

    sql(): never[] {
      return [];
    }
  },
}));

describe("API Worker startup boundaries", () => {
  afterEach(() => {
    vi.doUnmock("./app");
    vi.doUnmock("./agents/widget-design-agent-runtime");
    vi.doUnmock("./queue-consumer");
    vi.doUnmock("./scheduled-maintenance");
    vi.resetModules();
  });

  it("does not load HTTP, queue, or scheduled graphs when the entrypoint module is imported", async () => {
    const loaded = {
      app: false,
      queue: false,
      scheduled: false,
      widgetRuntime: false,
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
    vi.doMock("./agents/widget-design-agent-runtime", () => {
      loaded.widgetRuntime = true;
      return {
        streamWidgetDesignAgentRun: vi.fn(),
      };
    });

    await import("./worker");

    expect(loaded).toEqual({
      app: false,
      queue: false,
      scheduled: false,
      widgetRuntime: false,
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
    expect(loaded).toEqual({
      app: false,
      queue: false,
      scheduled: true,
    });
  });
});
