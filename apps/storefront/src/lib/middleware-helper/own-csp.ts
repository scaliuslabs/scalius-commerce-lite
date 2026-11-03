// A response whose code chose its Content-Security-Policy on purpose (a card
// page's strict policy, an attachment's or an app file's sandbox) says so with
// an internal marker; the middleware keeps that policy, removes the marker
// before the browser sees it, and gives every other response the page policy,
// replacing any policy it did not ask for (an upstream's, a framework's).

/** The internal header that marks a deliberately owned policy. Never sent to the browser. */
export const OWN_CSP_MARKER = "X-Scalius-Own-Csp";

/** The headers of a response that owns its policy: the policy and the marker. */
export function ownCspHeaders(policy: string): Record<string, string> {
  return { "Content-Security-Policy": policy, [OWN_CSP_MARKER]: "1" };
}

/** Sets a policy the response owns on its headers. */
export function setOwnCsp(headers: Headers, policy: string): void {
  for (const [name, value] of Object.entries(ownCspHeaders(policy))) headers.set(name, value);
}

/** Whether the response owns its policy; the marker is removed either way. */
export function takeOwnCsp(response: Response): boolean {
  const owned = response.headers.has(OWN_CSP_MARKER);
  if (owned) response.headers.delete(OWN_CSP_MARKER);
  return owned;
}
