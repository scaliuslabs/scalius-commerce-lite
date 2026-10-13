import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Loader2, Lock } from "lucide-react";
import { flushSync } from "react-dom";
import { Button } from "~/components/ui/button";
import { commerceCalendarDateKey } from "@scalius/shared/commerce-time";
import { groupConversationMessages } from "@scalius/shared/conversation-grouping";
import { cn } from "@scalius/shared/utils";
import { getStoreTimeZone } from "~/lib/store-time-zone";
import { formatDateTime, useMessages } from "~/i18n";
import { inboxMessages } from "~/i18n/inbox";
import { orderDetailLabel, orderDetailMessages } from "~/i18n/order-detail";
import { orderMessages } from "~/i18n/orders";
import { formatOrderTimestamp } from "../orderview/formatters";
import { authorName, eventText } from "./conversation-format";
import { fetchOlderMessages, fetchMessagesAround, type StaffMessage, type StaffThread } from "~/lib/api-query-options/inbox";
import { ConversationProductCards } from "./ConversationProductCards";
import { attachmentUrl } from "./inbox-api";

export interface ConversationFollowRequest {
  conversationId: string;
  seq: number;
}

interface ConversationMessagesProps {
  thread: StaffThread;
  currentUserId: string | null;
  className?: string;
  active?: boolean;
  onReadFrontier?: (seq: number) => void;
  followRequest?: ConversationFollowRequest;
  finding?: boolean;
  findRequest?: { seq: number; serial: number };
  onCloseFind?: () => void;
}

const MAX_RENDERED_MESSAGES = 200;

function mergeMessages(current: StaffMessage[], incoming: StaffMessage[]): StaffMessage[] {
  // Sequence identities are immutable and unique within the authorized thread.
  const bySeq = new Map(current.map((message) => [message.seq, message]));
  for (const message of incoming) bySeq.set(message.seq, message);
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

/** Keep loaded history and pending requests local to one thread, including A → B → A navigation. */
export function ConversationMessages(props: ConversationMessagesProps) {
  const restoreFocus = useRef(false);
  return <ThreadMessages key={props.thread.id} {...props} restoreFocus={restoreFocus} />;
}

function ThreadMessages({ thread, currentUserId, className, restoreFocus, active = true, onReadFrontier, followRequest, finding = false, findRequest, onCloseFind }: ConversationMessagesProps & { restoreFocus: { current: boolean } }) {
  const t = useMessages(inboxMessages);
  const od = useMessages(orderDetailMessages);
  const o = useMessages(orderMessages);
  const [history, setHistory] = useState(() => ({ messages: mergeMessages([], thread.messages).slice(-MAX_RENDERED_MESSAGES), hasMore: thread.hasMore || thread.messages.length > MAX_RENDERED_MESSAGES }));
  const [loadingBefore, setLoadingBefore] = useState<number | null>(null);
  const [failedBefore, setFailedBefore] = useState<number | null>(null);
  const [hasNew, setHasNew] = useState(false);
  const openedReadSeq = useRef(thread.unread > 0 ? thread.staffReadSeq : null).current;
  const initialPosition = useRef(true);
  const lastSeenSeq = useRef(thread.messages.at(-1)?.seq ?? 0);
  const request = useRef<object | null>(null);
  const [findError, setFindError] = useState(false);
  const [findRetry, setFindRetry] = useState(0);
  const [findHasNewer, setFindHasNewer] = useState(false);
  const [findingPosition, setFindingPosition] = useState(false);
  const findToken = useRef<object | null>(null);
  const findSession = useRef<{ backToNewest: boolean } | null>(null);
  const positionAfterRender = useRef<{ seq?: number; top?: number } | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const tailRef = useRef<HTMLLIElement>(null);
  const handledFollow = useRef<ConversationFollowRequest | undefined>(followRequest);
  const followNewest = useRef(true);
  const newestSeq = useRef(0);
  const anchor = useRef<{ seq: number; offset: number; trigger: HTMLButtonElement | null } | null>(null);
  const { messages, hasMore } = history;
  const renderedSeq = messages.at(-1)?.seq ?? 0;
  const hasNewerWindow = thread.lastSeq > renderedSeq || finding && findHasNewer;
  const grouped = groupConversationMessages(messages, { dayKey: (seconds) => commerceCalendarDateKey(getStoreTimeZone(), new Date(seconds * 1_000)) });
  const unreadSeq = openedReadSeq === null ? null : messages.find((message) => message.seq > openedReadSeq)?.seq;
  const newCount = messages.filter((message) => message.seq > lastSeenSeq.current && message.kind === "message").length;
  const preservePosition = (change: () => void) => {
    const scroller = scrollerRef.current;
    const top = scroller?.getBoundingClientRect().top ?? 0;
    const row = [...(scroller?.querySelectorAll<HTMLElement>("[data-message-seq]") ?? [])].find((element) => element.getBoundingClientRect().bottom > top);
    const offset = row?.getBoundingClientRect().top;
    flushSync(change);
    if (scroller && row?.isConnected && offset !== undefined) scroller.scrollTop += row.getBoundingClientRect().top - offset;
  };

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (restoreFocus.current) scroller?.focus({ preventScroll: true });
    restoreFocus.current = false;
    return () => {
      restoreFocus.current = Boolean(scroller?.contains(document.activeElement));
      request.current = null;
      findToken.current = null;
    };
  }, [restoreFocus]);

  useLayoutEffect(() => {
    if (findSession.current) return;
    setHistory((current) => {
      const merged = mergeMessages(current.messages, thread.messages);
      const ownSend = followRequest && handledFollow.current !== followRequest && followRequest.conversationId === thread.id
        && thread.messages.some((message) => message.seq === followRequest.seq);
      const start = followNewest.current || ownSend ? Math.max(0, merged.length - MAX_RENDERED_MESSAGES)
        : Math.max(0, merged.findIndex((message) => message.seq === current.messages[0]?.seq));
      return { messages: merged.slice(start, start + MAX_RENDERED_MESSAGES),
        hasMore: start > 0 || (!current.messages.length || (thread.messages[0]?.seq ?? Infinity) <= current.messages[0]!.seq ? thread.hasMore : current.hasMore) };
    });
  }, [thread.messages, thread.hasMore, thread.id, finding, followRequest]);

  useEffect(() => {
    if (!finding || !findRequest) return;
    const token = {};
    findToken.current = token;
    findSession.current ??= { backToNewest: false };
    request.current = null;
    setLoadingBefore(null);
    setFindError(false);
    setFindingPosition(true);
    void fetchMessagesAround(thread.id, findRequest.seq).then((page) => {
      if (findToken.current !== token) return;
      followNewest.current = false;
      positionAfterRender.current = { seq: findRequest.seq };
      setFindHasNewer(Boolean(page.hasNewer));
      setHistory({ messages: page.messages.slice(-MAX_RENDERED_MESSAGES), hasMore: page.hasMore || page.messages.length > MAX_RENDERED_MESSAGES });
    }).catch(() => { if (findToken.current === token) setFindError(true); })
      .finally(() => { if (findToken.current === token) setFindingPosition(false); });
    return () => { if (findToken.current === token) findToken.current = null; };
    // Each explicit hit loads once; history changes are local browsing, not another search request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finding, findRequest, thread.id, findRetry]);
  useLayoutEffect(() => {
    if (finding || !findSession.current) return;
    const toNewest = findSession.current.backToNewest;
    findSession.current = null;
    findToken.current = null;
    setFindingPosition(false);
    setFindError(false);
    const ownSend = followRequest && handledFollow.current !== followRequest && followRequest.conversationId === thread.id
      && thread.messages.some((message) => message.seq === followRequest.seq);
    const follow = toNewest || Boolean(ownSend);
    followNewest.current = follow;
    positionAfterRender.current = follow ? null : { top: scrollerRef.current?.scrollTop ?? 0 };
    setHistory((current) => {
      const merged = mergeMessages(current.messages, thread.messages);
      const start = follow ? Math.max(0, merged.length - MAX_RENDERED_MESSAGES)
        : Math.max(0, merged.findIndex((message) => message.seq === current.messages[0]?.seq));
      return { messages: merged.slice(start, start + MAX_RENDERED_MESSAGES), hasMore: start > 0 || current.hasMore };
    });
  }, [finding, thread.messages, thread.id, followRequest]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const lastSeq = messages.at(-1)?.seq ?? 0;
    const positioned = positionAfterRender.current;
    if (positioned) {
      const row = positioned.seq ? scroller.querySelector<HTMLElement>(`[data-message-seq="${positioned.seq}"]`) : null;
      if (row) { scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top; }
      else if (positioned.top !== undefined) scroller.scrollTop = positioned.top;
      positionAfterRender.current = null;
      newestSeq.current = lastSeq;
      return;
    }
    if (followRequest && handledFollow.current !== followRequest && followRequest.conversationId === thread.id
      && messages.some((message) => message.seq === followRequest.seq)) {
      handledFollow.current = followRequest;
      followNewest.current = true;
      anchor.current = null;
      setHasNew(false);
    }
    const saved = anchor.current;
    if (saved) {
      const row = scroller.querySelector<HTMLElement>(`[data-message-seq="${saved.seq}"]`);
      if (row) scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - saved.offset;
      if (saved.trigger && !saved.trigger.isConnected) scroller.focus({ preventScroll: true });
      anchor.current = null;
    } else if (followNewest.current) {
      scroller.scrollTop = scroller.scrollHeight;
    }
    if (initialPosition.current) {
      initialPosition.current = false;
      const divider = scroller.querySelector<HTMLElement>("[data-unread-divider]");
      if (divider && scroller.scrollHeight - (divider.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop) > scroller.clientHeight) {
        scroller.scrollTop += divider.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        followNewest.current = false;
      }
    }
    if (!followNewest.current && newestSeq.current > 0 && lastSeq > newestSeq.current) setHasNew(true);
    newestSeq.current = lastSeq;
  }, [messages, followRequest, thread.id]);

  // Each observation belongs to this rendered tail; stale observer callbacks cannot mark a newer window.
  useLayoutEffect(() => {
    const tail = tailRef.current;
    if (!active || !onReadFrontier || !renderedSeq || !tail || typeof IntersectionObserver === "undefined") return;
    let current: IntersectionObserver | null = null;
    const observe = () => {
      current?.disconnect();
      const observer = new IntersectionObserver((entries) => {
        if (current !== observer || tailRef.current !== tail || document.visibilityState !== "visible"
          || tail.parentElement?.closest('[hidden], [inert], [aria-hidden="true"]')) return;
        const visibility = getComputedStyle(tail).visibility;
        if (visibility === "hidden" || visibility === "collapse") return;
        if (entries.some((entry) => entry.target === tail && entry.isIntersecting && entry.intersectionRatio === 1)) {
          onReadFrontier(renderedSeq);
        }
      }, { threshold: 1 });
      current = observer;
      observer.observe(tail);
    };
    observe();
    const attributes = new MutationObserver(observe);
    for (let parent = tail.parentElement; parent; parent = parent.parentElement) {
      attributes.observe(parent, { attributes: true, attributeFilter: ["aria-hidden", "inert", "hidden"] });
    }
    document.addEventListener("visibilitychange", observe);
    document.addEventListener("focusin", observe);
    return () => {
      attributes.disconnect();
      current?.disconnect();
      current = null;
      document.removeEventListener("visibilitychange", observe);
      document.removeEventListener("focusin", observe);
    };
  }, [active, onReadFrontier, renderedSeq]);

  // Late image sizing and viewport changes follow the end only for a reader already there.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const list = scroller?.querySelector("ol");
    if (!scroller || !list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followNewest.current && !anchor.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(scroller);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  const labels = useMemo(() => ({
    request: (type: string) => (`request.${type}` in orderMessages.en ? o(`request.${type}` as "request.return") : od("requests.title")),
    status: (status: string) => orderDetailLabel(od, "requests.status.", status || "submitted"),
  }), [o, od]);

  const loadOlder = async (beforeSeq: number, trigger: HTMLButtonElement) => {
    if (request.current) return;
    const token = {};
    request.current = token;
    setLoadingBefore(beforeSeq);
    setFailedBefore(null);
    try {
      const page = await fetchOlderMessages(thread.id, beforeSeq);
      if (request.current !== token) return;
      const scroller = scrollerRef.current;
      if (scroller) {
        const top = scroller.getBoundingClientRect().top;
        const row = [...scroller.querySelectorAll<HTMLElement>("[data-message-seq]")]
          .find((element) => element.getBoundingClientRect().bottom > top);
        if (row) anchor.current = {
          seq: Number(row.dataset.messageSeq), offset: row.getBoundingClientRect().top - top,
          trigger: document.activeElement === trigger ? trigger : null,
        };
      }
      // No other render may consume this anchor before its page is committed.
      flushSync(() => setHistory((current) => {
        const merged = mergeMessages(current.messages, page.messages);
        if (merged.length > MAX_RENDERED_MESSAGES) followNewest.current = false;
        return { messages: merged.slice(0, MAX_RENDERED_MESSAGES),
          hasMore: beforeSeq <= (current.messages[0]?.seq ?? Infinity) ? page.hasMore : current.hasMore };
      }));
    } catch {
      if (request.current === token) setFailedBefore(beforeSeq);
    } finally {
      if (request.current === token) {
        request.current = null;
        setLoadingBefore(null);
      }
    }
  };

  const olderControl = (beforeSeq: number) => {
    const busy = loadingBefore === beforeSeq;
    const label = t(failedBefore === beforeSeq ? "retry" : "loadOlder");
    return (
      <div className="flex flex-col items-center gap-2 pb-3">
        {failedBefore === beforeSeq ? <p role="alert" className="text-body text-destructive">{t("loadOlderFailed")}</p> : null}
        <Button type="button" size="sm" variant="ghost" aria-label={label} aria-busy={busy || undefined} aria-disabled={busy || undefined}
          disabled={loadingBefore !== null && !busy}
          onClick={(event) => void loadOlder(beforeSeq, event.currentTarget)}>
          {/* Keep the active trigger focused while loading; request.current blocks repeated activation. */}
          <span className={busy ? "invisible contents" : undefined}>{label}</span>
          {busy ? <span className="absolute inset-0 flex items-center justify-center"><Loader2 className="animate-spin" aria-hidden /></span> : null}
        </Button>
      </div>
    );
  };

  return (
    <div ref={scrollerRef} tabIndex={0} role="region" aria-label={t("messages")} className={className}
      onScroll={(event) => {
        const scroller = event.currentTarget;
        followNewest.current = !finding && !hasNewerWindow && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 24;
        if (followNewest.current) { lastSeenSeq.current = renderedSeq; setHasNew(false); }
      }}>
      {findingPosition ? <p role="status" className="text-body text-muted-foreground">{t("loading")}</p> : null}
      {findError ? <div><p role="alert" className="text-body text-destructive">{t("findLoadFailed")}</p><Button variant="ghost" size="sm" onClick={() => { scrollerRef.current?.focus({ preventScroll: true }); setFindRetry((value) => value + 1); }}>{t("retry")}</Button></div> : null}
      {hasMore && messages[0] ? olderControl(messages[0].seq) : null}
      <ol className="mx-auto flex w-full max-w-3xl flex-col gap-1" aria-live="polite">
        {grouped.map(({ message, groupStart, showAuthor, startsDay }, index) => {
          const gap = index > 0 && message.seq > messages[index - 1]!.seq + 1;
          const time = formatOrderTimestamp(message.createdAt);
          const date = new Date(message.createdAt * 1_000);
          const day = commerceCalendarDateKey(getStoreTimeZone(), date);
          const today = commerceCalendarDateKey(getStoreTimeZone(), new Date());
          const dayDistance = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000;
          const separator = startsDay ? <li className="py-3 text-center text-body text-muted-foreground">{dayDistance === 0 ? t("today") : dayDistance === 1 ? t("yesterday") : formatDateTime(date, { dateStyle: "medium" })}</li> : null;
          const unread = message.seq === unreadSeq ? <li data-unread-divider className="border-t border-info py-2 text-center text-body text-info">{t("unreadDivider")}</li> : null;
          if (message.kind === "event") {
            return (
              <Fragment key={message.id}>
                {gap ? <li>{olderControl(message.seq)}</li> : null}
                {separator}{unread}
                <li data-message-seq={message.seq} className="flex justify-center">
                <p className="max-w-md text-center text-body text-muted-foreground">
                  {eventText(t, message, labels)}
                  {time ? <span className="ms-2">{time}</span> : null}
                </p>
                </li>
              </Fragment>
            );
          }
          const fromStore = message.authorType === "staff";
          const internal = message.visibility === "internal";
          const name = authorName(t, message, currentUserId, thread.customerName);
          return (
            <Fragment key={message.id}>
              {gap ? <li>{olderControl(message.seq)}</li> : null}
                {separator}{unread}
              <li data-message-seq={message.seq} aria-current={finding && findRequest?.seq === message.seq ? "true" : undefined} className={cn(fromStore ? "flex justify-end" : "flex justify-start", groupStart && index > 0 && "pt-3")}>
              <div className={cn("flex min-w-0 max-w-[min(36rem,85%)] flex-col gap-1", finding && findRequest?.seq === message.seq && "rounded-xl ring-2 ring-info ring-offset-2 ring-offset-background")}>
                <div className="flex min-w-0 flex-col gap-1">
                  {showAuthor ? <p className={fromStore ? "text-end text-body text-muted-foreground" : "text-body text-muted-foreground"}>
                    <span className="font-medium text-foreground">{name}</span>
                    {time ? <time dateTime={date.toISOString()} title={time} className="ms-2">{formatDateTime(date, { hour: "numeric", minute: "2-digit" })}</time> : null}
                  </p> : null}
                  <div aria-label={internal ? t("noteBy", { name }) : undefined}
                    className={
                      internal
                        ? "rounded-xl bg-caution-surface px-3 py-2 text-body"
                        : fromStore
                          ? "rounded-xl bg-info-surface px-3 py-2 text-body"
                          : "rounded-xl bg-muted px-3 py-2 text-body"
                    }
                  >
                    {internal ? (
                      <p className="mb-1 flex items-center gap-1 text-caption font-medium text-caution">
                        <Lock aria-hidden className="size-3.5" />
                        {t("internalNote")}
                      </p>
                    ) : null}
                    {message.body ? <MessageBody body={message.body} preservePosition={preservePosition} /> : null}
                    {message.products?.length ? <div className="mt-2"><ConversationProductCards products={message.products} /></div> : null}
                    {message.attachments.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {message.attachments.map((attachment) => (
                          <a
                            key={attachment.id}
                            href={attachmentUrl(thread.id, attachment.id)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block min-w-0 max-w-60 overflow-clip rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <ConversationImage src={attachmentUrl(thread.id, attachment.id)} width={attachment.width} height={attachment.height} tile={message.attachments.length > 1} />
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
              </li>
            </Fragment>
          );
        })}
        <li key={`tail-${renderedSeq}`} ref={tailRef} aria-hidden className="h-px" />
      </ol>
      {hasNew || hasNewerWindow ? (
        // eslint-disable-next-line no-restricted-syntax -- Zero-height anchor for a floating button, not a sticky bar.
        <div className="sticky bottom-0 z-10 flex h-0 items-end justify-center">
          <Button type="button" size="sm" variant="secondary" onClick={() => {
            const scroller = scrollerRef.current;
            if (!scroller) return;
            if (finding) {
              if (findSession.current) findSession.current.backToNewest = true;
              onCloseFind?.();
              return;
            }
            followNewest.current = true;
            if (hasNewerWindow) setHistory({ messages: thread.messages.slice(-MAX_RENDERED_MESSAGES), hasMore: thread.hasMore || thread.messages.length > MAX_RENDERED_MESSAGES });
            setHasNew(false);
            lastSeenSeq.current = renderedSeq;
            scroller.scrollTop = scroller.scrollHeight;
            scroller.focus({ preventScroll: true });
          }}>{hasNewerWindow ? t("backNewest") : newCount > 0 ? t("newMessagesCount", { count: newCount }) : t("newMessages")}</Button>
        </div>
      ) : null}
    </div>
  );
}

function MessageBody({ body, preservePosition }: { body: string; preservePosition: (change: () => void) => void }) {
  const t = useMessages(inboxMessages);
  const element = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const measure = () => setLong(node.scrollHeight > (Number.parseFloat(getComputedStyle(node).lineHeight) || 20) * 14 + 1);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [body]);
  return <>
    <p ref={element} className={expanded ? "whitespace-pre-wrap wrap-anywhere" : "line-clamp-14 whitespace-pre-wrap wrap-anywhere"}>{body}</p>
    {long ? <Button type="button" size="sm" variant="link" aria-expanded={expanded} onClick={() => preservePosition(() => setExpanded((current) => !current))}>{t(expanded ? "showLess" : "showMore")}</Button> : null}
  </>;
}
function ConversationImage({ src, width, height, tile }: { src: string; width: number | null; height: number | null; tile: boolean }) {
  const t = useMessages(inboxMessages);
  const [failed, setFailed] = useState(false);
  return failed ? <span className="flex size-24 items-center justify-center rounded-lg bg-muted p-2 text-body text-muted-foreground">{t("imageUnavailable")}</span>
    : <img src={src} alt={t("imageAlt")} loading="lazy" width={width ?? undefined} height={height ?? undefined}
      onError={() => setFailed(true)} className={tile ? "size-24 bg-card object-cover" : "h-auto max-h-60 max-w-full bg-card object-contain"} />;
}
