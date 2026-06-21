import type { CSSProperties } from "react";
import { CSS } from "@dnd-kit/utilities";

type SortableTransform = Parameters<typeof CSS.Transform.toString>[0];

function hasDefinedStyleValue(style?: CSSProperties): boolean {
  if (!style) return false;
  return Object.values(style).some((value) => value !== undefined && value !== null);
}

export function getSortableStyle(
  transform: SortableTransform,
  transition?: string | null,
  extraStyle?: CSSProperties,
): CSSProperties | undefined {
  const transformValue = CSS.Transform.toString(transform) || undefined;
  const transitionValue = transition || undefined;

  if (!transformValue && !transitionValue && !hasDefinedStyleValue(extraStyle)) {
    return undefined;
  }

  return {
    ...extraStyle,
    transform: transformValue,
    transition: transitionValue,
  };
}
