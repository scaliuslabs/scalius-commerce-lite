// Define the types for the Astro integration hooks
interface AstroIntegration {
  name: string;
  hooks: {
    "astro:config:setup"?: (params: {
      injectRoute: (route: { pattern: string; entrypoint: string }) => void;
      logger: any;
    }) => void | Promise<void>;
  };
}

export default function honoIntegration(): AstroIntegration {
  return {
    name: "hono-integration",
    hooks: {
      "astro:config:setup": ({ injectRoute, logger }) => {
        logger.info("Setting up Hono API integration for Scalius Commerce");

        const apiEntrypoint = "./src/server/astro-handler.ts";

        // Use Astro's catch-all syntax targeting the handler
        const catchAllPattern = "/api/v1/[...slug]";
        injectRoute({
          pattern: catchAllPattern,
          entrypoint: apiEntrypoint,
        });
        logger.info(
          `Injected Hono catch-all route: pattern='${catchAllPattern}', entrypoint='${apiEntrypoint}'`,
        );

        // Add Partytown proxy route
        const partytownProxyPattern = "/api/__ptproxy";
        injectRoute({
          pattern: partytownProxyPattern,
          entrypoint: apiEntrypoint,
        });
        logger.info(
          `Injected Partytown proxy route: pattern='${partytownProxyPattern}', entrypoint='${apiEntrypoint}'`,
        );

        // Keep specific docs/openapi routes - might need higher specificity
        const docsPattern = "/api/v1/docs";
        injectRoute({
          pattern: docsPattern,
          entrypoint: apiEntrypoint,
        });
        logger.info(
          `Injected docs route: pattern='${docsPattern}', entrypoint='${apiEntrypoint}'`,
        );

        const openapiPattern = "/api/v1/openapi.json";
        injectRoute({
          pattern: openapiPattern,
          entrypoint: apiEntrypoint,
        });
        logger.info(
          `Injected openapi route: pattern='${openapiPattern}', entrypoint='${apiEntrypoint}'`,
        );

        logger.info("Hono API routes integration setup complete.");
      },
    },
  };
}
