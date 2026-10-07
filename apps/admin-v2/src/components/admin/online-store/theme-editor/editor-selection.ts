/**
 * What the editor selects, as one string: a section's id, a fixed part's
 * mark (`header`, `product-main`, `module-reviews`), or a block of a
 * section (`<section id>/<list path>/<index>`, a slide or a question). The
 * same id names the tree's row; the preview outlines the section a block is
 * in, or the part itself.
 */

export interface BlockRef {
  sectionId: string;
  path: string;
  index: number;
}

const BLOCK = /^([a-z0-9][a-z0-9_-]{0,39})\/([a-zA-Z.]+)\/(\d{1,3})$/;

export function blockId(ref: BlockRef): string {
  return `${ref.sectionId}/${ref.path}/${ref.index}`;
}

export function parseBlockId(id: string | null): BlockRef | null {
  const match = id ? BLOCK.exec(id) : null;
  return match ? { sectionId: match[1]!, path: match[2]!, index: Number(match[3]) } : null;
}

/** The preview mark a selection outlines: the block's section, else the id itself. */
export function selectionMark(id: string | null): string | null {
  if (!id) return null;
  return parseBlockId(id)?.sectionId ?? id;
}
