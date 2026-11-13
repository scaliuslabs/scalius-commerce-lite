/**
 * Why the camera did not start, as a person can act on it. The browser's own
 * error (`NotAllowedError`, `NotFoundError`, …), which html5-qrcode wraps in
 * text such as "Error getting userMedia, error = NotSupportedError: Not
 * supported", is never shown.
 */
export type CameraProblem = "insecure" | "unsupported" | "policy" | "denied" | "noCamera" | "inUse" | "other";

export interface CameraContext {
  secure: boolean;
  hasMediaDevices: boolean;
  /**
   * Whether this document's Permissions-Policy allows the camera (null: the
   * browser cannot say). The dashboard allows it only to the scanner's own
   * document, so a scanner reached by an in-app navigation is refused by the
   * page, not by the person: that is said apart from "you blocked it".
   */
  policyAllows: boolean | null;
}

export function cameraProblem(error: unknown, context: CameraContext): CameraProblem {
  // The camera is only offered to https pages (and localhost).
  if (!context.secure) return "insecure";
  if (context.policyAllows === false) return "policy";
  if (!context.hasMediaDevices) return "unsupported";
  const name = error instanceof Error && error.name !== "Error" ? error.name : "";
  const text = `${name} ${error instanceof Error ? error.message : String(error)}`;
  if (/NotAllowedError|PermissionDenied|Permission denied|SecurityError/i.test(text)) return "denied";
  if (/NotFoundError|DevicesNotFound|OverconstrainedError|Requested device not found|no camera/i.test(text)) return "noCamera";
  if (/NotReadableError|TrackStartError|AbortError|Could not start video source/i.test(text)) return "inUse";
  if (/NotSupportedError|not supported|streaming not supported/i.test(text)) return "unsupported";
  return "other";
}

type PolicyDocument = { permissionsPolicy?: { allowsFeature?: (feature: string) => boolean }; featurePolicy?: { allowsFeature?: (feature: string) => boolean } };

/** The page's own facts for `cameraProblem`. */
export function cameraContext(): CameraContext {
  const doc = (typeof document === "undefined" ? undefined : document) as (Document & PolicyDocument) | undefined;
  const policy = doc?.permissionsPolicy ?? doc?.featurePolicy;
  return {
    secure: globalThis.isSecureContext !== false,
    hasMediaDevices: typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function",
    policyAllows: typeof policy?.allowsFeature === "function" ? policy.allowsFeature("camera") : null,
  };
}
