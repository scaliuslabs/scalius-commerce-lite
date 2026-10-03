/**
 * The theme editor's bridge: a small inline script the Layout adds to a
 * page only while a valid theme preview renders it (never to a buyer's
 * page, so buyers pay nothing). Inside the dashboard's editor frame it says
 * hello to the dashboard origin from Platform settings and, once the editor
 * answers, outlines sections on hover, reports clicks as selections,
 * follows the editor's highlight, selection and scrolling, re-renders
 * single sections from the preview-only section route and reloads (keeping
 * the scroll position) when the editor asks. Messages are read only from
 * the parent window at the dashboard's exact origin, and sent only there.
 */
import { THEME_EDITOR_SOURCE, THEME_PREVIEW_SOURCE } from "@scalius/shared/theme-editor-bridge";
import { serializeJsonForInlineScript } from "@/lib/safe-json";

/** The route that renders one section of the draft homepage (theme-preview/section.astro). */
export const THEME_PREVIEW_SECTION_PATH = "/theme-preview/section";
const SCROLL_KEY = "scalius-theme-preview-scroll";

/** The bridge for a dashboard origin; "" (no script) without a valid one. */
export function themePreviewBridgeScript(dashboardOrigin: string): string {
  if (!dashboardOrigin) return "";
  const json = serializeJsonForInlineScript;
  return `(() => {
  const DASHBOARD = ${json(dashboardOrigin)};
  const SELF = ${json(THEME_PREVIEW_SOURCE)};
  const EDITOR = ${json(THEME_EDITOR_SOURCE)};
  const SECTION = ${json(THEME_PREVIEW_SECTION_PATH)};
  const SCROLL = ${json(SCROLL_KEY)};
  const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
  const parent = window.parent;
  if (parent === window) return;
  const post = (message) => parent.postMessage(Object.assign({ source: SELF }, message), DASHBOARD);
  const valid = (id) => typeof id === "string" && ID.test(id) ? id : null;
  const find = (id) => document.querySelector('[data-theme-section-id="' + id + '"]');
  const owner = (target) => target instanceof Element ? target.closest("[data-theme-section-id]") : null;
  let names = {};
  let connected = false;
  let selected = null;
  let hovered = null;
  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.style.cssText = "position:absolute;top:0;left:0;width:0;height:0;z-index:2147483646;pointer-events:none";
  const outline = (style) => {
    const box = document.createElement("div");
    box.style.cssText = "position:absolute;display:none;box-sizing:border-box;border:2px " + style + " #2c6ecb;border-radius:2px";
    const tag = document.createElement("span");
    tag.style.cssText = "position:absolute;left:-2px;padding:2px 8px;border-radius:4px 4px 0 0;background:#2c6ecb;color:#fff;font:600 12px/18px system-ui,sans-serif;white-space:nowrap";
    box.append(tag);
    layer.append(box);
    return { box, tag };
  };
  const hover = outline("dashed");
  const pick = outline("solid");
  // A mark may be display:contents: measure what it holds.
  const rect = (element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const box = range.getBoundingClientRect();
    return box.width || box.height ? box : element.getBoundingClientRect();
  };
  const place = (frame, id) => {
    const element = id ? find(id) : null;
    if (!element) {
      frame.box.style.display = "none";
      return;
    }
    const box = rect(element);
    frame.box.style.display = "block";
    frame.box.style.top = box.top + window.scrollY + "px";
    frame.box.style.left = box.left + window.scrollX + "px";
    frame.box.style.width = box.width + "px";
    frame.box.style.height = box.height + "px";
    frame.tag.textContent = typeof names[id] === "string" ? names[id] : "";
    frame.tag.style.top = box.top + window.scrollY < 22 ? "0" : "-22px";
  };
  let queued = false;
  const draw = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      place(hover, connected && hovered !== selected ? hovered : null);
      place(pick, connected ? selected : null);
    });
  };
  const reload = () => {
    try { sessionStorage.setItem(SCROLL, String(window.scrollY)); } catch {}
    location.reload();
    return false;
  };
  // One section again from the saved draft; anything that moved the page reloads it.
  const swap = async (id) => {
    const current = find(id);
    const unit = current && current.closest("[data-home-render-unit]");
    if (!unit) return reload();
    // A landing page (/pages/<slug>) swaps its own sections; anything else is the homepage.
    const segments = location.pathname.split("/").filter(Boolean);
    const page = segments.length === 2 && segments[0] === "pages" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segments[1]) ? segments[1] : null;
    const response = await fetch(SECTION + "?id=" + encodeURIComponent(id) + (page ? "&page=" + encodeURIComponent(page) : ""), {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "text/html" },
    });
    if (response.status === 401) {
      post({ type: "expired" });
      return false;
    }
    if (!response.ok) return reload();
    const template = document.createElement("template");
    template.innerHTML = await response.text();
    const wrap = template.content.querySelector("[data-theme-preview-unit]");
    const pageLayout = document.querySelector("[data-theme-preview-layout]");
    const next = wrap && wrap.firstElementChild;
    if (!wrap || !pageLayout || !next || wrap.getAttribute("data-theme-preview-layout") !== pageLayout.getAttribute("data-theme-preview-layout")) return reload();
    // Sections with scripts are set up when the page loads: load it again.
    if (next.querySelector("script")) return reload();
    unit.replaceWith(next);
    draw();
    return true;
  };
  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.origin !== DASHBOARD) return;
    const message = event.data;
    if (!message || typeof message !== "object" || message.source !== EDITOR) return;
    switch (message.type) {
      case "connect":
        names = message.names && typeof message.names === "object" ? message.names : {};
        selected = valid(message.selected);
        if (!connected) {
          connected = true;
          const sections = Array.from(document.querySelectorAll("[data-theme-section-id]"), (element) => element.getAttribute("data-theme-section-id"));
          post({ type: "ready", path: location.pathname, sections: sections.filter((id) => valid(id)) });
        }
        draw();
        break;
      case "highlight":
        hovered = valid(message.sectionId);
        draw();
        break;
      case "select":
        selected = valid(message.sectionId);
        draw();
        break;
      case "scroll-to": {
        const element = valid(message.sectionId) && find(message.sectionId);
        if (element) {
          window.scrollTo({
            top: rect(element).top + window.scrollY - 16,
            behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
          });
        }
        break;
      }
      case "section-updated":
        if (Array.isArray(message.sectionIds)) {
          (async () => {
            for (const id of message.sectionIds) {
              if (!valid(id) || !(await swap(id))) break;
            }
          })().catch(reload);
        }
        break;
      case "reload":
        reload();
        break;
      case "go-home":
        location.assign("/");
        break;
    }
  });
  document.addEventListener("pointerover", (event) => {
    if (!connected) return;
    const element = owner(event.target);
    const id = element ? element.getAttribute("data-theme-section-id") : null;
    if (id !== hovered) {
      hovered = id;
      draw();
    }
  }, true);
  document.documentElement.addEventListener("pointerleave", () => {
    hovered = null;
    draw();
  });
  // A click selects its section; links inside sections stay put while editing.
  document.addEventListener("click", (event) => {
    if (!connected) return;
    const element = owner(event.target);
    const id = element && valid(element.getAttribute("data-theme-section-id"));
    if (!id) return;
    if (event.target instanceof Element && event.target.closest("a[href]")) event.preventDefault();
    selected = id;
    draw();
    post({ type: "select", sectionId: id });
  }, true);
  window.addEventListener("scroll", draw, { passive: true });
  window.addEventListener("resize", draw);
  if ("ResizeObserver" in window) new ResizeObserver(draw).observe(document.body);
  document.body.append(layer);
  try {
    const top = sessionStorage.getItem(SCROLL);
    if (top !== null) {
      sessionStorage.removeItem(SCROLL);
      window.scrollTo(0, Number(top) || 0);
    }
  } catch {}
  post({ type: "hello", path: location.pathname });
})();`;
}
