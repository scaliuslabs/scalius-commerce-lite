import { describe, expect, it, vi } from "vitest";
import { runWidgetGeneration } from "./widget-generation-run-stream";

function sse(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("runWidgetGeneration", () => {
  it("parses split semantic SSE events and returns the artifact", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = [
          sse("run.started", { type: "run.started", runId: "run_1", operation: "create" }),
          sse("step.started", { type: "step.started", step: "hydrate_context" }),
          sse("artifact", { type: "artifact", raw: "<htmljs><section>Ok</section></htmljs><css>.x{color:red}</css>" }),
          sse("run.completed", { type: "run.completed", runId: "run_1" }),
        ].join("");
        return new Response(streamFromChunks([body.slice(0, 50), body.slice(50)]), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );

    const seen: string[] = [];
    const result = await runWidgetGeneration(
      {
        promptType: "widget",
        operation: "create",
        userPrompt: "Create a hero",
      },
      { onEvent: (event) => seen.push(event.type) },
    );

    expect(result.raw).toContain("<htmljs>");
    expect(seen).toEqual(["run.started", "step.started", "artifact", "run.completed"]);
  });

  it("throws when the run emits run.failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          streamFromChunks([
            sse("run.failed", {
              type: "run.failed",
              runId: "run_1",
              error: { message: "Provider failed" },
            }),
          ]),
          { status: 200 },
        ),
      ),
    );

    await expect(
      runWidgetGeneration({
        promptType: "widget",
        operation: "create",
        userPrompt: "Create a hero",
      }),
    ).rejects.toThrow("Provider failed");
  });
});
