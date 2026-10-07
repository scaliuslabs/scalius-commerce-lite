/**
 * The preview frame's geometry (research P1-P3): the storefront always lays
 * out at a real device width and is scaled to fit the canvas with a CSS
 * transform, so the page never re-lays out when the editor's panels change.
 * The frame's box depends only on the canvas size, the device, the width
 * and the zoom: never on what is selected, hovered or saved.
 */

export type PreviewDevice = "desktop" | "phone";
/** Computer widths (Webflow's large breakpoints); a phone is 390 px. */
export const DESKTOP_WIDTHS = [1280, 1440, 1920] as const;
export type DesktopWidth = (typeof DESKTOP_WIDTHS)[number];
export const PHONE_WIDTH = 390;
/** Space around the frame inside the canvas, each side. */
export const CANVAS_GUTTER = 16;

export type PreviewZoom = "fit" | "actual";

export interface FrameBox {
  /** The storefront's own viewport width (what its media queries see). */
  width: number;
  /** The storefront's own viewport height: the canvas height at this scale. */
  height: number;
  /** The scale the frame draws at (1 at 100%). */
  scale: number;
  /** Where the scaled frame sits in the canvas (the start edge: left in left-to-right). */
  offsetX: number;
  /** The scaled frame's size on screen. */
  screenWidth: number;
  screenHeight: number;
}

/** The frame for a canvas of this size. */
export function frameBox(canvas: { width: number; height: number }, device: PreviewDevice, desktopWidth: DesktopWidth, zoom: PreviewZoom): FrameBox {
  const width = device === "phone" ? PHONE_WIDTH : desktopWidth;
  const room = Math.max(1, canvas.width - 2 * CANVAS_GUTTER);
  const fit = Math.min(1, room / width);
  const scale = zoom === "actual" ? 1 : Math.max(0.1, fit);
  const screenWidth = Math.round(width * scale);
  const screenHeight = Math.max(1, canvas.height - 2 * CANVAS_GUTTER);
  return {
    width,
    height: Math.round(screenHeight / scale),
    scale,
    // Centred while it fits; at 100% wider than the canvas it starts at the gutter and the canvas scrolls sideways.
    offsetX: screenWidth <= room ? Math.round(CANVAS_GUTTER + (room - screenWidth) / 2) : CANVAS_GUTTER,
    screenWidth,
    screenHeight,
  };
}

/** The scale as the top bar says it ("72%"). */
export function scalePercent(scale: number): number {
  return Math.round(scale * 100);
}
