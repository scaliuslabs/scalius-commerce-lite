/**
 * Auth request middleware for TanStack Start.
 * Temporarily simplified for debugging — skips DB calls.
 */

import { createMiddleware } from "@tanstack/react-start";

export const authMiddleware = createMiddleware().server(
  async ({ next }) => {
    return next({
      context: {
        user: null,
        session: null,
      },
    });
  },
);
