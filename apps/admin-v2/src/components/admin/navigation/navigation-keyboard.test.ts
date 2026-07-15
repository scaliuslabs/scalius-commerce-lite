import type { KeyboardCoordinateGetter } from "@dnd-kit/core";
import { describe, expect, it, vi } from "vitest";
import { createNavigationKeyboardCoordinates } from "./navigation-keyboard";
import type { NavigationItem } from "./types";

function item(id: string, subMenu?: NavigationItem[]): NavigationItem {
  return {
    id,
    target: { type: "label" },
    labelMode: "custom",
    customLabel: id,
    ...(subMenu ? { subMenu } : {}),
  };
}

type GetterArgs = Parameters<KeyboardCoordinateGetter>[1];

function rect(top: number) {
  return {
    top,
    bottom: top + 40,
    left: 20,
    right: 220,
    width: 200,
    height: 40,
  };
}

function args({
  activeId,
  overId,
  rects,
}: {
  activeId: string;
  overId?: string;
  rects: Record<string, ReturnType<typeof rect>>;
}): GetterArgs {
  const activeRect = rects[activeId];
  return {
    active: activeId,
    currentCoordinates: { x: activeRect.left, y: activeRect.top },
    context: {
      collisionRect: activeRect,
      droppableRects: new Map(Object.entries(rects)),
      over: overId
        ? {
            id: overId,
            rect: rects[overId],
            disabled: false,
            data: { current: undefined },
          }
        : null,
    } as GetterArgs["context"],
  };
}

function keyboardEvent(code: "ArrowUp" | "ArrowDown") {
  return {
    code,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

describe("createNavigationKeyboardCoordinates", () => {
  it("places ArrowUp on the previous sibling's before edge", () => {
    const navigation = [item("one"), item("two"), item("three")];
    const getter = createNavigationKeyboardCoordinates(navigation);
    const event = keyboardEvent("ArrowUp");

    const coordinates = getter(event, args({
      activeId: "two",
      rects: { one: rect(0), two: rect(40), three: rect(80) },
    }));

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(coordinates).toEqual({ x: 20, y: -15 });
  });

  it("places ArrowDown on the next sibling's after edge", () => {
    const navigation = [item("one"), item("two"), item("three")];
    const getter = createNavigationKeyboardCoordinates(navigation);

    const coordinates = getter(keyboardEvent("ArrowDown"), args({
      activeId: "two",
      rects: { one: rect(0), two: rect(40), three: rect(80) },
    }));

    expect(coordinates).toEqual({ x: 20, y: 95 });
  });

  it("steps from the current collision target during repeated key presses", () => {
    const navigation = [item("one"), item("two"), item("three")];
    const getter = createNavigationKeyboardCoordinates(navigation);

    const coordinates = getter(keyboardEvent("ArrowUp"), args({
      activeId: "three",
      overId: "two",
      rects: { one: rect(0), two: rect(40), three: rect(80) },
    }));

    expect(coordinates).toEqual({ x: 20, y: -15 });
  });

  it("never crosses into a different parent with the keyboard", () => {
    const navigation = [
      item("parent", [item("child-one"), item("child-two")]),
      item("top-level"),
    ];
    const getter = createNavigationKeyboardCoordinates(navigation);

    expect(getter(keyboardEvent("ArrowDown"), args({
      activeId: "child-two",
      rects: {
        parent: rect(0),
        "child-one": rect(40),
        "child-two": rect(80),
        "top-level": rect(120),
      },
    }))).toBeUndefined();
  });
});
