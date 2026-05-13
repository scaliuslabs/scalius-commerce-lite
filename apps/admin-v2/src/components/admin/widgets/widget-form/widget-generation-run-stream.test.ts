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

  it("accumulates draft deltas before the final artifact", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = [
          sse("run.started", { type: "run.started", runId: "run_1", operation: "create" }),
          sse("draft.delta", { type: "draft.delta", delta: "<htmljs>" }),
          sse("draft.delta", { type: "draft.delta", delta: "<section>Draft</section>" }),
          sse("preview.patch", {
            type: "preview.patch",
            html: "<section>Scaffold</section>",
            css: ".x{color:red}",
            metadata: { draft: true },
          }),
          sse("artifact", {
            type: "artifact",
            raw: "<htmljs><section>Final</section></htmljs><css>.x{color:red}</css>",
          }),
          sse("run.completed", { type: "run.completed", runId: "run_1" }),
        ].join("");
        return new Response(streamFromChunks([body]), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );

    const drafts: string[] = [];
    const events: string[] = [];
    const result = await runWidgetGeneration(
      {
        promptType: "widget",
        operation: "create",
        userPrompt: "Create a hero",
      },
      {
        onDraft: (raw) => drafts.push(raw),
        onEvent: (event) => events.push(event.type),
      },
    );

    expect(drafts).toEqual(["<htmljs>", "<htmljs><section>Draft</section>"]);
    expect(events).toContain("preview.patch");
    expect(result.raw).toContain("Final");
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

  it("does not treat streamed draft text as a completed artifact", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          streamFromChunks([
            [
              sse("run.started", { type: "run.started", runId: "run_1", operation: "create" }),
              sse("draft.delta", { type: "draft.delta", delta: "<htmljs><section>Draft only</section></htmljs>" }),
              sse("run.completed", { type: "run.completed", runId: "run_1" }),
            ].join(""),
          ]),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      ),
    );

    await expect(
      runWidgetGeneration({
        promptType: "widget",
        operation: "create",
        userPrompt: "Create a hero",
      }),
    ).rejects.toThrow("Widget generation finished without an artifact.");
  });
});
