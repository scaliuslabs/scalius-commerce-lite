// Sending an app's action and reading its answer. Used by buttons and forms
// inside an app's UI tree and by the manifest's detail and bulk actions.
// Loaded on demand: it carries the UI schema (zod), which list pages and the
// shell never need until someone presses an app's button.
import { toast } from "~/lib/toast";
import {
  parsePluginUiActionResult,
  type PluginUiActionResult,
  type PluginUiDocument,
  type PluginUiRouteAction,
  type PluginUiTarget,
} from "@scalius/shared/plugins/ui";
import { translate } from "~/i18n";
import { appUiMessages } from "~/i18n/app-ui";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { ADMIN_API_READ_TIMEOUT_CODE } from "~/lib/admin-api-timeout";
import { fetchAppRoute } from "~/lib/app-route";
import { isAppRouteDeclared, targetLocation, type AppAction, type AppSurfaces, type AppTarget } from "./surfaces";

/** A button or form named a route (or method) the app never declared: nothing is sent. */
export class UndeclaredAppRouteError extends Error {
  constructor() {
    super("Undeclared app route.");
    this.name = "UndeclaredAppRouteError";
  }
}

export interface AppActionOutcome {
  /** The app answered 2xx. */
  ok: boolean;
  status: number;
  result: PluginUiActionResult;
}

/**
 * Sends `body` to one of the app's declared admin routes. Platform failures
 * (and undeclared routes) throw; the app's own answer, whatever its status,
 * comes back as an action result (any other JSON is an empty result).
 */
export async function runAppRoute(
  app: Pick<AppSurfaces, "id" | "routes">,
  action: Pick<PluginUiRouteAction, "route" | "subpath" | "method">,
  body: Record<string, unknown>,
): Promise<AppActionOutcome> {
  const method = action.method ?? "POST";
  if (!isAppRouteDeclared(app, action.route, method)) throw new UndeclaredAppRouteError();
  const response = await fetchAppRoute(app.id, action.route, { method, subpath: action.subpath, body });
  return { ok: response.ok, status: response.status, result: parsePluginUiActionResult(response.body) };
}

/** Whether the answer asks the dashboard to do anything. */
export function hasActionEffect(result: PluginUiActionResult): boolean {
  return Boolean(result.toast || result.errors || result.refresh || result.navigate || result.ui);
}

/** Staff-facing text for a failed request (the app's masked reason when the platform gave one). */
export function appErrorMessage(error: unknown, fallback: "actionFailed" | "loadFailedBody" = "actionFailed"): string {
  if (error instanceof UndeclaredAppRouteError) return translate(appUiMessages, "notDeclared");
  const code = (error as { code?: unknown } | null)?.code;
  if (code === ADMIN_API_READ_TIMEOUT_CODE || code === "app_timeout") return translate(appUiMessages, "timeout");
  if (error instanceof AdminApiResponseError && error.message.trim() !== "") return error.message;
  return translate(appUiMessages, fallback);
}

/** The app's toast; an unsuccessful answer without a tone reads as an error. */
export function showActionToast(result: PluginUiActionResult, ok: boolean): void {
  if (!result.toast) return;
  const tone = result.toast.tone ?? (ok ? "success" : "critical");
  if (tone === "critical") toast.error(result.toast.message);
  else if (tone === "info") toast.info(result.toast.message);
  else toast.success(result.toast.message);
}

export type Navigate = (options: { to: string; search?: Record<string, string> }) => unknown;

/**
 * Runs an app's manifest action on records (`{ resource, ids, action }` to
 * its declared route) and applies the answer: a toast, a refresh, a page to
 * open, or a tree for `showAnswer`. True when the app answered 2xx.
 */
export async function runManifestAction(
  entry: { app: AppSurfaces; action: AppAction },
  target: AppTarget,
  ids: readonly string[],
  effects: { refresh: () => void; navigate: Navigate; showAnswer: (document: PluginUiDocument) => void },
): Promise<boolean> {
  let outcome: AppActionOutcome;
  try {
    outcome = await runAppRoute(entry.app, { route: entry.action.route, method: "POST" }, {
      resource: target,
      ids: [...ids],
      action: entry.action.id,
    });
  } catch (error) {
    toast.error(appErrorMessage(error));
    return false;
  }
  const { ok, result } = outcome;
  if (!ok && !hasActionEffect(result)) {
    toast.error(translate(appUiMessages, "actionFailed"));
    return false;
  }
  showActionToast(result, ok);
  if (result.errors && !result.toast) toast.error(Object.values(result.errors).join(" "));
  if (ok && !hasActionEffect(result)) toast.success(translate(appUiMessages, "actionSent"));
  if (result.ui) effects.showAnswer(result.ui as PluginUiDocument);
  // The records changed: every query on screen reads them again (app cards included).
  if (result.refresh) effects.refresh();
  if (result.navigate) openTarget(effects.navigate, entry.app, result.navigate);
  return ok;
}

/** Opens an action's `navigate` target: a dashboard page in place, an https site in a new tab. */
export function openTarget(navigate: Navigate, app: Pick<AppSurfaces, "id">, target: PluginUiTarget): void {
  const location = targetLocation(app, target);
  if (!location) return;
  if (location.kind === "external") window.open(location.href, "_blank", "noopener,noreferrer");
  else void navigate({ to: location.to, ...(location.search ? { search: location.search } : {}) });
}
