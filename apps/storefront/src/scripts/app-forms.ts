/**
 * The storefront's app forms enhancer: platform code (never an app's) that
 * makes the forms and toggles inside an app's proxy page work without a page
 * load. Loaded by the proxy page route, so only app pages carry it.
 *
 * - `form[data-app-form]` whose action is this store's `/apps/...` proxy
 *   posts its fields with `fetch` and reads a JSON answer
 *   `{ pressed?, message?, navigate?, redirect? }`: `pressed` sets the
 *   submit button's `aria-pressed` and swaps its `[data-app-label]` text to
 *   `data-app-label-on|off`; `message` goes into the form's
 *   `[data-app-message]` (a status live region) as text; `navigate` or
 *   `redirect` is followed only to a path on this store. If the request
 *   cannot be sent at all, the form submits normally.
 * - `[data-app-state]` (a `/apps/...` path) is read once after load and its
 *   `pressed` applied the same way, so cached HTML can show a buyer's state.
 *
 * Nothing from an answer ever enters the DOM as HTML. Without JavaScript the
 * plain form posts, and the proxy answers the navigation with a redirect back.
 */
import { logicalPathname } from "@/lib/presence-url";

/** What an app answers a form or state read with (anything else is ignored). */
export interface AppFormAnswer {
  pressed?: boolean;
  message?: string;
  navigate?: string;
  redirect?: string;
}

const MAX_MESSAGE = 300;

/** A C0 control character or DEL anywhere in the value. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A path on this store (`/x`, never `//x`, `/\x` or another origin), as
 * `pathname + search + hash`, or null.
 */
export function sameOriginPath(value: unknown, origin: string): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
  if (value.includes("\\") || hasControlCharacter(value)) return null;
  try {
    const url = new URL(value, origin);
    return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : null;
  } catch {
    return null;
  }
}

/**
 * This store's app proxy URL for a form action or state path: same origin
 * and under `/apps/<plugin>/...` (no dot segments), or null. Accepts the
 * absolute URL a browser reports for `form.action` as well as a path.
 */
export function appProxyUrl(value: unknown, origin: string): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value.trim(), origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.username || url.password) return null;
  // A presence page's app links carry its prefix (`/en-in/apps/...`).
  if (!/^\/apps\/[a-z0-9][a-z0-9.-]*\/[^/]/.test(logicalPathname(url.pathname))) return null;
  if (url.pathname.split("/").some((segment) => segment === "." || segment === ".." || /%2e|%2f|%5c/i.test(segment))) return null;
  return `${url.origin}${url.pathname}${url.search}`;
}

/** The fields an app may answer with, typed; a `{ success: false, error: { message } }` error envelope gives its message. */
export function readAppFormAnswer(value: unknown): AppFormAnswer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const answer: AppFormAnswer = {};
  if (typeof record.pressed === "boolean") answer.pressed = record.pressed;
  const error = typeof record.error === "object" && record.error !== null ? (record.error as Record<string, unknown>) : null;
  const message = typeof record.message === "string" ? record.message : typeof error?.message === "string" ? error.message : null;
  if (message?.trim()) answer.message = message.trim().slice(0, MAX_MESSAGE);
  if (typeof record.navigate === "string") answer.navigate = record.navigate;
  if (typeof record.redirect === "string") answer.redirect = record.redirect;
  return answer;
}

/** The control whose pressed state an answer sets: the `[aria-pressed]` element, else the submit button. */
function pressedControl(root: Element): HTMLElement | null {
  return root.querySelector<HTMLElement>("[aria-pressed]")
    ?? root.querySelector<HTMLElement>('button[type="submit"], input[type="submit"]');
}

/** Sets the pressed state and label (text only) of a form or state element's control. */
export function applyAppPressed(root: Element, pressed: boolean): void {
  const control = pressedControl(root);
  if (!control) return;
  control.setAttribute("aria-pressed", pressed ? "true" : "false");
  const label = control.getAttribute(pressed ? "data-app-label-on" : "data-app-label-off")
    ?? root.getAttribute(pressed ? "data-app-label-on" : "data-app-label-off");
  const target = control.querySelector("[data-app-label]") ?? root.querySelector("[data-app-label]");
  if (label !== null && target) target.textContent = label;
}

/** Puts a message (text only) into the element's `[data-app-message]` status region. */
export function applyAppMessage(root: Element, message: string): void {
  const region = root.querySelector("[data-app-message]");
  if (region) region.textContent = message;
}

async function readJson(response: Response): Promise<unknown> {
  if (!(response.headers.get("Content-Type") ?? "").toLowerCase().includes("json")) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function formFields(form: HTMLFormElement, submitter: HTMLElement | null): URLSearchParams {
  let data: FormData;
  try {
    data = submitter ? new FormData(form, submitter) : new FormData(form);
  } catch {
    data = new FormData(form);
  }
  const fields = new URLSearchParams();
  for (const [name, value] of data) {
    if (typeof value === "string") fields.append(name, value);
  }
  return fields;
}

function follow(answer: AppFormAnswer, origin: string): boolean {
  const path = sameOriginPath(answer.redirect, origin) ?? sameOriginPath(answer.navigate, origin);
  if (!path) return false;
  window.location.assign(path);
  return true;
}

async function submitAppForm(form: HTMLFormElement, action: string, submitter: HTMLElement | null): Promise<void> {
  const origin = window.location.origin;
  // Busy while the request runs: a second click does not post twice.
  const control = pressedControl(form);
  const disable = control !== null && !control.hasAttribute("disabled");
  const fields = formFields(form, submitter);
  const settle = () => {
    form.removeAttribute("aria-busy");
    if (disable) control?.removeAttribute("disabled");
  };
  form.setAttribute("aria-busy", "true");
  if (disable) control?.setAttribute("disabled", "");
  let response: Response;
  try {
    response = await fetch(action, {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: fields,
    });
  } catch {
    // The request never reached the store: the plain form post still works.
    settle();
    HTMLFormElement.prototype.submit.call(form);
    return;
  }
  const answer = readAppFormAnswer(await readJson(response));
  settle();
  if (answer.pressed !== undefined) applyAppPressed(form, answer.pressed);
  if (answer.message) applyAppMessage(form, answer.message);
  follow(answer, origin);
}

function onSubmit(event: SubmitEvent): void {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-app-form") || event.defaultPrevented) return;
  if ((form.getAttribute("method") ?? "get").toLowerCase() !== "post") return;
  const action = appProxyUrl(form.getAttribute("action"), window.location.origin);
  if (!action) return;
  event.preventDefault();
  if (form.getAttribute("aria-busy") === "true") return;
  void submitAppForm(form, action, event.submitter instanceof HTMLElement ? event.submitter : null);
}

/** Reads every `[data-app-state]` once (one request per distinct URL) and applies `pressed`. */
export async function loadAppStates(root: ParentNode = document): Promise<void> {
  const origin = window.location.origin;
  const reads = new Map<string, Promise<AppFormAnswer>>();
  const pending: Array<Promise<void>> = [];
  for (const element of Array.from(root.querySelectorAll("[data-app-state]"))) {
    const url = appProxyUrl(element.getAttribute("data-app-state"), origin);
    if (!url) continue;
    let read = reads.get(url);
    if (!read) {
      read = fetch(url, { method: "GET", credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(async (response) => (response.ok ? readAppFormAnswer(await readJson(response)) : {}))
        .catch(() => ({}));
      reads.set(url, read);
    }
    pending.push(read.then((answer) => {
      if (answer.pressed !== undefined) applyAppPressed(element, answer.pressed);
    }));
  }
  await Promise.all(pending);
}

export function installAppForms(): void {
  if (window.__scaliusAppFormsInstalled) return;
  window.__scaliusAppFormsInstalled = true;
  document.addEventListener("submit", onSubmit);
  const load = () => void loadAppStates();
  if ("requestIdleCallback" in window) window.requestIdleCallback(load, { timeout: 2000 });
  else setTimeout(load, 1);
}
