/**
 * The theme editor's bridge: a small inline script the Layout adds to a
 * page only while a valid theme preview renders it (never to a buyer's
 * page, so buyers pay nothing). Inside the dashboard's editor frame it says
 * hello to the dashboard origin from Platform settings and, once the editor
 * answers:
 *
 * - reports where each marked part is (`layout`), what the pointer is over
 *   and what a click selects; the editor draws outlines in its own overlay,
 *   so nothing here changes the page's layout;
 * - applies the editor's unsaved edits without a reload: theme tokens as
 *   custom properties, a text setting in place, sections moved or hidden,
 *   sections drawn by the preview-only render route and theme settings
 *   painted by the preview-only paint route (both same-origin POSTs that
 *   carry the preview cookie);
 * - scrolls only when the editor asks to reveal a part outside the view;
 * - acknowledges each command (`ack` with its `seq`) once applied, so the
 *   editor sends again what a navigation or reload lost.
 *
 * Messages are read only from the parent window at the dashboard's exact
 * origin, and sent only there.
 */
import {
  THEME_EDITOR_SOURCE,
  THEME_PREVIEW_BODY_MAX,
  THEME_PREVIEW_FORWARDED_KEYS,
  THEME_PREVIEW_MARKS_MAX,
  THEME_PREVIEW_PAINT_PATH,
  THEME_PREVIEW_RENDER_PATH,
  THEME_PREVIEW_SOURCE,
} from "@scalius/shared/theme-editor-bridge";
import { serializeJsonForInlineScript } from "@/lib/safe-json";

/** The bridge for a dashboard origin; "" (no script) without a valid one. */
export function themePreviewBridgeScript(dashboardOrigin: string): string {
  if (!dashboardOrigin) return "";
  const json = serializeJsonForInlineScript;
  return `(() => {
  const DASHBOARD = ${json(dashboardOrigin)};
  const SELF = ${json(THEME_PREVIEW_SOURCE)};
  const EDITOR = ${json(THEME_EDITOR_SOURCE)};
  const RENDER = ${json(THEME_PREVIEW_RENDER_PATH)};
  const PAINT = ${json(THEME_PREVIEW_PAINT_PATH)};
  const KEYS = ${json(THEME_PREVIEW_FORWARDED_KEYS)};
  const MAX_MARKS = ${THEME_PREVIEW_MARKS_MAX};
  const MAX_BODY = ${THEME_PREVIEW_BODY_MAX};
  const MARK = "data-theme-section-id";
  const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
  const NAME = /^[a-z0-9-]{1,64}$/;
  const VALUE = /^[^;{}<>\\\\]{0,240}$/;
  const parent = window.parent;
  if (parent === window) return;
  const post = (message) => parent.postMessage(Object.assign({ source: SELF }, message), DASHBOARD);
  const valid = (id) => typeof id === "string" && ID.test(id) ? id : null;
  const find = (id) => document.querySelector("[" + MARK + '="' + id + '"]');
  const owner = (target) => target instanceof Element ? target.closest("[" + MARK + "]") : null;
  const marks = () => Array.from(document.querySelectorAll("[" + MARK + "]"), (element) => valid(element.getAttribute(MARK))).filter(Boolean).slice(0, MAX_MARKS);
  let connected = false;
  let inspector = true;
  let hovered = null;
  // A mark may be display:contents: measure what it holds. Any other mark is
  // its own box (what it holds may overflow it: a sticky bar, a popover).
  const box = (element) => {
    if (getComputedStyle(element).display !== "contents") return element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return rect.width || rect.height ? rect : element.getBoundingClientRect();
  };
  const measure = () => {
    if (!connected) return;
    const rects = {};
    let count = 0;
    for (const element of document.querySelectorAll("[" + MARK + "]")) {
      const id = valid(element.getAttribute(MARK));
      if (!id || rects[id] || element.closest("[hidden]") || ++count > MAX_MARKS) continue;
      const rect = box(element);
      if (!rect.width && !rect.height) continue;
      rects[id] = [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)];
    }
    post({ type: "layout", rects, scrollY: Math.round(window.scrollY), height: document.documentElement.scrollHeight });
  };
  // Scrolls and resizes report once per frame. A hidden frame (a reload
  // waiting to swap in) may get no animation frames: a timer stands in.
  let queued = false;
  const report = () => {
    if (!connected || queued) return;
    queued = true;
    const run = () => {
      if (!queued) return;
      queued = false;
      measure();
    };
    requestAnimationFrame(run);
    setTimeout(run, 50);
  };
  // The first layout goes with ready: outlines never wait for a frame.
  const ready = () => {
    post({ type: "ready", path: location.pathname, marks: marks() });
    observe();
    measure();
  };
  const ack = (seq, extra) => {
    if (typeof seq === "number") post(Object.assign({ type: "ack", seq }, extra || {}));
  };
  // Parts that change size (images loading, a carousel) move the outlines.
  const sizes = "ResizeObserver" in window ? new ResizeObserver(report) : null;
  const observe = () => {
    if (!sizes) return;
    sizes.disconnect();
    sizes.observe(document.body);
    for (const element of document.querySelectorAll("[" + MARK + "]")) sizes.observe(element);
  };
  const reveal = (id) => {
    const element = find(id);
    if (!element) return;
    const rect = box(element);
    const margin = 24;
    const view = window.innerHeight;
    if (rect.top >= margin && rect.bottom <= view - margin) return;
    const top = rect.top < margin || rect.height > view - 2 * margin
      ? window.scrollY + rect.top - margin
      : window.scrollY + rect.bottom - view + margin;
    window.scrollTo({ top, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  const tokens = (vars) => {
    if (!vars || typeof vars !== "object") return;
    const entries = Object.entries(vars).slice(0, MAX_MARKS);
    for (const target of [document.documentElement, document.body]) {
      for (const [name, value] of entries) {
        if (NAME.test(name) && typeof value === "string" && VALUE.test(value)) target.style.setProperty("--" + name, value);
      }
    }
    report();
  };
  const patchText = (id, from, to) => {
    const element = typeof from === "string" && from.trim() && typeof to === "string" ? find(id) : null;
    if (!element) return;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeValue.trim() === from.trim()) node.nodeValue = node.nodeValue.replace(from.trim(), to);
    }
    report();
  };
  const unitOf = (element) => element && (element.closest("[data-home-render-unit]") || element);
  const arrange = (region, order) => {
    const root = document.querySelector('[data-theme-region="' + region + '"]');
    if (!root || !Array.isArray(order)) return;
    const shown = new Set();
    order.forEach((id) => {
      const unit = valid(id) && unitOf(root.querySelector("[" + MARK + '="' + id + '"]'));
      if (!unit || unit.parentElement !== root || shown.has(unit)) return;
      shown.add(unit);
      unit.hidden = false;
      unit.style.setProperty("--phone-order", String(shown.size));
      root.append(unit);
    });
    for (const unit of root.children) if (!shown.has(unit) && unit.hasAttribute("data-home-render-unit")) unit.hidden = true;
    report();
  };
  // Scripts in swapped markup: inline ones run again; the page's bundled
  // scripts set up new parts on astro:page-load (idempotent initializers).
  const activate = (root) => {
    for (const old of root.querySelectorAll("script")) {
      if (old.src || old.type === "module") continue;
      const script = document.createElement("script");
      for (const attribute of old.attributes) script.setAttribute(attribute.name, attribute.value);
      script.textContent = old.textContent;
      old.replaceWith(script);
    }
    document.dispatchEvent(new Event("astro:page-load"));
  };
  const send = async (route, body, accept) => {
    const text = JSON.stringify(body);
    if (text.length > MAX_BODY) return null;
    const response = await fetch(route, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: accept },
      body: text,
    });
    if (response.status === 401) {
      post({ type: "expired" });
      return null;
    }
    return response.ok ? response : null;
  };
  // Only the newest render of each target lands (typing sends several).
  const latest = {};
  const render = async (body, after) => {
    const key = body && typeof body.only === "string" ? "unit:" + body.only : "regions";
    const ticket = (latest[key] = (latest[key] || 0) + 1);
    const response = await send(RENDER, body, "text/html");
    if (ticket !== latest[key]) return;
    if (!response) return post({ type: "render-failed" });
    const template = document.createElement("template");
    template.innerHTML = await response.text();
    if (ticket !== latest[key]) return;
    const regions = Array.from(template.content.querySelectorAll("[data-theme-region]"));
    if (regions.some((fresh) => !document.querySelector('[data-theme-region="' + fresh.getAttribute("data-theme-region") + '"]'))) return post({ type: "render-failed" });
    for (const fresh of regions) {
      document.querySelector('[data-theme-region="' + fresh.getAttribute("data-theme-region") + '"]').replaceWith(fresh);
      activate(fresh);
    }
    const unit = template.content.querySelector("[data-home-render-unit]");
    if (typeof body.only === "string" && !unit) {
      // The section shows nothing now (no content, hidden, does not fit).
      const current = unitOf(find(body.only));
      if (current) current.hidden = true;
    } else if (unit && !template.content.querySelector("[data-theme-region]")) {
      const id = body.only;
      const current = unitOf(find(id));
      const anchor = after === null ? null : unitOf(find(after));
      const region = document.querySelector('[data-theme-region="' + (body.region || "page") + '"]');
      if (current) current.replaceWith(unit);
      else if (anchor) anchor.after(unit);
      else if (region) region.prepend(unit);
      else return post({ type: "render-failed" });
      activate(unit);
    }
    observe();
    measure();
    return true;
  };
  let painted = 0;
  const paint = async (theme) => {
    const ticket = ++painted;
    const response = await send(PAINT, { theme }, "application/json");
    if (!response || ticket !== painted) return;
    const result = await response.json();
    const tokensStyle = document.querySelector("style[data-theme-tokens]");
    const fontsStyle = document.querySelector("style[data-theme-fonts]");
    if (tokensStyle && typeof result.css === "string") tokensStyle.textContent = result.css;
    if (fontsStyle && typeof result.fonts === "string") fontsStyle.textContent = result.fonts;
    // The painted block is now the truth: drop the instant token overrides.
    for (const target of [document.documentElement, document.body]) {
      for (const name of Array.from(target.style)) if (name.startsWith("--")) target.style.removeProperty(name);
    }
    if (result.attributes && typeof result.attributes === "object") {
      for (const name of Array.from(document.body.getAttributeNames())) {
        if ((name.startsWith("data-theme-") || name.startsWith("data-card-")) && !(name in result.attributes)) document.body.removeAttribute(name);
      }
      for (const [name, value] of Object.entries(result.attributes)) {
        if (/^data-(theme|card)-[a-z0-9-]+$/.test(name) && typeof value === "string") document.body.setAttribute(name, value);
      }
    }
    report();
  };
  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.origin !== DASHBOARD) return;
    const message = event.data;
    if (!message || typeof message !== "object" || message.source !== EDITOR) return;
    if (message.type === "connect") {
      inspector = message.inspector !== false;
      if (typeof message.scrollY === "number") window.scrollTo(0, message.scrollY);
      connected = true;
      ready();
      return;
    }
    if (!connected) return;
    switch (message.type) {
      case "inspector":
        inspector = message.on === true;
        if (!inspector) post({ type: "hover", id: null });
        break;
      case "reveal":
        if (valid(message.id)) reveal(message.id);
        break;
      case "tokens":
        tokens(message.vars);
        break;
      case "text":
        if (valid(message.id)) patchText(message.id, message.from, message.to);
        break;
      case "arrange":
        if (valid(message.region)) arrange(message.region, message.order);
        break;
      case "render":
        // Acknowledged once it landed or failed (a failure also says render-failed).
        if (message.body && typeof message.body === "object") {
          render(message.body, valid(message.after))
            .catch(() => post({ type: "render-failed" }))
            .then((landed) => ack(message.seq, landed === true ? { marks: marks() } : undefined));
        }
        return;
      case "paint":
        if (message.theme && typeof message.theme === "object") paint(message.theme).catch(() => {}).then(() => ack(message.seq));
        return;
    }
    ack(message.seq);
  });
  document.addEventListener("pointerover", (event) => {
    if (!connected || !inspector) return;
    const element = owner(event.target);
    const id = element ? valid(element.getAttribute(MARK)) : null;
    if (id !== hovered) {
      hovered = id;
      post({ type: "hover", id });
    }
  }, true);
  document.documentElement.addEventListener("pointerleave", () => {
    if (hovered === null) return;
    hovered = null;
    post({ type: "hover", id: null });
  });
  // With the inspector on, a click selects its part and does nothing else.
  document.addEventListener("click", (event) => {
    if (!connected || !inspector) return;
    const element = owner(event.target);
    const id = element && valid(element.getAttribute(MARK));
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    post({ type: "select", id });
  }, true);
  document.addEventListener("submit", (event) => {
    if (connected && inspector) event.preventDefault();
  }, true);
  // The editor's shortcuts work while the frame has focus.
  document.addEventListener("keydown", (event) => {
    if (!connected) return;
    const target = event.target;
    if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]")) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const mod = event.ctrlKey || event.metaKey;
    // Without the inspector the page keeps its own keys; only shortcuts with Ctrl or Cmd reach the editor.
    if (!KEYS.includes(key) || (!mod && (!inspector || (key.length === 1 && key !== "\\\\")))) return;
    event.preventDefault();
    post({ type: "key", key, mod, shift: event.shiftKey, alt: event.altKey });
  }, true);
  window.addEventListener("scroll", report, { passive: true });
  window.addEventListener("resize", report);
  post({ type: "hello", path: location.pathname });
})();`;
}
