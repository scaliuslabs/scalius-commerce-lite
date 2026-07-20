export type DropdownPlacement = "above" | "below";

export interface DropdownLayout {
  placement: DropdownPlacement;
  maxHeight: number;
}

export function resolveDropdownLayout(
  triggerTop: number,
  triggerBottom: number,
  viewportHeight: number,
  desiredHeight = 288,
): DropdownLayout {
  const edgeGap = 12;
  const spaceAbove = Math.max(0, triggerTop - edgeGap);
  const spaceBelow = Math.max(0, viewportHeight - triggerBottom - edgeGap);
  const placement: DropdownPlacement =
    spaceBelow >= Math.min(180, desiredHeight) || spaceBelow >= spaceAbove
      ? "below"
      : "above";
  const available = placement === "below" ? spaceBelow : spaceAbove;

  return {
    placement,
    maxHeight: Math.max(120, Math.min(desiredHeight, available)),
  };
}

export function nextDropdownOptionIndex(
  currentIndex: number,
  optionCount: number,
  key: "ArrowDown" | "ArrowUp" | "Home" | "End",
): number {
  if (optionCount <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return optionCount - 1;
  if (key === "ArrowUp") {
    return currentIndex <= 0 ? optionCount - 1 : currentIndex - 1;
  }
  return currentIndex < 0 || currentIndex >= optionCount - 1
    ? 0
    : currentIndex + 1;
}

export function resolveDropdownScrollTop(
  currentScrollTop: number,
  listTop: number,
  listBottom: number,
  optionTop: number,
  optionBottom: number,
): number {
  if (optionTop < listTop) {
    return Math.max(0, currentScrollTop - (listTop - optionTop));
  }
  if (optionBottom > listBottom) {
    return currentScrollTop + (optionBottom - listBottom);
  }
  return currentScrollTop;
}
