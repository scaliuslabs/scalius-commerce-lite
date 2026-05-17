export type WidgetGenerationToolName =
  | "load_settings"
  | "hydrate_context"
  | "build_prompt"
  | "plan_artifact"
  | "generate_section"
  | "assemble_artifact"
  | "generate";

export type WidgetGenerationToolEvent =
  | { type: "tool.started"; tool: WidgetGenerationToolName }
  | {
      type: "tool.completed";
      tool: WidgetGenerationToolName;
      elapsedMs: number;
      metadata?: Record<string, unknown>;
    }
  | { type: "artifact.validated"; metadata?: Record<string, unknown> };

type EmitToolEvent = (event: WidgetGenerationToolEvent) => void;
type EmitLegacyStepEvent = (
  event:
    | { type: "step.started"; step: WidgetGenerationToolName }
    | {
        type: "step.completed";
        step: WidgetGenerationToolName;
        elapsedMs: number;
        metadata?: Record<string, unknown>;
      },
) => void;

export function createWidgetGenerationToolRunner(
  emit: EmitToolEvent,
  emitLegacyStep?: EmitLegacyStepEvent,
) {
  return {
    async run<T>(
      tool: WidgetGenerationToolName,
      action: () => Promise<T>,
      metadata?: (value: T) => Record<string, unknown>,
    ): Promise<T> {
      const startedAt = Date.now();
      emit({ type: "tool.started", tool });
      emitLegacyStep?.({ type: "step.started", step: tool });

      const value = await action();
      const completed = {
        elapsedMs: Date.now() - startedAt,
        metadata: metadata?.(value),
      };

      emit({ type: "tool.completed", tool, ...completed });
      emitLegacyStep?.({ type: "step.completed", step: tool, ...completed });
      return value;
    },

    artifactValidated(metadata?: Record<string, unknown>): void {
      emit({ type: "artifact.validated", metadata });
    },
  };
}
