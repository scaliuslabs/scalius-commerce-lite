// A response whose code chose its Content-Security-Policy on purpose (a card
// page's strict policy, an attachment's sandbox, an app answer) says so with
// an internal marker carrying this isolate's secret token; the middleware
// keeps that policy only when the token matches, removes the marker before the
// browser sees it, and gives every other response the page policy, replacing
// any policy it did not ask for (an upstream's, a framework's). A marker copied
// from an upstream can never match.

/** The internal header that marks a deliberately owned policy. Never sent to the browser. */
export const OWN_CSP_MARKER = "X-Scalius-Own-Csp";

/** This isolate's token (made on first use: Workers allow no random values at start-up). */
let token: string | null = null;
const ownToken = () => (token ??= crypto.randomUUID());

/** The headers of a response that owns its policy: the policy and the marker. */
export function ownCspHeaders(policy: string): Record<string, string> {
  return { "Content-Security-Policy": policy, [OWN_CSP_MARKER]: ownToken() };
}

/** Sets a policy the response owns on its headers. */
export function setOwnCsp(headers: Headers, policy: string): void {
  for (const [name, value] of Object.entries(ownCspHeaders(policy))) headers.set(name, value);
}

/** Whether this isolate's code marked the response's policy; the marker is removed either way. */
export function takeOwnCsp(response: Response): boolean {
  const marker = response.headers.get(OWN_CSP_MARKER);
  if (marker === null) return false;
  response.headers.delete(OWN_CSP_MARKER);
  return marker === ownToken();
}
