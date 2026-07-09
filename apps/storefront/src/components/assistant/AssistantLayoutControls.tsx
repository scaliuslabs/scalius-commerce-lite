import {
  Minus,
  PanelLeft,
  PanelRight,
  PanelsTopLeft,
  Plus,
  RotateCcw,
  SlidersHorizontal,
} from "lucide-react";

import type { AssistantPanelMode } from "./assistant-geometry";

type AssistantLayoutControlsProps = {
  mode: AssistantPanelMode;
  onModeChange: (mode: AssistantPanelMode) => void;
  onResize: (widthDelta: number, heightDelta: number) => void;
  onReset: () => void;
};

const modeOptions = [
  { mode: "floating", label: "Float panel", icon: PanelsTopLeft },
  { mode: "dock-left", label: "Dock panel left", icon: PanelLeft },
  { mode: "dock-right", label: "Dock panel right", icon: PanelRight },
] as const;

export function AssistantLayoutControls({
  mode,
  onModeChange,
  onResize,
  onReset,
}: AssistantLayoutControlsProps) {
  return (
    <details className="group/layout relative">
      <summary
        aria-label="Assistant layout controls"
        title="Panel layout"
        className="flex size-9 cursor-pointer list-none items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
      >
        <SlidersHorizontal className="size-4" aria-hidden="true" />
      </summary>
      <div className="absolute right-0 top-[calc(100%+0.5rem)] z-20 w-64 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl">
        <fieldset>
          <legend className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Panel position
          </legend>
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            {modeOptions.map(({ mode: option, label, icon: Icon }) => (
              <button
                key={option}
                type="button"
                aria-label={label}
                aria-pressed={mode === option}
                title={label}
                className="flex min-h-10 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-primary/40 aria-pressed:bg-primary/10 aria-pressed:text-primary"
                onClick={() => onModeChange(option)}
              >
                <Icon className="size-4" aria-hidden="true" />
              </button>
            ))}
          </div>
        </fieldset>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <fieldset>
            <legend className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Width
            </legend>
            <div className="mt-1.5 grid grid-cols-2 overflow-hidden rounded-lg border border-border">
              <button
                type="button"
                aria-label="Make assistant narrower"
                title="Narrower"
                className="flex min-h-9 items-center justify-center border-r border-border bg-background hover:bg-muted focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onResize(-32, 0)}
              >
                <Minus className="size-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="Make assistant wider"
                title="Wider"
                className="flex min-h-9 items-center justify-center bg-background hover:bg-muted focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onResize(32, 0)}
              >
                <Plus className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          </fieldset>

          <fieldset
            disabled={mode !== "floating"}
            className="disabled:opacity-45"
          >
            <legend className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Height
            </legend>
            <div className="mt-1.5 grid grid-cols-2 overflow-hidden rounded-lg border border-border">
              <button
                type="button"
                aria-label="Make assistant shorter"
                title="Shorter"
                className="flex min-h-9 items-center justify-center border-r border-border bg-background hover:bg-muted focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
                onClick={() => onResize(0, -32)}
              >
                <Minus className="size-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="Make assistant taller"
                title="Taller"
                className="flex min-h-9 items-center justify-center bg-background hover:bg-muted focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
                onClick={() => onResize(0, 32)}
              >
                <Plus className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          </fieldset>
        </div>

        <button
          type="button"
          className="mt-3 flex min-h-9 w-full items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onReset}
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Reset layout
        </button>
      </div>
    </details>
  );
}
