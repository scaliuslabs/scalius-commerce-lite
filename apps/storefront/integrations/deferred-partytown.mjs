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

/**
 * Keep Partytown's forwarding contract available immediately, but postpone its
 * runtime and sandbox until first-party resources have loaded and painted.
 * Calls made in the gap are replayed into Partytown's own forwarding buffer;
 * an early interaction starts delivery immediately rather than losing intent.
 */
export function buildDeferredPartytownBootstrap({
  forward = [],
  loaderPath,
}) {
  const forwardPaths = forward.map((entry) =>
    Array.isArray(entry) ? entry[0] : entry,
  );

  return `!function(w,d,p){var q=w.__scaliusPtq=w.__scaliusPtq||[],a=${JSON.stringify(
    forwardPaths,
  )},x=function(n){for(var s=n.split('.'),o=w,i=0;i<s.length-1;i++)o=o[s[i]]||(o[s[i]]=s[i+1]==='push'?[]:{});var k=s[s.length-1],f=o[k];o[k]=function(){var r=[].slice.call(arguments);q.push([n,r]);if(n==='dataLayer.push'&&typeof f==='function')return f.apply(o,r)}};a.forEach(x);var l=0,h=function(){if(l)return;l=1;var s=d.createElement('script');s.src=p;s.async=true;s.onload=function(){var b=q.splice(0);b.forEach(function(e){for(var s=e[0].split('.'),o=w,i=0;i<s.length-1;i++)o=o&&o[s[i]];var f=o&&o[s[s.length-1]];if(typeof f==='function')f.apply(o,e[1])})};d.head.appendChild(s)},r=w.requestAnimationFrame||function(f){return setTimeout(f,16)},g=function(){r(function(){r(h)})};d.readyState==='complete'?g():w.addEventListener('load',g,{once:true});['pointerdown','keydown','touchstart'].forEach(function(e){w.addEventListener(e,h,{once:true,passive:true})});setTimeout(h,4000)}(window,document,${JSON.stringify(
    loaderPath,
  )});`;
}

function contentTypeFor(name) {
  if (name.endsWith(".html")) return "text/html; charset=utf-8";
  if (name.endsWith(".wasm")) return "application/wasm";
  return "text/javascript; charset=utf-8";
}

/**
 * A deliberately small fork of Astro's official Partytown integration. The
 * library assets and configuration are unchanged; only the bootstrap delivery
 * moves from a large inline head script to a hashed, post-first-paint asset.
 */
export default function deferredPartytown(options = {}) {
  let loaderSource = "";
  let loaderName = "";
  let loaderPath = "";
  let libPath = DEFAULT_LIB_PATH;

  return {
    name: "@scalius/deferred-partytown",
    hooks: {
      "astro:config:setup": ({ config, command, injectScript }) => {
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
        injectScript(
          "head-inline",
          buildDeferredPartytownBootstrap({
            forward: partytownConfig.forward,
            loaderPath,
          }),
        );
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
