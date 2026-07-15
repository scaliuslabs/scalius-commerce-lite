import type { KeyboardCoordinateGetter } from "@dnd-kit/core";
import { findNavigationLocation } from "./navigation-workspace";
import type { NavigationItem } from "./types";

const BEFORE_EDGE = 0.125;
const AFTER_EDGE = 0.875;

function getSiblingItems(
  navigation: NavigationItem[],
  parentId: string | null,
): NavigationItem[] {
  if (!parentId) return navigation;
  return findNavigationLocation(navigation, parentId)?.item.subMenu ?? [];
}

/**
 * Keep keyboard sorting constrained to the active item's sibling list.
 *
 * The generic sortable getter follows the flattened render order. In a tree,
 * that can accidentally cross parent boundaries and may leave the active row
 * colliding with itself. We instead put the active rectangle over the explicit
 * insertion edge of the previous/next sibling. The existing drag intent code
 * then resolves ArrowUp to `before` and ArrowDown to `after` deterministically.
 */
export function createNavigationKeyboardCoordinates(
  navigation: NavigationItem[],
): KeyboardCoordinateGetter {
  return (event, { active, context }) => {
    if (event.code !== "ArrowUp" && event.code !== "ArrowDown") return;
    event.preventDefault();

    const activeLocation = findNavigationLocation(navigation, String(active));
    const activeRect = context.collisionRect;
    if (!activeLocation || !activeRect) return;

    const siblings = getSiblingItems(navigation, activeLocation.parentId);
    const activeIndex = siblings.findIndex((item) => item.id === activeLocation.item.id);
    if (activeIndex < 0) return;

    const overIndex = context.over
      ? siblings.findIndex((item) => item.id === String(context.over?.id))
      : -1;
    const currentIndex = overIndex >= 0 ? overIndex : activeIndex;
    const targetIndex = currentIndex + (event.code === "ArrowUp" ? -1 : 1);
    const target = siblings[targetIndex];
    if (!target) return;

    const targetRect = context.droppableRects.get(target.id);
    if (!targetRect) return;

    const verticalEdge = event.code === "ArrowUp" ? BEFORE_EDGE : AFTER_EDGE;
    return {
      x: targetRect.left + targetRect.width / 2 - activeRect.width / 2,
      y: targetRect.top + targetRect.height * verticalEdge - activeRect.height / 2,
    };
  };
}
