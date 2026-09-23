import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

import { partytownSnippet } from "@qwik.dev/partytown/integration";
import {
  copyLibFiles,
  libDirPath,
} from "@qwik.dev/partytown/utils";

const DEFAULT_LIB_PATH = "/~partytown/";
const LOADER_PREFIX = "scalius-loader";

function withTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function buildLoaderName(snippet) {
  const digest = createHash("sha256").update(snippet).digest("hex").slice(0, 12);
  return `${LOADER_PREFIX}.${digest}.js`;
}

function contentTypeFor(name) {
  if (name.endsWith(".html")) return "text/html; charset=utf-8";
  if (name.endsWith(".wasm")) return "application/wasm";
  return "text/javascript; charset=utf-8";
}

const VIRTUAL_MODULE_ID = "virtual:scalius/partytown";
const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`;

/**
 * A deliberately small fork of Astro's official Partytown integration. The
 * library assets are unchanged; the loader is a hashed, post-first-paint
 * asset, and nothing is injected globally. Layout.astro imports the loader
 * path from `virtual:scalius/partytown` and renders the bootstrap
 * (src/lib/partytown-config.ts) only on pages whose analytics run in Partytown.
 */
export default function deferredPartytown(options = {}) {
  let loaderSource = "";
  let loaderName = "";
  let loaderPath = "";
  let libPath = DEFAULT_LIB_PATH;

  return {
    name: "@scalius/deferred-partytown",
    hooks: {
      "astro:config:setup": ({ config, command, updateConfig }) => {
        libPath = withTrailingSlash(
          options.config?.lib || `${withTrailingSlash(config.base)}~partytown/`,
        );
        const partytownConfig = {
          lib: libPath,
          ...options.config,
          debug: options.config?.debug ?? command === "dev",
        };

        loaderSource = partytownSnippet(partytownConfig);
        loaderName = buildLoaderName(loaderSource);
        loaderPath = `${libPath}${loaderName}`;
        updateConfig({
          vite: {
            plugins: [
              {
                name: "scalius-partytown-loader-path",
                resolveId(id) {
                  return id === VIRTUAL_MODULE_ID
                    ? RESOLVED_VIRTUAL_MODULE_ID
                    : undefined;
                },
                load(id) {
                  return id === RESOLVED_VIRTUAL_MODULE_ID
                    ? `export const partytownLoaderPath = ${JSON.stringify(loaderPath)};`
                    : undefined;
                },
              },
            ],
          },
        });
      },

      "astro:server:setup": ({ server }) => {
        const sourceDirectory = libDirPath({ debugDir: false });
        server.middlewares.use(async (request, response, next) => {
          const pathname = new URL(request.url || "/", "http://localhost")
            .pathname;
          if (!pathname.startsWith(libPath)) return next();

          const name = decodeURIComponent(pathname.slice(libPath.length));
          if (name === loaderName) {
            response.statusCode = 200;
            response.setHeader("Content-Type", contentTypeFor(name));
            response.end(loaderSource);
            return;
          }
          if (!/^[A-Za-z0-9._-]+$/.test(name)) return next();

          try {
            const body = await fs.promises.readFile(
              fileURLToPath(new URL(name, `file://${sourceDirectory}/`)),
            );
            response.statusCode = 200;
            response.setHeader("Content-Type", contentTypeFor(name));
            response.end(body);
          } catch {
            next();
          }
        });
      },

      "astro:build:done": async ({ dir }) => {
        const destination = fileURLToPath(
          new URL(libPath.replace(/^\//, ""), dir),
        );
        await copyLibFiles(destination, { debugDir: false });
        await fs.promises.writeFile(
          fileURLToPath(new URL(loaderName, `file://${destination}/`)),
          loaderSource,
        );
      },

      "astro:build:ssr": async ({ manifest }) => {
        const files = await fs.promises.readdir(
          libDirPath({ debugDir: false }),
        );
        for (const file of files) {
          if (file !== "debug") manifest.assets.push(`${libPath}${file}`);
        }
        manifest.assets.push(loaderPath);
      },
    },
  };
}
