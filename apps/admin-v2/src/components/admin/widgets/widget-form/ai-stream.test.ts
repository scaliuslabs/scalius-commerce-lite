import { describe, expect, it } from "vitest";
import { extractChatCompletionContent, readChatCompletionStream } from "./ai-stream";

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
  );
}

describe("readChatCompletionStream", () => {
  it("returns the final validated message when the stream provides one", async () => {
    const response = streamResponse([
      'data: {"choices":[{"delta":{"content":"broken raw"}}]}\n\n',
      'data: {"choices":[{"message":{"content":"<htmljs>final</htmljs>\\n<css></css>"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    await expect(readChatCompletionStream(response)).resolves.toBe(
      "<htmljs>final</htmljs>\n<css></css>",
    );
  });

  it("throws provider errors from streamed error chunks", async () => {
    const response = streamResponse([
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      'data: {"error":{"message":"provider failed"}}\n\n',
      "data: [DONE]\n\n",
    ]);

    await expect(readChatCompletionStream(response)).rejects.toThrow("provider failed");
  });
});

describe("extractChatCompletionContent", () => {
  it("unwraps API success envelopes around chat completion responses", () => {
    const content = extractChatCompletionContent({
      success: true,
      data: {
        choices: [
          {
            message: { content: "<htmljs>final</htmljs>\n<css></css>" },
          },
        ],
      },
    });

    expect(content).toBe("<htmljs>final</htmljs>\n<css></css>");
  });
});
