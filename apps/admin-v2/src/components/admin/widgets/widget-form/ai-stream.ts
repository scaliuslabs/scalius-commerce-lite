export interface ChatCompletionLike {
  choices?: Array<{
    message?: { content?: string | null };
    delta?: { content?: string | null };
  }>;
  error?: { message?: string };
}

export async function readApiErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const payload = await response.json() as {
      message?: string;
      error?: { message?: string };
    };
    return payload.error?.message || payload.message || fallback;
  } catch {
    return fallback;
  }
}

export function extractChatCompletionContent(payload: unknown): string {
  const data =
    payload && typeof payload === "object" && "data" in payload
      ? (payload as { data?: unknown }).data
      : payload;

  const completion = data as ChatCompletionLike | undefined;
  const content = completion?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) return content;

  const errorMessage = completion?.error?.message;
  if (typeof errorMessage === "string" && errorMessage.trim()) {
    throw new Error(errorMessage);
  }

  throw new Error("No content in AI response");
}

export async function readChatCompletionStream(response: Response): Promise<string> {
  if (!response.body) {
    throw new Error("AI provider returned an empty stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finalContent: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let lineEnd: number;

    while ((lineEnd = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!line.startsWith("data: ")) continue;

      const chunk = line.slice(6);
      if (chunk === "[DONE]") return finalContent ?? content;

      let parsed: ChatCompletionLike;
      try {
        parsed = JSON.parse(chunk) as ChatCompletionLike;
      } catch {
        continue;
      }

      if (parsed.error?.message) {
        throw new Error(parsed.error.message);
      }

      const delta = parsed.choices?.[0]?.delta?.content;
      if (delta) content += delta;

      const replacement = parsed.choices?.[0]?.message?.content;
      if (typeof replacement === "string") {
        finalContent = replacement;
      }
    }
  }

  return finalContent ?? content;
}
