/**
 * Why the camera did not start, as a person can act on it. The browser's own
 * error (`NotAllowedError`, `NotFoundError`, …), which html5-qrcode wraps in
 * text such as "Error getting userMedia, error = NotSupportedError: Not
 * supported", is never shown.
 */
export type CameraProblem = "insecure" | "unsupported" | "denied" | "noCamera" | "inUse" | "other";

export function cameraProblem(error: unknown, context: { secure: boolean; hasMediaDevices: boolean }): CameraProblem {
  // The camera is only offered to https pages (and localhost).
  if (!context.secure) return "insecure";
  if (!context.hasMediaDevices) return "unsupported";
  const name = error instanceof Error && error.name !== "Error" ? error.name : "";
  const text = `${name} ${error instanceof Error ? error.message : String(error)}`;
  if (/NotAllowedError|PermissionDenied|Permission denied|SecurityError/i.test(text)) return "denied";
  if (/NotFoundError|DevicesNotFound|OverconstrainedError|Requested device not found|no camera/i.test(text)) return "noCamera";
  if (/NotReadableError|TrackStartError|AbortError|Could not start video source/i.test(text)) return "inUse";
  if (/NotSupportedError|not supported|streaming not supported/i.test(text)) return "unsupported";
  return "other";
}

/** The page's own facts for `cameraProblem`. */
export function cameraContext(): { secure: boolean; hasMediaDevices: boolean } {
  return {
    secure: globalThis.isSecureContext !== false,
    hasMediaDevices: typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function",
  };
}
