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
  THEME_APP_TEXT_FIELD,
  THEME_EDITOR_SOURCE,
  THEME_TEXT_FIELDS,
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
  const FIELD = "data-theme-field";
  const FIELDS = ${json(THEME_TEXT_FIELDS)};
  const APP_FIELD = new RegExp(${json(THEME_APP_TEXT_FIELD.source)});
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
  let selectedField = null;
  // An app section's fields are its setting keys (the SDK's editable()); a platform section's are named.
  const appSection = (section) => section.getAttribute("data-home-section") === "app";
  const allowed = (section, field) => typeof field === "string" && (appSection(section) ? APP_FIELD.test(field) : FIELDS.includes(field));
  const fieldElement = (id, field) => {
    const section = valid(id) && find(id);
    if (!section || !allowed(section, field)) return null;
    const found = Array.from(section.querySelectorAll("[" + FIELD + '="' + field + '"]')).filter((element) => owner(element) === section);
    return found.length === 1 ? found[0] : null;
  };
  const fieldAt = (target, section) => {
    const element = target instanceof Element && target.closest("[" + FIELD + "]");
    const field = element && element.getAttribute(FIELD);
    return element && owner(element) === section && allowed(section, field) ? field : null;
  };
  // A mark may be display:contents: measure what it holds. Any other mark is
  // its own box (what it holds may overflow it: a sticky bar, a popover).
  // A nested display:contents element (an app component's wrapper) has no
  // box of its own, so a Range over the mark would skip what it holds: the
  // children's boxes are unioned, descending through such wrappers.
  const box = (element) => {
    if (getComputedStyle(element).display !== "contents") return element.getBoundingClientRect();
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const child of element.children) {
      // A fixed bar (an order bar on phones) is the viewport's, not the section's.
      if (getComputedStyle(child).position === "fixed") continue;
      const rect = box(child);
      if (!rect.width && !rect.height) continue;
      left = Math.min(left, rect.left); top = Math.min(top, rect.top);
      right = Math.max(right, rect.right); bottom = Math.max(bottom, rect.bottom);
    }
    if (right > left || bottom > top) return new DOMRect(left, top, right - left, bottom - top);
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
    let field = null;
    const element = selectedField && fieldElement(selectedField.id, selectedField.field);
    if (element && !element.closest("[hidden]")) {
      const rect = box(element);
      if (rect.width > 0 && rect.height > 0) field = { ...selectedField, rect: [rect.left, rect.top, rect.width, rect.height] };
    }
    post({ type: "layout", rects, field, scrollY: Math.round(window.scrollY), height: document.documentElement.scrollHeight });
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
    post({ type: "ready", path: location.pathname, marks: marks(), fields: 1 });
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
  const patchText = (id, field, value) => {
    // Bodies own paragraph children. Unknown/absent/duplicate targets await the
    // canonical render already scheduled by the dashboard, without guessing.
    if (typeof value !== "string" || !value.trim() || value.length > 8000) return;
    const element = fieldElement(id, field);
    if (!element || (field === "body" && !appSection(find(id)))) return;
    element.textContent = value;
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
  let latestRevision = 0;
  const fresh = (revision) => revision === 0 || revision >= latestRevision;
  const render = async (body, revision) => {
    const key = body && typeof body.only === "string" ? "unit:" + body.only : "regions";
    const ticket = (latest[key] = (latest[key] || 0) + 1);
    const response = await send(RENDER, body, "text/html");
    if (ticket !== latest[key] || !fresh(revision)) return "stale";
    if (!response) return false;
    const template = document.createElement("template");
    template.innerHTML = await response.text();
    if (ticket !== latest[key] || !fresh(revision)) return "stale";
    // An app section, skin or block the editor just added brings its app's
    // stylesheet: link the ones the head lacks before the markup lands.
    const linked = new Set(Array.from(document.head.querySelectorAll("link[data-app-stylesheet]"), (link) => link.getAttribute("href")));
    for (const link of Array.from(template.content.querySelectorAll("link[data-app-stylesheet]"))) {
      const href = link.getAttribute("href");
      if (href && href.startsWith("/_x/") && !linked.has(href)) {
        linked.add(href);
        document.head.append(link);
      } else link.remove();
    }
    const regions = Array.from(template.content.querySelectorAll("[data-theme-region]"));
    if (regions.some((fresh) => !document.querySelector('[data-theme-region="' + fresh.getAttribute("data-theme-region") + '"]'))) return false;
    for (const fresh of regions) {
      document.querySelector('[data-theme-region="' + fresh.getAttribute("data-theme-region") + '"]').replaceWith(fresh);
      activate(fresh);
    }
    const unit = template.content.querySelector("[data-home-render-unit]");
    if (typeof body.only === "string" && !unit) {
      // Losing a visible unit can merge banner rows. Keep its slot until the
      // editor reconciles canonical regions; a newer empty edit must still resync.
      const current = unitOf(find(body.only));
      if (current && !current.hidden) return "stale";
    } else if (unit && !template.content.querySelector("[data-theme-region]")) {
      const current = unitOf(find(body.only));
      // A pending region render may have removed this slot since dispatch.
      // Only canonical regions can split a banner row to restore the section.
      if (!current) return "stale";
      // Unit settings do not move its slot. Data-free renders need not read
      // every sibling merely to recompute this region's phone ordinal.
      const order = current.style.getPropertyValue("--phone-order");
      if (order) unit.style.setProperty("--phone-order", order);
      if (current.hasAttribute("data-phone-order")) unit.setAttribute("data-phone-order", current.getAttribute("data-phone-order"));
      current.replaceWith(unit);
      activate(unit);
    }
    observe();
    measure();
    return true;
  };
  let painted = 0;
  const paint = async (theme, revision) => {
    const ticket = ++painted;
    const response = await send(PAINT, { theme }, "application/json");
    if (ticket !== painted || !fresh(revision)) return "stale";
    if (!response) return false;
    const result = await response.json();
    if (ticket !== painted || !fresh(revision)) return "stale";
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
    return true;
  };
  // A transport retry reuses the in-flight work or its completed acknowledgement.
  const inflight = new Set();
  const completed = new Map();
  const asynchronous = (message, task) => {
    const seq = Number.isSafeInteger(message.seq) && message.seq > 0 ? message.seq : null;
    if (seq !== null && completed.has(seq)) return ack(seq, completed.get(seq));
    if (seq !== null && inflight.has(seq)) return;
    if (seq !== null) inflight.add(seq);
    Promise.resolve().then(task).catch(() => false).then((result) => {
      const extra = result === "stale" ? { status: "stale" }
        : result !== true ? { status: "failed" }
        : message.type === "render" ? { marks: marks() } : undefined;
      if (result !== true && result !== "stale") post({ type: "render-failed" });
      if (seq !== null) {
        inflight.delete(seq);
        completed.set(seq, extra);
        if (completed.size > 64) completed.delete(completed.keys().next().value);
      }
      ack(message.seq, extra);
    });
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
    const edits = ["tokens", "text", "arrange", "render", "paint"].includes(message.type);
    if (message.revision !== undefined && (!Number.isSafeInteger(message.revision) || message.revision <= 0)) return;
    const revision = message.revision || 0;
    if (edits) {
      if (!fresh(revision)) return ack(message.seq, { status: "stale" });
      latestRevision = Math.max(latestRevision, revision);
    }
    switch (message.type) {
      case "inspector":
        inspector = message.on === true;
        if (!inspector) { selectedField = null; post({ type: "hover", id: null }); report(); }
        break;
      case "reveal":
        if (valid(message.id)) reveal(message.id);
        break;
      case "field":
        // Checked against its section when measured (the section may draw later).
        selectedField = message.target && valid(message.target.id) && typeof message.target.field === "string"
          && (FIELDS.includes(message.target.field) || APP_FIELD.test(message.target.field))
          ? { id: message.target.id, field: message.target.field } : null;
        report();
        break;
      case "tokens":
        tokens(message.vars);
        break;
      case "text":
        if (valid(message.id)) patchText(message.id, message.field, message.value);
        break;
      case "arrange":
        if (valid(message.region)) arrange(message.region, message.order);
        break;
      case "render":
        // Acknowledged once it landed or failed (a failure also says render-failed).
        if (message.body && typeof message.body === "object") {
          asynchronous(message, () => render(message.body, revision));
        }
        return;
      case "paint":
        if (message.theme && typeof message.theme === "object") asynchronous(message, () => paint(message.theme, revision));
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
    const field = fieldAt(event.target, element);
    selectedField = field ? { id, field } : null;
    post({ type: "select", id, ...(field ? { field } : {}) });
    report();
  }, true);
  document.addEventListener("dblclick", (event) => {
    if (!connected || !inspector) return;
    const element = owner(event.target);
    const id = element && valid(element.getAttribute(MARK));
    const field = id && fieldAt(event.target, element);
    const target = field && fieldElement(id, field);
    if (!target || target.closest("[hidden]")) return;
    const rect = box(target);
    if (rect.width <= 0 || rect.height <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    // The first gesture must not wait for the queued selection layout.
    post({ type: "edit-text", id, field, rect: [rect.left, rect.top, rect.width, rect.height] });
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
    if (key === "Enter" && !selectedField) return;
    event.preventDefault();
    post({ type: "key", key, mod, shift: event.shiftKey, alt: event.altKey });
  }, true);
  window.addEventListener("scroll", report, { passive: true });
  window.addEventListener("resize", report);
  post({ type: "hello", path: location.pathname });
})();`;
}
