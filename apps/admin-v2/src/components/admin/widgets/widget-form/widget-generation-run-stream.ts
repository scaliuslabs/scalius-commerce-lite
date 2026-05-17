import { fetchWidgetAi } from "./ai-request";
import { readApiErrorMessage } from "./ai-stream";

export type WidgetGenerationRunEvent =
  | { type: "run.started"; runId: string; operation: "create" | "improve" }
  | { type: "step.started"; step: string }
  | { type: "step.completed"; step: string; elapsedMs: number; metadata?: Record<string, unknown> }
  | { type: "tool.started"; tool: string }
  | { type: "tool.completed"; tool: string; elapsedMs: number; metadata?: Record<string, unknown> }
  | { type: "draft.delta"; delta: string }
  | { type: "preview.patch"; html: string; css: string; js?: string; metadata?: Record<string, unknown> }
  | { type: "artifact.validated"; metadata?: Record<string, unknown> }
  | { type: "warning"; warnings: unknown }
  | { type: "artifact"; raw: string; metadata?: Record<string, unknown> }
  | { type: "run.completed"; runId: string; usage?: unknown }
  | { type: "run.failed"; runId: string; error: { message: string } };

export interface WidgetGenerationRunRequest {
  sessionId?: string;
  provider?: string;
  model?: string;
  promptType: "widget" | "landing-page" | "collection";
  operation: "create" | "improve";
  userPrompt: string;
  existingHtml?: string;
  existingCss?: string;
  existingJs?: string;
  targetSection?: number;
  sections?: Array<{ html: string; css: string; js?: string; description?: string }>;
  improvementHistory?: Array<{ section?: number; prompt: string; timestamp: number; modelUsed?: string }>;
  selectedImages?: Array<{
    id?: string;
    url: string;
    filename?: string;
    size?: number;
    createdAt?: string | Date;
    mimeType?: string;
    alt?: string;
    role?: "visual_reference" | "product_media" | "brand_asset" | "merchant_upload";
    label?: string;
  }>;
  productIds?: string[];
  categoryIds?: string[];
  collectionIds?: string[];
  anchorCollectionIds?: string[];
  allCategoriesSelected?: boolean;
}

export interface WidgetGenerationRunResult {
  raw: string;
  events: WidgetGenerationRunEvent[];
}

function previewPatchToRaw(event: Extract<WidgetGenerationRunEvent, { type: "preview.patch" }>): string {
  const js = event.js?.trim();
  return `<htmljs>\n${event.html.trim()}\n</htmljs>\n\n<css>\n${event.css.trim()}\n</css>${js ? `\n\n<js>\n${js}\n</js>` : ""}`;
}

function parseSseEvent(block: string): WidgetGenerationRunEvent | null {
  const dataLines = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) return null;

  try {
    return JSON.parse(dataLines.join("\n")) as WidgetGenerationRunEvent;
  } catch {
    return null;
  }
}

export async function runWidgetGeneration(
  request: WidgetGenerationRunRequest,
  options: {
    signal?: AbortSignal;
    onEvent?: (event: WidgetGenerationRunEvent) => void;
    onDraft?: (raw: string) => void;
  } = {},
): Promise<WidgetGenerationRunResult> {
  const sessionId =
    request.sessionId ||
    `widget-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const response = await fetchWidgetAi("/api/v1/admin/widget-generation-runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...request, sessionId }),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(await readApiErrorMessage(response, `HTTP ${response.status}`));
  }
  if (!response.body) {
    throw new Error("Widget generation returned an empty stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: WidgetGenerationRunEvent[] = [];
  let buffer = "";
  let raw = "";
  let receivedArtifact = false;
  let lastPreviewPatch: Extract<WidgetGenerationRunEvent, { type: "preview.patch" }> | null = null;

  const handleBlock = (block: string) => {
    const event = parseSseEvent(block);
    if (!event) return;
    events.push(event);
    options.onEvent?.(event);
    if (event.type === "draft.delta") {
      raw += event.delta;
      options.onDraft?.(raw);
      return;
    }
    if (event.type === "preview.patch") {
      lastPreviewPatch = event;
    }
    if (event.type === "artifact") {
      raw = event.raw;
      receivedArtifact = true;
    }
    if (event.type === "run.failed") {
      if (lastPreviewPatch) {
        raw = previewPatchToRaw(lastPreviewPatch);
        receivedArtifact = true;
        return;
      }
      throw new Error(event.error.message);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let separatorIndex: number;
    while ((separatorIndex = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      handleBlock(block);
    }
  }

  if (buffer.trim()) {
    handleBlock(buffer);
  }
  if (!receivedArtifact || !raw.trim()) {
    throw new Error("Widget generation finished without an artifact.");
  }

  return { raw, events };
}
