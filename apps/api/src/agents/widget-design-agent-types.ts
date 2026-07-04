export type WidgetDesignAgentState = {
  runId: string | null;
  phase:
    | "idle"
    | "loading"
    | "hydrating"
    | "prompting"
    | "generating"
    | "validated"
    | "complete"
    | "failed";
  operation: "create" | "improve" | null;
  promptType: "widget" | "landing-page" | "collection";
  provider: "openrouter" | "openai" | "gemini" | "cloudflare" | null;
  model: string | null;
  lastEventAt: number | null;
  artifactReady: boolean;
  error: string | null;
};

export type WidgetDesignAgentStoredEvent = {
  type: string;
};

export function createInitialWidgetDesignAgentState(): WidgetDesignAgentState {
  return {
    runId: null,
    phase: "idle",
    operation: null,
    promptType: "widget",
    provider: null,
    model: null,
    lastEventAt: null,
    artifactReady: false,
    error: null,
  };
}
