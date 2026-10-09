// Browser-side half of the dashboard quality harness. These functions run in
// the page (Playwright serialises them), so each is self-contained and returns
// plain data. The judgments live in analysis.mjs, where unit tests reach them.

/** Added before the page's own scripts: first paint, skeletons and when the content settled. */
export const TIMING_INIT = () => {
  const state = (window.__adminQuality = {
    fcp: null,
    settledAt: null,
    skeletonSeen: false,
    skeletonHeight: 0,
    finalHeight: 0,
    mainTextAt: null,
  });
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (entry.name === "first-contentful-paint") state.fcp = entry.startTime;
    }).observe({ type: "paint", buffered: true });
  } catch {
    // No paint timing: the first render reads as unknown.
  }
  const SKELETON = ".animate-pulse,[aria-busy='true']";
  let stableSince = null;
  const tick = () => {
    const now = performance.now();
    const main = document.querySelector("main");
    const height = main ? main.scrollHeight : 0;
    const visibleSkeletons = [...document.querySelectorAll(SKELETON)].filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).length;
    if (visibleSkeletons > 0) {
      state.skeletonSeen = true;
      state.skeletonHeight = height || state.skeletonHeight;
      state.settledAt = null;
      stableSince = null;
    } else if (main && main.innerText.trim().length > 0) {
      state.mainTextAt ??= now;
      state.finalHeight = height;
      if (stableSince === null) stableSince = now;
      if (state.settledAt === null && now - stableSince >= 300) state.settledAt = stableSince;
    } else {
      stableSince = null;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

/** Everything the static rules judge: one pass over the DOM, plain data back. */
export function collectFacts() {
  const describe = (element) => {
    if (!element || element.nodeType !== 1) return String(element);
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && parts.length < 4) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(`${part}#${current.id}`);
        break;
      }
      const label = current.getAttribute("aria-label") || (current.tagName === "INPUT" ? current.getAttribute("name") || current.getAttribute("placeholder") : "");
      if (label && parts.length === 0) part += `[${label.slice(0, 30)}]`;
      else {
        const classes = typeof current.className === "string" ? current.className.trim().split(/\s+/).filter((name) => name && !name.includes(":") && !name.includes("[")).slice(0, 2) : [];
        if (classes.length) part += `.${classes.join(".")}`;
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  const visible = (element) => {
    if (!element.isConnected) return false;
    if (element.closest("[inert],[aria-hidden='true'],[hidden]")) return false;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "PATH"]);
  const width = document.documentElement.clientWidth;
  const facts = {
    htmlLang: document.documentElement.getAttribute("lang") ?? "",
    htmlDir: document.documentElement.getAttribute("dir") ?? "",
    page: { scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), clientWidth: width },
    offenders: [],
    containers: [],
    scrollingTables: [],
    controls: [],
    fields: [],
    clips: [],
    texts: [],
    main: { exists: false, textLength: 0, hasMedia: false },
  };

  // Main content.
  const main = document.querySelector("main");
  if (main) {
    facts.main = { exists: true, textLength: main.innerText.trim().length, hasMedia: Boolean(main.querySelector("img,svg,canvas,video,input,textarea,select")) };
  }

  // Elements past the right edge that no clipping or scrolling ancestor holds in.
  const heldIn = (element) => {
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.position === "fixed") return true;
      if (/(hidden|auto|scroll|clip)/.test(style.overflowX)) {
        const rect = parent.getBoundingClientRect();
        if (rect.right <= width + 1 && rect.left >= -1) return true;
      }
    }
    return false;
  };
  const everything = [...document.body.querySelectorAll("*")].filter((element) => !SKIP_TAGS.has(element.tagName.toUpperCase()) && !(element instanceof SVGElement));
  const beyond = everything.filter((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1 || (rect.right <= width + 1 && rect.left >= -1)) return false;
    return getComputedStyle(element).position !== "fixed" && visible(element) && !heldIn(element);
  });
  facts.offenders = beyond.filter((element) => !beyond.includes(element.parentElement)).slice(0, 10).map(describe);

  // Cards and tables that do not hold their content.
  for (const element of document.querySelectorAll(".shadow-card, table")) {
    if (!visible(element)) continue;
    const style = getComputedStyle(element);
    if (element.tagName === "TABLE") {
      const parent = element.parentElement;
      if (!parent) continue;
      const parentStyle = getComputedStyle(parent);
      if (element.offsetWidth > parent.clientWidth + 1) {
        if (/(auto|scroll)/.test(parentStyle.overflowX)) facts.scrollingTables.push({ sel: describe(element), tableWidth: element.offsetWidth, boxWidth: parent.clientWidth });
        else facts.containers.push({ sel: describe(element), contentWidth: element.offsetWidth, boxWidth: parent.clientWidth, overflowX: parentStyle.overflowX });
      }
      continue;
    }
    if (element.scrollWidth > element.clientWidth + 1) {
      if (/(auto|scroll)/.test(style.overflowX)) {
        if (element.querySelector("table")) facts.scrollingTables.push({ sel: describe(element), tableWidth: element.scrollWidth, boxWidth: element.clientWidth });
      } else {
        facts.containers.push({ sel: describe(element), contentWidth: element.scrollWidth, boxWidth: element.clientWidth, overflowX: style.overflowX });
      }
    }
  }

  // Controls and fields, with the section each belongs to.
  const sectionIds = new Map();
  const sectionOf = (element) => {
    const section = element.closest("form, fieldset, [role=dialog], .shadow-card, section, main") ?? document.body;
    if (!sectionIds.has(section)) sectionIds.set(section, sectionIds.size + 1);
    return sectionIds.get(section);
  };
  const controlSelector = "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=color]), select, textarea, [role=combobox], button";
  const excludedAncestors = "table, [role=grid], [role=menu], [role=listbox], [role=toolbar], [role=tablist], nav, aside, header, .ProseMirror, [data-slot=pagination]";
  for (const element of document.querySelectorAll(controlSelector)) {
    if (!visible(element) || element.closest(excludedAncestors)) continue;
    if (element.matches("[role=tab],[role=menuitem],[role=switch],[role=checkbox],[role=radio],[role=option]")) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 24) continue;
    const tag = element.tagName.toLowerCase();
    const isCombobox = element.getAttribute("role") === "combobox";
    const kind = tag === "button" && !isCombobox ? "button" : tag === "select" ? "select" : tag === "textarea" ? "textarea" : isCombobox ? "combobox" : "input";
    const text = (element.textContent ?? "").trim();
    const entry = {
      id: describe(element),
      kind,
      section: sectionOf(element),
      x: rect.left + window.scrollX,
      y: rect.top + window.scrollY,
      w: rect.width,
      h: rect.height,
      iconOnly: kind === "button" && text.length === 0,
    };
    if (kind === "textarea") {
      facts.fields.push(entry);
      continue;
    }
    // A text button in a row, or a field.
    facts.controls.push(entry);
    if (kind !== "button") facts.fields.push(entry);
  }

  // Text that does not fit its box.
  for (const element of everything) {
    if (element.matches("input,textarea,select,option")) continue;
    if (![...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim())) continue;
    if (element.scrollWidth <= element.clientWidth + 2 && element.scrollHeight <= element.clientHeight + 2) continue;
    if (!visible(element)) continue;
    const style = getComputedStyle(element);
    const lineClamp = style.webkitLineClamp && style.webkitLineClamp !== "none" ? Number(style.webkitLineClamp) : 0;
    const rect = element.getBoundingClientRect();
    let hasFullValue = Boolean(element.closest("[title]:not([title=''])") || element.closest("[aria-label]:not([aria-label=''])"));
    if (!hasFullValue) {
      // A label wrapped around a control the label text describes also counts: skip the label's own wrapper.
      hasFullValue = Boolean(element.closest("[data-tooltip],[data-slot=tooltip-trigger]"));
    }
    facts.clips.push({
      sel: describe(element),
      text: element.textContent.trim().slice(0, 60),
      sw: element.scrollWidth,
      cw: element.clientWidth,
      sh: element.scrollHeight,
      ch: element.clientHeight,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      textOverflow: style.textOverflow,
      lineClamp,
      hasFullValue,
      srOnly: rect.width <= 1 || rect.height <= 1 || /\bsr-only\b/.test(String(element.className)),
    });
    if (facts.clips.length >= 200) break;
  }

  // Visible text and the text attributes, for the leak and language rules.
  const dataSelector = "td, [role=gridcell], .rich-content, .ProseMirror, [data-user-content], [contenteditable=true]";
  const codeSelector = "code, kbd, samp, pre";
  const seen = new Set();
  const addText = (text, element, attr) => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return;
    const sel = describe(element);
    const key = `${sel}|${attr ?? ""}|${clean}`;
    if (seen.has(key) || facts.texts.length >= 4000) return;
    seen.add(key);
    facts.texts.push({ text: clean.slice(0, 300), sel: attr ? `${sel} [${attr}]` : sel, data: Boolean(element.closest(dataSelector)), code: Boolean(element.closest(codeSelector)) });
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest("script,style,noscript,template,[hidden]") || !visible(parent)) continue;
    addText(node.textContent ?? "", parent, null);
  }
  for (const element of document.querySelectorAll("[placeholder],[title],[aria-label],img[alt]")) {
    if (!visible(element) || element.closest("script,style")) continue;
    for (const attr of ["placeholder", "title", "aria-label", "alt"]) {
      const value = element.getAttribute(attr);
      if (value) addText(value, element, attr);
    }
  }
  return facts;
}

/** Marks the focused control for the shared visible-focus check, and reports the focus path. */
export function markFocused() {
  const element = document.activeElement;
  if (!element || element === document.body || element === document.documentElement) return { sel: null, offscreen: false, dialog: false };
  element.setAttribute("data-quality-focus", "");
  const rect = element.getBoundingClientRect();
  const label = element.getAttribute("aria-label") || (element.textContent ?? "").trim().slice(0, 30) || element.getAttribute("name") || "";
  return {
    sel: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${label ? ` "${label}"` : ""}`,
    offscreen: rect.width === 0 || rect.height === 0,
    dialog: Boolean(element.closest("[role=dialog],[role=alertdialog]")),
    inDocument: element.isConnected,
  };
}

/**
 * Installs the response probe for one interaction: the first pointer, key or
 * click input time, and the first paint after the first DOM change outside
 * `ignoreSelector`. Read the result with `readResponse`.
 */
export function installResponseProbe({ ignoreSelector }) {
  const probe = (window.__adminResponse = { inputAt: null, changedAt: null, paintedAt: null });
  const onInput = (event) => {
    if (probe.inputAt === null) probe.inputAt = event.timeStamp;
  };
  for (const type of ["pointerdown", "keydown", "click"]) document.addEventListener(type, onInput, { capture: true, once: false });
  const observer = new MutationObserver((records) => {
    if (probe.inputAt === null || probe.changedAt !== null) return;
    const relevant = records.some((record) => {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      return target && !(ignoreSelector && target.closest(ignoreSelector));
    });
    if (!relevant) return;
    probe.changedAt = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      probe.paintedAt = performance.now();
    }));
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  window.__adminResponseStop = () => observer.disconnect();
}

export function readResponse() {
  const probe = window.__adminResponse;
  window.__adminResponseStop?.();
  if (!probe || probe.inputAt === null) return { ms: null, reason: "no input reached the page" };
  if (probe.paintedAt === null) return { ms: null, reason: "the page did not change" };
  return { ms: Math.max(0, probe.paintedAt - probe.inputAt), reason: null };
}
