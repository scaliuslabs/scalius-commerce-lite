import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

type TestWidgetDesignAgent = {
  env: Env;
  state: {
    phase: string;
    lastEventAt: number | null;
  };
  sqlCalls: Array<{
    strings: string[];
    values: unknown[];
  }>;
  onRequest(request: Request): Promise<Response>;
};

vi.mock("agents", () => ({
  Agent: class {
    env: Env;
    initialState: unknown;
    sqlCalls: Array<{
      strings: string[];
      values: unknown[];
    }> = [];
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

    sql(strings: TemplateStringsArray, ...values: unknown[]): never[] {
      this.sqlCalls.push({ strings: Array.from(strings), values });
      return [];
    }
  },
}));

describe("WidgetDesignAgent startup boundaries", () => {
  afterEach(() => {
    vi.doUnmock("./widget-design-agent-runtime");
    vi.resetModules();
  });

  it("keeps the Durable Object shell free of static AI runtime imports", () => {
    const agentDir = dirname(fileURLToPath(import.meta.url));
    const shellSource = readFileSync(
      join(agentDir, "widget-design-agent.ts"),
      "utf8",
    );

    expect(shellSource).toContain(
      'await import("./widget-design-agent-runtime")',
    );
    expect(shellSource).not.toContain("@scalius/core/modules/ai");
    expect(shellSource).not.toContain("../routes/admin/ai");
    expect(shellSource).not.toContain(
      "../routes/admin/widget-generation-tools",
    );
  });

  it("does not load the widget runtime when the shell module is imported", async () => {
    let runtimeLoaded = false;
    vi.doMock("./widget-design-agent-runtime", () => {
      runtimeLoaded = true;
      return {
        streamWidgetDesignAgentRun: vi.fn(),
      };
    });

    await import("./widget-design-agent");

    expect(runtimeLoaded).toBe(false);
  });

  it("serves status locally without loading the widget runtime", async () => {
    let runtimeLoaded = false;
    vi.doMock("./widget-design-agent-runtime", () => {
      runtimeLoaded = true;
      return {
        streamWidgetDesignAgentRun: vi.fn(),
      };
    });

    const { WidgetDesignAgent } = await import("./widget-design-agent");
    const agent = new WidgetDesignAgent(
      undefined as never,
      {} as Env,
    ) as unknown as TestWidgetDesignAgent;
    const response = await agent.onRequest(
      new Request("https://agent.example.test/status"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        phase: "idle",
        artifactReady: false,
        error: null,
      },
    });
    expect(runtimeLoaded).toBe(false);
  });

  it("loads and delegates to the widget runtime only for POST generation requests", async () => {
    let receivedHost:
      | {
          env: Env;
          request: Request;
          recordEvent: (runId: string, event: { type: string }) => void;
          updateRunState: (next: { phase: "loading" }) => void;
        }
      | undefined;
    const streamWidgetDesignAgentRun = vi.fn(
      (host: NonNullable<typeof receivedHost>) => {
        receivedHost = host;
        return new Response("delegated");
      },
    );
    vi.doMock("./widget-design-agent-runtime", () => ({
      streamWidgetDesignAgentRun,
    }));

    const env = { CREDENTIAL_ENCRYPTION_KEY: "test" } as unknown as Env;
    const request = new Request("https://agent.example.test/run", {
      method: "POST",
      body: JSON.stringify({ userPrompt: "Build a product hero" }),
    });
    const { WidgetDesignAgent } = await import("./widget-design-agent");
    const agent = new WidgetDesignAgent(
      undefined as never,
      env,
    ) as unknown as TestWidgetDesignAgent;
    const response = await agent.onRequest(request);

    expect(await response.text()).toBe("delegated");
    expect(streamWidgetDesignAgentRun).toHaveBeenCalledTimes(1);
    expect(receivedHost?.env).toBe(env);
    expect(receivedHost?.request).toBe(request);

    receivedHost?.updateRunState({ phase: "loading" });
    expect(agent.state.phase).toBe("loading");
    expect(agent.state.lastEventAt).toEqual(expect.any(Number));

    receivedHost?.recordEvent("run_1", { type: "run.started" });
    expect(agent.sqlCalls).toHaveLength(3);

    receivedHost?.recordEvent("run_1", { type: "draft.delta" });
    expect(agent.sqlCalls).toHaveLength(3);
  });
});
