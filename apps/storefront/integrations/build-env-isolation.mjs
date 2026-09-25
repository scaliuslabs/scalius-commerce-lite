import { basename } from "node:path";

// The keys Astro and Vite define without any env file.
export const BUILT_IN_ENV_KEYS = Object.freeze(["ASSETS_PREFIX", "BASE_URL", "DEV", "MODE", "PROD", "SITE", "SSR"]);
const BUILT_IN_ENV_OBJECT = `({${BUILT_IN_ENV_KEYS.map((key) => `${key}:import.meta.env.${key}`).join(",")}})`;

export function isLocalEnvFileName(name) {
  return name === ".dev.vars" || name.startsWith(".dev.vars.")
    || name === ".env" || name.startsWith(".env.");
}

/**
 * Rewrites module code so only the built-in `import.meta.env` keys remain:
 * `import.meta.env.OTHER` becomes `undefined` and a bare `import.meta.env`
 * becomes an object of the built-in keys.
 */
export function restrictImportMetaEnv(code) {
  return code
    .replace(/\bimport\.meta\.env\.([A-Za-z_$][\w$]*)/g, (match, key) =>
      BUILT_IN_ENV_KEYS.includes(key) ? match : "undefined")
    .replace(/\bimport\.meta\.env\b(?!\.[A-Za-z_$])/g, BUILT_IN_ENV_OBJECT);
}

/**
 * Keeps local env values out of `astro build` output.
 *
 * Astro inlines every non-PUBLIC_ variable it can see (Vite env files plus all
 * of `process.env`) into server code: `import.meta.env.NAME` becomes a string
 * literal, and a module that mentions a bare `import.meta.env`, even in a
 * comment, gets every variable whose name appears anywhere in its text.
 * @astrojs/cloudflare copies the app's `.dev.vars` into `process.env` before
 * the build, so the local SCALIUS_SECRET reached the built Worker; the
 * Cloudflare Vite plugin also writes `.dev.vars` into `dist/server/`.
 *
 * For builds this integration rewrites every module, before Astro's env
 * plugin sees it, so only the built-in keys can be inlined; stops Vite from
 * reading `.env*` files; and drops env files from the emitted bundle. What
 * `process.env` or a local file holds can no longer reach dist/. `astro dev`
 * is untouched: Worker bindings still come from `.dev.vars` through
 * `cloudflare:workers`, and runtime secrets are read only from the Worker
 * `env` at request time. scripts/check-dist-secrets.mjs and
 * scripts/check-build-canaries.mjs prove it on every deploy.
 */
export default function buildEnvIsolation() {
  return {
    name: "scalius:build-env-isolation",
    hooks: {
      "astro:config:setup": ({ command, updateConfig }) => {
        if (command !== "build") return;
        updateConfig({
          vite: {
            envDir: false,
            plugins: [
              {
                // A normal plugin: it runs after .astro/TypeScript compilation
                // and before astro:vite-plugin-env, which Astro moves next to
                // vite:define at the end of the normal plugins.
                name: "scalius:restrict-import-meta-env",
                apply: "build",
                transform: {
                  filter: { code: /import\.meta\.env/ },
                  handler(code) {
                    const next = restrictImportMetaEnv(code);
                    return next === code ? null : { code: next, map: null };
                  },
                },
              },
              {
                name: "scalius:drop-local-env-files",
                apply: "build",
                enforce: "post",
                generateBundle(_options, bundle) {
                  for (const fileName of Object.keys(bundle)) {
                    if (isLocalEnvFileName(basename(fileName))) delete bundle[fileName];
                  }
                },
              },
            ],
          },
        });
      },
    },
  };
}
