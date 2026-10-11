import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Loader2, Lock } from "lucide-react";
import { flushSync } from "react-dom";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { inboxMessages } from "~/i18n/inbox";
import { orderDetailLabel, orderDetailMessages } from "~/i18n/order-detail";
import { orderMessages } from "~/i18n/orders";
import { formatOrderTimestamp } from "../orderview/formatters";
import { authorName, eventText, initials } from "./conversation-format";
import { fetchOlderMessages, type StaffMessage, type StaffThread } from "~/lib/api-query-options/inbox";
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
}

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

function ThreadMessages({ thread, currentUserId, className, restoreFocus, active = true, onReadFrontier, followRequest }: ConversationMessagesProps & { restoreFocus: { current: boolean } }) {
  const t = useMessages(inboxMessages);
  const od = useMessages(orderDetailMessages);
  const o = useMessages(orderMessages);
  const [history, setHistory] = useState(() => ({ messages: mergeMessages([], thread.messages), hasMore: thread.hasMore }));
  const [loadingBefore, setLoadingBefore] = useState<number | null>(null);
  const [failedBefore, setFailedBefore] = useState<number | null>(null);
  const [hasNew, setHasNew] = useState(false);
  const request = useRef<object | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const tailRef = useRef<HTMLLIElement>(null);
  const handledFollow = useRef<ConversationFollowRequest | undefined>(followRequest);
  const followNewest = useRef(true);
  const newestSeq = useRef(0);
  const anchor = useRef<{ seq: number; offset: number; trigger: HTMLButtonElement | null } | null>(null);
  const { messages, hasMore } = history;
  const renderedSeq = messages.at(-1)?.seq ?? 0;

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (restoreFocus.current) scroller?.focus({ preventScroll: true });
    restoreFocus.current = false;
    return () => {
      restoreFocus.current = Boolean(scroller?.contains(document.activeElement));
      request.current = null;
    };
  }, [restoreFocus]);

  useLayoutEffect(() => {
    setHistory((current) => ({
      messages: mergeMessages(current.messages, thread.messages),
      hasMore: !current.messages.length || (thread.messages[0]?.seq ?? Infinity) <= current.messages[0]!.seq
        ? thread.hasMore : current.hasMore,
    }));
  }, [thread.messages, thread.hasMore]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const lastSeq = messages.at(-1)?.seq ?? 0;
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
    if (!followNewest.current && lastSeq > newestSeq.current) setHasNew(true);
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
      flushSync(() => setHistory((current) => ({
        messages: mergeMessages(current.messages, page.messages),
        hasMore: beforeSeq <= (current.messages[0]?.seq ?? Infinity) ? page.hasMore : current.hasMore,
      })));
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
        followNewest.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 24;
        if (followNewest.current) setHasNew(false);
      }}>
      {hasMore && messages[0] ? olderControl(messages[0].seq) : null}
      <ol className="flex flex-col gap-3" aria-live="polite">
        {messages.map((message, index) => {
          const gap = index > 0 && message.seq > messages[index - 1]!.seq + 1;
          const time = formatOrderTimestamp(message.createdAt);
          if (message.kind === "event") {
            return (
              <Fragment key={message.id}>
                {gap ? <li>{olderControl(message.seq)}</li> : null}
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
              <li data-message-seq={message.seq} className={fromStore ? "flex justify-end" : "flex justify-start"}>
              <div className="flex max-w-xl items-start gap-2">
                {!fromStore ? (
                  <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-caption font-medium">
                    {initials(name)}
                  </span>
                ) : null}
                <div className="flex min-w-0 flex-col gap-1">
                  <p className={fromStore ? "text-end text-body text-muted-foreground" : "text-body text-muted-foreground"}>
                    <span className="font-medium text-foreground">{name}</span>
                    {time ? <span className="ms-2">{time}</span> : null}
                  </p>
                  <div
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
                    {message.body ? <p className="whitespace-pre-wrap break-words">{message.body}</p> : null}
                    {message.attachments.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {message.attachments.map((attachment) => (
                          <a
                            key={attachment.id}
                            href={attachmentUrl(thread.id, attachment.id)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block overflow-clip rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <img
                              src={attachmentUrl(thread.id, attachment.id)}
                              alt={t("imageAlt")}
                              loading="lazy"
                              width={attachment.width ?? undefined}
                              height={attachment.height ?? undefined}
                              className="h-32 w-auto max-w-full bg-card object-cover"
                            />
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
      {hasNew ? (
        // eslint-disable-next-line no-restricted-syntax -- Zero-height anchor for a floating button, not a sticky bar.
        <div className="sticky bottom-0 z-10 flex h-0 items-end justify-center">
          <Button type="button" size="sm" variant="secondary" onClick={() => {
            const scroller = scrollerRef.current;
            if (!scroller) return;
            followNewest.current = true;
            setHasNew(false);
            scroller.scrollTop = scroller.scrollHeight;
            scroller.focus({ preventScroll: true });
          }}>{t("newMessages")}</Button>
        </div>
      ) : null}
    </div>
  );
}
