// An app pixel's frame (packages/shared/src/plugins/buyer-events.ts): the
// document `/_x/<plugin id>/<release>/pixel.html?connect=<hosts>&v=<build>`,
// written by the storefront around the release's `pixel.js`, never by the app.
//
// Its policy is the boundary: `sandbox allow-scripts` gives it an opaque
// origin wherever it is opened (no store cookies, storage or same-origin
// requests, no access to the page that frames it); scripts are only the two
// inline ones named by their hashes; it connects and loads images only from
// the hosts in its URL, which the page writes from the app's approved hosts
// (anyone can open the URL with other hosts, but then it hears nothing: only
// the store's page sends it events). The URL names the release and the
// storefront build, so the document is immutable and the browser keeps it.
//
// The runtime (below) waits for the page's one connect message, takes the
// port it transfers, starts the pixel's `setup` on `init` and hands it each
// event. The pixel's own code arrives as `var __scaliusPixel = …` (the
// package build's IIFE).

import {
  PIXEL_CONNECT_MESSAGE,
  PIXEL_CONSENT_CATEGORIES,
  STOREFRONT_PIXEL_FILE,
  STOREFRONT_PIXEL_FRAME,
  isPixelEventName,
  type StorefrontAppPixel,
} from "@scalius/shared/plugins/buyer-events";
import { PLUGIN_ID_PATTERN } from "@scalius/shared/plugins/ids";
import { PLUGIN_HOST_PATTERN } from "@scalius/shared/plugins/manifest-patterns";
import { PROTECTED_CUSTOMER_DATA, type ProtectedCustomerData } from "@scalius/shared/plugins/protected-data";
import { serializeJsonForInlineScript } from "../safe-json";

const FRAME_PATH = /^\/_x\/([a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*)\/([0-9a-f]{64})\/pixel\.html$/;
const MAX_HOSTS = 10;

/** The frame's path and query for one app release, its approved hosts and this storefront build. */
export function pixelFrameUrl(pluginId: string, release: string, connect: readonly string[], build: string): string {
  const hosts = connect.filter((host) => PLUGIN_HOST_PATTERN.test(host)).slice(0, MAX_HOSTS);
  const query = new URLSearchParams({ connect: hosts.join(","), v: build });
  return `/_x/${pluginId}/${release}/${STOREFRONT_PIXEL_FRAME}?${query}`;
}

/** The plugin id, release and hosts a frame URL names; null for any other URL. */
export function parsePixelFrameUrl(url: URL): { pluginId: string; release: string; connect: string[] } | null {
  const match = FRAME_PATH.exec(url.pathname);
  if (!match) return null;
  const connect = (url.searchParams.get("connect") ?? "").split(",").filter(Boolean);
  if (connect.length > MAX_HOSTS || !connect.every((host) => PLUGIN_HOST_PATTERN.test(host))) return null;
  return { pluginId: match[1]!, release: match[2]!, connect };
}

/** The frame runtime: plain ES2017, no dependencies. */
export const PIXEL_FRAME_RUNTIME =
  "!function(w){" +
  "var port=null,api=null,init=null,queue=[],listeners={},visitor=null;" +
  "var deliver=function(e){visitor=e.context&&e.context.visitorId!==undefined?e.context.visitorId:visitor;" +
  'var list=(listeners[e.name]||[]).concat(listeners["*"]||[]);' +
  "for(var i=0;i<list.length;i++){try{list[i](e)}catch(x){console.error(x)}}};" +
  "var start=function(){var m=w.__scaliusPixel&&w.__scaliusPixel.default;" +
  'if(!m||typeof m.setup!=="function"){console.error("The pixel has no default export (export default definePixel(...)).");return}' +
  "visitor=init.visitorId;var allowed=init.events;" +
  "api=Object.freeze({pluginId:init.pluginId,settings:Object.freeze(init.settings||{}),consent:Object.freeze(init.consent||{})," +
  "visitorId:function(){return visitor}," +
  'on:function(n,l){if(typeof l!=="function")return function(){};(listeners[n]=listeners[n]||[]).push(l);' +
  "return function(){var a=listeners[n]||[],k=a.indexOf(l);if(k>=0)a.splice(k,1)}}});" +
  "try{m.setup(api)}catch(x){console.error(x)}" +
  "var pending=queue;queue=[];for(var j=0;j<pending.length;j++)deliver(pending[j])};" +
  'w.addEventListener("message",function(e){' +
  `if(port||e.source!==w.parent||!e.data||e.data.type!==${serializeJsonForInlineScript(PIXEL_CONNECT_MESSAGE)}||!e.ports||!e.ports[0])return;` +
  "port=e.ports[0];port.onmessage=function(m){var d=m.data;if(!d)return;" +
  'if(d.type==="init"&&!init){init=d;start()}' +
  'else if(d.type==="event"&&d.event){if(api)deliver(d.event);else queue.push(d.event)}}})' +
  "}(self);";

/** Inline script text the HTML parser cannot end early. */
function inlineScript(code: string): string {
  return code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

async function sha256Source(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return `'sha256-${btoa(binary)}'`;
}

/** The frame document around a pixel's code, and its policy. */
export async function pixelFrameDocument(pixelCode: string, connect: readonly string[]): Promise<{ html: string; policy: string }> {
  const app = inlineScript(pixelCode);
  const runtime = PIXEL_FRAME_RUNTIME;
  const sources = connect.length > 0 ? connect.map((host) => `https://${host}`).join(" ") : "'none'";
  const policy = [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src ${await sha256Source(app)} ${await sha256Source(runtime)}`,
    `connect-src ${sources}`,
    `img-src ${sources}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return {
    html: `<!doctype html><html><head><meta charset="utf-8"><title>pixel</title><script>${app}</script><script>${runtime}</script></head></html>`,
    policy,
  };
}

/** The pixel's file in its release (read only to build its frame; never served on its own). */
export const PIXEL_FILE = STOREFRONT_PIXEL_FILE;

const RELEASE = /^[0-9a-f]{64}$/;

/** The layout payload's `appPixels`, shape-checked: a malformed entry is left out (it runs nothing). */
export function readLayoutPixels(value: unknown): StorefrontAppPixel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): StorefrontAppPixel[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const pixel = entry as Record<string, unknown>;
    if (typeof pixel.pluginId !== "string" || !PLUGIN_ID_PATTERN.test(pixel.pluginId)) return [];
    if (typeof pixel.release !== "string" || !RELEASE.test(pixel.release)) return [];
    if (!(PIXEL_CONSENT_CATEGORIES as readonly unknown[]).includes(pixel.consent)) return [];
    const events = Array.isArray(pixel.events) ? pixel.events.filter(isPixelEventName) : [];
    if (events.length === 0) return [];
    const list = (items: unknown) => (Array.isArray(items) ? items.filter((item): item is string => typeof item === "string") : []);
    const settings = typeof pixel.settings === "object" && pixel.settings !== null && !Array.isArray(pixel.settings)
      ? Object.fromEntries(Object.entries(pixel.settings).filter(([, item]) => item === null || ["string", "number", "boolean"].includes(typeof item)))
      : {};
    return [{
      pluginId: pixel.pluginId,
      release: pixel.release,
      consent: pixel.consent as StorefrontAppPixel["consent"],
      events,
      protectedData: list(pixel.protectedData).filter((item): item is ProtectedCustomerData => (PROTECTED_CUSTOMER_DATA as readonly string[]).includes(item)),
      connect: list(pixel.connect).filter((host) => PLUGIN_HOST_PATTERN.test(host)),
      settings: settings as StorefrontAppPixel["settings"],
    }];
  });
}
