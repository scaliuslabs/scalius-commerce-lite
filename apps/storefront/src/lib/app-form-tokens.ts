/**
 * The platform's form token in app forms (`@scalius/shared/plugins/app-form`).
 * On a page rendered for a signed-in buyer, every `<form method="post">`
 * whose action is an app proxy path (`/apps/<plugin id>/...`, under any
 * presence) gets a hidden `_scalius_form` field bound to that app and the
 * buyer's session. The API refuses a session-carrying form post to an app
 * without it, before the app's handler runs.
 *
 * Runs in the gateway after the page cache, on HTML only, and only when the
 * request carries the session cookie: such pages are always rendered for the
 * buyer (the session bypasses the shared cache), and an anonymous page,
 * which is what the cache stores, is never touched. Without the master
 * secret no token is added, so those forms are refused (fail closed).
 */
import { deriveRuntimeSecret, readMasterSecret, type MasterSecretEnvironment } from "@scalius/shared/runtime-secrets";
import {
  APP_FORM_TOKEN_FIELD,
  APP_FORM_TOKEN_PURPOSE,
  appFormSessionOfCookie,
  appFormToken,
  appProxyPluginOfPath,
} from "@scalius/shared/plugins/app-form";
import { presenceOfPath, stripPresencePath } from "@scalius/shared/markets";

/** The minimum of the Workers HTMLRewriter this module uses. */
export interface AppFormElement {
  getAttribute(name: string): string | null;
  prepend(content: string, options: { html: boolean }): void;
}
export interface AppFormRewriter {
  on(selector: string, handlers: { element(element: AppFormElement): void | Promise<void> }): AppFormRewriter;
  transform(response: Response): Response;
}

function workersRewriter(): AppFormRewriter {
  const Rewriter = (globalThis as { HTMLRewriter?: new () => AppFormRewriter }).HTMLRewriter;
  if (!Rewriter) throw new Error("HTMLRewriter is not available outside the Workers runtime.");
  return new Rewriter();
}

/** The app a form posts to on this store (its action, or the page itself), or null. */
export function appOfFormAction(action: string | null, pageUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(action ?? "", pageUrl);
  } catch {
    return null;
  }
  if (url.origin !== new URL(pageUrl).origin) return null;
  return appProxyPluginOfPath(stripPresencePath(url.pathname, presenceOfPath(url.pathname)));
}

/** The response with the form token in every app POST form, when the buyer is signed in. */
export function withAppFormTokens(
  request: Request,
  response: Response,
  env: MasterSecretEnvironment,
  rewriter: () => AppFormRewriter = workersRewriter,
): Response {
  const session = appFormSessionOfCookie(request.headers.get("Cookie"));
  if (!session || !response.body) return response;
  if (!(response.headers.get("Content-Type") ?? "").toLowerCase().includes("text/html")) return response;
  const master = readMasterSecret(env);
  if (!master) return response;
  let key: Promise<string> | null = null;
  const tokens = new Map<string, Promise<string>>();
  const tokenFor = (pluginId: string) => {
    let token = tokens.get(pluginId);
    if (!token) {
      key ??= deriveRuntimeSecret(master, APP_FORM_TOKEN_PURPOSE);
      token = key.then((secret) => appFormToken(secret, pluginId, session));
      tokens.set(pluginId, token);
    }
    return token;
  };
  return rewriter().on("form", {
    async element(form) {
      if ((form.getAttribute("method") ?? "get").trim().toLowerCase() !== "post") return;
      const pluginId = appOfFormAction(form.getAttribute("action"), request.url);
      if (!pluginId) return;
      // A hex token: nothing in it needs escaping.
      form.prepend(`<input type="hidden" name="${APP_FORM_TOKEN_FIELD}" value="${await tokenFor(pluginId)}">`, { html: true });
    },
  }).transform(response);
}
