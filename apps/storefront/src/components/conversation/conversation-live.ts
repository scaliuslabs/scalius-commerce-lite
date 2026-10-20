// One private, bounded read loop for the visible buyer thread. No staff socket,
// token storage, client message rendering, or read acknowledgment on arrival.
import { pagePath } from "@/lib/presence-url";
import { groupConversationMessages } from "@scalius/shared/conversation-grouping";
import { conversationCopy, conversationStatusLabel } from "@/lib/account-inbox";
import { formatCount, pageLanguage } from "@/lib/store-time-zone";
import { pluralCategory } from "@scalius/shared/locale-words";

/** The page's language goes with every read, so the rows the server renders match the page. */
export function withPageLanguage(url: URL): URL {
  url.searchParams.set("lang", pageLanguage());
  return url;
}

export interface ConversationItem { id: string; seq: number; html: string }
interface Update { conversationId: string | null; items: ConversationItem[]; hasNewer?: boolean; hasOlder?: boolean; readSeq?: number; status?: "open" | "pending" | "closed" }
const controllers = new Map<HTMLElement, { sent: (update: Update) => void; stop: () => void }>();
const seqOf = (node: Element) => Number((node as HTMLElement).dataset.seq) || 0;
const rowsOf = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>(":scope > [data-seq]")];

function presentRows(list: HTMLElement): void {
  const rows = rowsOf(list);
  const days = new Map(rows.map((row) => [Number(row.dataset.created) || 0, row.dataset.day ?? ""]));
  groupConversationMessages(rows.map((row) => ({ row, seq: seqOf(row), kind: row.dataset.kind ?? "message", authorType: row.dataset.from ?? "store", visibility: "public", createdAt: Number(row.dataset.created) || 0 })), {
    dayKey: (time) => days.get(time) ?? "",
  }).forEach(({ message: { row }, showAuthor, startsDay, groupStart }) => {
    const author = row.querySelector<HTMLElement>("[data-message-author]");
    const day = row.querySelector<HTMLElement>("[data-message-day]");
    if (author) author.hidden = !showAuthor;
    if (day) day.hidden = !startsDay;
    row.classList.toggle("mt-4", groupStart); row.classList.toggle("mt-1", !groupStart);
    const body = row.querySelector<HTMLElement>("[data-message-body]");
    const expand = row.querySelector<HTMLButtonElement>("[data-message-expand]");
    if (body && expand && !body.dataset.clampReady) {
      body.dataset.clampReady = "true";
      body.classList.add("line-clamp-[14]");
      expand.hidden = body.scrollHeight <= body.clientHeight + 1;
      if (expand.hidden) body.classList.remove("line-clamp-[14]");
    }
  });
}

/** Abort composition without requiring Safari's newer static AbortSignal APIs. */
export function conversationRequest(ms: number, ...signals: AbortSignal[]) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, ms);
  for (const signal of signals) signal.aborted ? abort() : signal.addEventListener("abort", abort, { once: true });
  return { signal: controller.signal, done: () => { clearTimeout(timer); signals.forEach((signal) => signal.removeEventListener("abort", abort)); } };
}

/** Refuse malformed rows and deduplicate immutable messages without replacing history. */
export function appendConversationItems(list: HTMLElement, items: ConversationItem[], after: number): HTMLElement[] {
  const ids = new Set(rowsOf(list).map((node) => node.dataset.messageId));
  const added: HTMLElement[] = [];
  let cursor = after;
  for (const item of [...items].sort((a, b) => a.seq - b.seq)) {
    if (!Number.isSafeInteger(item.seq) || item.seq <= cursor || ids.has(item.id) || typeof item.html !== "string") continue;
    const template = document.createElement("template");
    template.innerHTML = item.html.trim();
    const row = template.content.firstElementChild;
    if (template.content.children.length !== 1 || !(row instanceof HTMLElement) || row.tagName !== "LI"
      || seqOf(row) !== item.seq || row.dataset.messageId !== item.id) continue;
    row.querySelectorAll<HTMLAnchorElement>("a[href^='/']").forEach((link) => { link.href = pagePath(link.getAttribute("href")!); });
    list.append(row);
    ids.add(item.id);
    cursor = item.seq;
    added.push(row);
  }
  if (added.length) list.hidden = false;
  if (list.isConnected) presentRows(list);
  return added;
}

function bindLive(list: HTMLElement): void {
  if (controllers.has(list)) return;
  const source = list.dataset.liveSrc;
  const readSource = list.dataset.readSrc;
  if (!source || !readSource) return;
  const lifetime = new AbortController();
  presentRows(list);
  const panel = list.closest<HTMLElement>("[data-conversation-panel]") ?? list.parentElement!;
  const scroller = list.closest<HTMLElement>("[data-conversation-scroller]");
  // The short-height fallback uses document flow, even though the pane exists.
  const scrollPane = () => scroller && getComputedStyle(scroller).overflowY === "auto" ? scroller : null;
  const pinned = () => { const pane = scrollPane(); return !!pane && pane.scrollHeight - pane.scrollTop - pane.clientHeight < 24; };
  let following = false;
  const shift = (delta: number) => { const pane = scrollPane(); if (pane) pane.scrollTop += delta; else window.scrollBy(0, delta); };
  const reveal = (row: HTMLElement, center = false) => {
    const pane = scrollPane();
    if (pane) pane.scrollTop += row.getBoundingClientRect().top - pane.getBoundingClientRect().top - (center ? Math.max(0, (pane.clientHeight - row.offsetHeight) / 2) : 0);
    else row.scrollIntoView({ block: center ? "center" : "nearest" });
  };
  const status = panel.querySelector<HTMLElement>("[data-conversation-live-status]");
  const jump = panel.querySelector<HTMLButtonElement>("[data-conversation-new]");
  let cursor = Math.max(0, ...rowsOf(list).map(seqOf));
  let marked = Number(list.dataset.readSeq) || 0;
  let seen = marked;
  let threadId = list.dataset.conversationId || null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let readTimer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  let marking = false;
  let readDisabled = false;
  let readRetryAt = 0;
  let readFailures = 0;
  let stopped = false;
  let visible = true;
  let lastInput = Date.now();
  let hotUntil = 0;
  let lastRequest = 0;
  let retryAt = 0;
  let failures = 0;
  let historyLoading = false;
  let catchupPages = 0;
  const unseen = new Set<HTMLElement>();
  let messageNotice = "";
  const active = () => !stopped && !lifetime.signal.aborted && list.isConnected && document.visibilityState !== "hidden" && navigator.onLine !== false;
  const displayStatus = (text: string) => { if (status && status.textContent !== text) status.textContent = text; };
  const copy = conversationCopy();
  const updateJump = () => {
    if (jump) jump.hidden = unseen.size === 0;
    if (unseen.size) {
      const template = pluralCategory(unseen.size, pageLanguage()) === "one" ? copy.newMessageCount.one : copy.newMessageCount.other;
      const label = template.replace("{count}", formatCount(unseen.size));
      if (jump && jump.textContent !== label) jump.textContent = label;
      messageNotice = copy.newFromStore.replace("{count}", label);
      displayStatus(messageNotice);
    } else if (status?.textContent === messageNotice) displayStatus("");
  };
  const notice = (text: string) => {
    stopped = true;
    clearTimeout(timer);
    displayStatus(text);
    const reload = panel.querySelector<HTMLElement>("[data-conversation-reload]");
    if (reload) reload.hidden = false;
  };

  const flushRead = async () => {
    if (!active() || marking || readDisabled || seen <= marked || Date.now() < readRetryAt) return;
    const seq = seen;
    marking = true;
    const pending = conversationRequest(10_000, lifetime.signal);
    let success = false;
    try {
      const response = await fetch(pagePath(readSource), {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ seq }), signal: pending.signal,
      });
      if (response.ok) { marked = Math.max(marked, seq); success = true; readFailures = 0; }
      else if (response.status >= 400 && response.status < 500 && response.status !== 429) readDisabled = true;
      else readRetryAt = Date.now() + Math.min(120_000, (response.status === 429 ? 30_000 : 10_000) * 2 ** readFailures++);
    } catch { readRetryAt = Date.now() + Math.min(120_000, 10_000 * 2 ** readFailures++); }
    finally {
      pending.done(); marking = false;
      if (success && seen > marked) { clearTimeout(readTimer); readTimer = setTimeout(() => void flushRead(), 750); }
    }
  };
  const trackVisible = () => {
    if (!active()) return;
    const viewport = window.visualViewport;
    let top = viewport?.offsetTop ?? 0;
    let bottom = top + (viewport?.height ?? window.innerHeight);
    const pane = scrollPane();
    if (pane) { const bounds = pane.getBoundingClientRect(); top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
    const height = Math.max(0, bottom - top);
    for (const row of rowsOf(list)) {
      const box = row.getBoundingClientRect();
      // Long messages count when at least half a screen of their content is visible.
      const overlap = Math.min(box.bottom, bottom) - Math.max(box.top, top);
      if (height > 0 && box.height > 0 && overlap >= Math.min(box.height, height) / 2) {
        seen = Math.max(seen, seqOf(row));
        unseen.delete(row);
      }
    }
    updateJump();
    clearTimeout(readTimer);
    readTimer = setTimeout(() => void flushRead(), 750);
  };
  const messageObserver = typeof IntersectionObserver === "function" ? new IntersectionObserver(trackVisible, { root: scroller, threshold: [0, 0.5, 1] }) : null;
  rowsOf(list).forEach((row) => messageObserver?.observe(row));

  const merge = (update: Update, sent = false) => {
    if (threadId && update.conversationId && threadId !== update.conversationId) {
      notice(copy.changedReload);
      return;
    }
    threadId ??= update.conversationId;
    marked = Math.max(marked, update.readSeq ?? 0);
    if (update.status === "open" || update.status === "pending" || update.status === "closed") {
      (panel.closest("[data-account-workspace]") ?? panel).querySelectorAll<HTMLElement>("[data-conversation-thread-status]").forEach((node) => { node.textContent = conversationStatusLabel(update.status!); });
      const closed = panel.querySelector<HTMLElement>("[data-conversation-closed]");
      if (closed) closed.hidden = update.status !== "closed";
    }
    const pane = scrollPane();
    const wasPinned = pinned();
    const anchor = list.nextElementSibling;
    const before = anchor?.getBoundingClientRect().top;
    const compensate = list.getBoundingClientRect().bottom <= window.innerHeight;
    const added = appendConversationItems(list, update.items, cursor);
    if (!added.length) return;
    cursor = Math.max(cursor, ...added.map(seqOf));
    hotUntil = Date.now() + 120_000;
    if (!pane && compensate && before !== undefined && anchor) window.scrollBy(0, anchor.getBoundingClientRect().top - before);
    for (const row of added) {
      messageObserver?.observe(row);
      if (row.dataset.from !== "buyer") unseen.add(row);
    }
    if (pane && (wasPinned || sent)) pane.scrollTop = pane.scrollHeight;
    else if (sent) added.at(-1)?.scrollIntoView({ block: "nearest" });
    following = pinned();
    trackVisible();
  };
  const schedule = (delay?: number) => {
    clearTimeout(timer);
    timer = undefined;
    if (!active() || Date.now() - lastInput > 30 * 60_000) return;
    const idle = Date.now() - lastInput > 5 * 60_000;
    const next = delay ?? (!visible || idle ? 60_000 : Date.now() < hotUntil ? 4_000 : 10_000);
    timer = setTimeout(() => { timer = undefined; void poll(); }, Math.max(retryAt - Date.now(), delay === undefined ? next * (0.85 + Math.random() * 0.3) : next));
  };
  const poll = async () => {
    if (!active() || request) return;
    const current = new AbortController();
    request = current;
    lastRequest = Date.now();
    const startedAt = cursor;
    const pending = conversationRequest(10_000, current.signal, lifetime.signal);
    let delay: number | undefined;
    try {
      const url = withPageLanguage(new URL(pagePath(source), window.location.origin));
      url.searchParams.set("afterSeq", String(startedAt));
      const response = await fetch(url, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" }, signal: pending.signal });
      if (!active() || current.signal.aborted) return;
      if ([401, 403, 404].includes(response.status)) {
        notice(response.status === 401 ? copy.signInToReceive : copy.noLongerHere);
        return;
      }
      if (response.status === 429) {
        const retry = response.headers.get("Retry-After");
        const seconds = Number(retry);
        delay = Math.max(30_000, Number.isFinite(seconds) ? seconds * 1_000 : Math.max(0, Date.parse(retry ?? "") - Date.now()) || 30_000);
        retryAt = Date.now() + delay;
        return;
      }
      if (!response.ok) throw new Error("unavailable");
      const answer = await response.json() as { success?: boolean; data?: Update };
      if (!active() || current.signal.aborted) return;
      if (!answer.success || !answer.data || !Array.isArray(answer.data.items)) throw new Error("unavailable");
      merge(answer.data);
      trackVisible();
      failures = 0;
      if (answer.data.hasNewer) {
        catchupPages += 1;
        if (catchupPages >= 4 || cursor <= startedAt) notice(copy.moreAvailable);
        else delay = 0;
      } else catchupPages = 0;
    } catch {
      if (!current.signal.aborted && !lifetime.signal.aborted) delay = Math.min(120_000, 10_000 * 2 ** failures++);
    } finally {
      pending.done();
      if (request === current) request = undefined;
      schedule(delay);
    }
  };
  const wake = () => {
    if (!active()) { clearTimeout(timer); timer = undefined; request?.abort(); return; }
    trackVisible();
    schedule(Math.max(0, 2_000 - (Date.now() - lastRequest)));
  };
  const input = () => { lastInput = Date.now(); if (!timer && !request) wake(); };
  const panelObserver = typeof IntersectionObserver === "function" ? new IntersectionObserver(([entry]) => {
    const entered = !visible && entry?.isIntersecting;
    visible = entry?.isIntersecting ?? false;
    if (entered) wake();
  }) : null;
  panelObserver?.observe(panel);
  const on = (target: EventTarget, type: string, listener: EventListener) => target.addEventListener(type, listener, { signal: lifetime.signal, passive: true });
  const earlier = panel.querySelector<HTMLAnchorElement>("[data-conversation-earlier]");
  earlier?.addEventListener("click", async (event) => {
    event.preventDefault();
    if (historyLoading || !active()) return;
    historyLoading = true;
    earlier.setAttribute("aria-busy", "true");
    const pending = conversationRequest(10_000, lifetime.signal);
    try {
      const url = withPageLanguage(new URL(pagePath(source), window.location.origin));
      url.searchParams.set("beforeSeq", earlier.dataset.before ?? "");
      const response = await fetch(url, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" }, signal: pending.signal });
      const answer = await response.json() as { success: boolean; data: Update };
      if (!active()) return;
      if (!response.ok || !answer.success || !Array.isArray(answer.data.items)) throw new Error("unavailable");
      if (threadId && answer.data.conversationId !== threadId) { notice(copy.changedReload); return; }
      const first = rowsOf(list)[0];
      const before = first?.getBoundingClientRect().top ?? 0;
      const held = document.createElement("ol");
      const ids = new Set(rowsOf(list).map((row) => row.dataset.messageId));
      const rows = appendConversationItems(held, answer.data.items.filter((item) => !ids.has(item.id) && (!first || item.seq < seqOf(first))), 0);
      list.prepend(...rows);
      presentRows(list);
      rows.forEach((row) => messageObserver?.observe(row));
      const minSeq = Math.min(...rowsOf(list).map(seqOf));
      earlier.dataset.before = String(minSeq);
      const href = new URL(earlier.href);
      href.searchParams.set(earlier.dataset.beforeParam ?? "before", String(minSeq));
      earlier.href = href.toString();
      earlier.hidden = answer.data.hasOlder !== true;
      if (first) shift(first.getBoundingClientRect().top - before);
      following = pinned();
      displayStatus(copy.earlierLoaded);
    } catch { if (!lifetime.signal.aborted) displayStatus(copy.earlierFailed); }
    finally { pending.done(); historyLoading = false; earlier.removeAttribute("aria-busy"); }
  }, { signal: lifetime.signal });
  list.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-message-expand]");
    const body = button?.previousElementSibling;
    if (!button || !(body instanceof HTMLElement)) return;
    const before = button.getBoundingClientRect().top;
    const collapsed = body.classList.toggle("line-clamp-[14]");
    button.textContent = collapsed ? button.dataset.showMore ?? copy.showMore : button.dataset.showLess ?? copy.showLess;
    if (collapsed) shift(button.getBoundingClientRect().top - before);
    following = pinned();
  }, { signal: lifetime.signal });
  const imageFailed = (image: HTMLImageElement) => {
    image.hidden = true;
    const fallback = image.parentElement?.querySelector<HTMLElement>("[data-message-image-error]");
    if (fallback) fallback.hidden = false;
  };
  list.addEventListener("error", (event) => { if (event.target instanceof HTMLImageElement) imageFailed(event.target); }, { capture: true, signal: lifetime.signal });
  list.querySelectorAll<HTMLImageElement>("[data-message-image]").forEach((image) => { if (image.complete && image.naturalWidth === 0) imageFailed(image); });
  on(document, "visibilitychange", wake);
  on(window, "focus", wake);
  on(window, "online", wake);
  on(window, "offline", wake);
  on(window, "scroll", () => { input(); trackVisible(); });
  if (scroller) on(scroller, "scroll", () => { following = pinned(); input(); trackVisible(); });
  if (window.visualViewport) {
    on(window.visualViewport, "resize", trackVisible);
    on(window.visualViewport, "scroll", trackVisible);
  }
  const resize = scroller && typeof ResizeObserver === "function" ? new ResizeObserver(() => {
    const pane = scrollPane();
    if (pane && following) pane.scrollTop = pane.scrollHeight;
    trackVisible();
  }) : null;
  resize?.observe(list);
  if (scroller) resize?.observe(scroller);
  on(panel, "input", input);
  on(document, "pointerdown", input);
  on(document, "keydown", input);
  jump?.addEventListener("click", () => { const row = unseen.values().next().value; if (row) reveal(row, true); following = pinned(); trackVisible(); }, { signal: lifetime.signal });
  const stop = () => {
    lifetime.abort(); request?.abort(); clearTimeout(timer); clearTimeout(readTimer);
    messageObserver?.disconnect(); panelObserver?.disconnect(); resize?.disconnect(); controllers.delete(list);
  };
  on(window, "customer-logout", () => { stop(); list.replaceChildren(); });
  on(window, "customer-login", () => { stop(); list.replaceChildren(); displayStatus(copy.accountChangedRead); });
  controllers.set(list, {
    stop,
    sent: (update) => {
      hotUntil = Date.now() + 120_000;
      lastInput = Date.now();
      // A latest-page POST answer can omit a gap. Only merge if it overlaps what
      // we have, or contains the complete history; otherwise catch up by cursor.
      if (update.hasOlder === false || update.items.some((item) => item.seq <= cursor)) merge(update, true);
      wake();
    },
  });
  const initialPane = scrollPane();
  if (initialPane) {
    const firstUnread = rowsOf(list).find((row) => row.dataset.from === "store" && seqOf(row) > marked);
    if (firstUnread) reveal(firstUnread);
    else initialPane.scrollTop = initialPane.scrollHeight;
    following = pinned();
  }
  schedule(0);
  trackVisible();
}

export function notifyConversationSent(list: HTMLElement, update: Update): boolean {
  const controller = controllers.get(list);
  if (!controller) return false;
  controller.sent(update);
  return true;
}
export function bindConversationLive(): void {
  document.querySelectorAll<HTMLElement>("[data-live-src]").forEach(bindLive);
}
export function stopConversationLive(): void { for (const controller of [...controllers.values()]) controller.stop(); }
