import { createCsrfMiddleware, createStart } from "@tanstack/react-start";
import { withDashboardBasePath } from "./lib/dashboard-base-path";

const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

/**
 * Server-function URLs are built at the host root (`/_serverFn/...`). When the
 * dashboard is served below a base path the browser prefixes them so the call
 * reaches this Worker through the same proxy; the Worker entry strips the
 * prefix again before TanStack Start matches it.
 */
const serverFnFetch: typeof fetch = (input, init) => {
  if (typeof input === "string" && input.startsWith("/")) {
    return fetch(withDashboardBasePath(input), init);
  }
  return fetch(input, init);
};

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware],
  serverFns: { fetch: serverFnFetch },
}));
