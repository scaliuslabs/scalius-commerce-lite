export const HEADER_COMPACT_ENTER_PX = 96;
export const HEADER_COMPACT_EXIT_PX = 16;

export function shouldUseCompactHeader(
  scrollY: number,
  isCompact: boolean,
): boolean {
  const position = Math.max(0, scrollY);
  return isCompact
    ? position > HEADER_COMPACT_EXIT_PX
    : position >= HEADER_COMPACT_ENTER_PX;
}
