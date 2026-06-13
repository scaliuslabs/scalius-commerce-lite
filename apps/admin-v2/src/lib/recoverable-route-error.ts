export const RECOVERABLE_ROUTE_RELOAD_KEY =
  "scalius-admin:recoverable-route-error-reload";

const RECOVERABLE_ROUTE_ERROR_PATTERNS = [
  "failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "importing a module script failed",
  "chunkloaderror",
  "loading chunk",
  "css_chunk_load_failed",
];

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name} ${error.message} ${error.stack ?? ""}`;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "";
  }
}

export function isRecoverableRouteLoadError(error: unknown): boolean {
  const normalized = errorText(error).toLowerCase();
  return RECOVERABLE_ROUTE_ERROR_PATTERNS.some((pattern) =>
    normalized.includes(pattern),
  );
}

export function recoverableRouteErrorSignature(error: unknown): string {
  return errorText(error).slice(0, 240);
}
