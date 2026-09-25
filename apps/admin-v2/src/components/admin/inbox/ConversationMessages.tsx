import { useEffect, useMemo, useRef, useState } from "react";
import { Lock } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { inboxMessages } from "~/i18n/inbox";
import { orderDetailLabel, orderDetailMessages } from "~/i18n/order-detail";
import { orderMessages } from "~/i18n/orders";
import { formatOrderTimestamp } from "../orderview/formatters";
import { authorName, eventText, initials } from "./conversation-format";
import { attachmentUrl, fetchOlderMessages, type StaffMessage, type StaffThread } from "./inbox-api";

/**
 * One thread's lines, oldest first: the customer's messages on the left, the
 * store's on the right, internal notes tinted and labelled, events as small
 * centred lines. Earlier pages load on demand. Pass a scrolling `className`
 * (e.g. `overflow-y-auto`) and the newest line is kept in view.
 */
export function ConversationMessages({
  thread,
  currentUserId,
  className,
}: {
  thread: StaffThread;
  currentUserId: string | null;
  className?: string;
}) {
  const t = useMessages(inboxMessages);
  const od = useMessages(orderDetailMessages);
  const o = useMessages(orderMessages);
  const [older, setOlder] = useState<StaffMessage[]>([]);
  const [olderHasMore, setOlderHasMore] = useState<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const lastSeq = thread.lastSeq;

  useEffect(() => {
    setOlder([]);
    setOlderHasMore(null);
  }, [thread.id]);

  // Scroll only this list (never the page) to the newest line when one arrives.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [thread.id, lastSeq]);

  const messages = useMemo(() => {
    const seen = new Set(thread.messages.map((message) => message.id));
    return [...older.filter((message) => !seen.has(message.id)), ...thread.messages];
  }, [older, thread.messages]);
  const hasMore = olderHasMore ?? thread.hasMore;

  const labels = useMemo(() => ({
    request: (type: string) => (`request.${type}` in orderMessages.en ? o(`request.${type}` as "request.return") : od("requests.title")),
    status: (status: string) => orderDetailLabel(od, "requests.status.", status || "submitted"),
  }), [o, od]);

  const loadOlder = async () => {
    const first = messages[0];
    if (!first) return;
    setLoadingOlder(true);
    try {
      const page = await fetchOlderMessages(thread.id, first.seq);
      setOlder((current) => [...page.messages, ...current]);
      setOlderHasMore(page.hasMore);
    } finally {
      setLoadingOlder(false);
    }
  };

  return (
    <div ref={scrollerRef} className={className}>
      {hasMore ? (
        <div className="flex justify-center pb-3">
          <Button type="button" size="sm" variant="ghost" loading={loadingOlder} onClick={() => void loadOlder()}>
            {t("loadOlder")}
          </Button>
        </div>
      ) : null}
      <ol className="flex flex-col gap-3" aria-live="polite">
        {messages.map((message) => {
          const time = formatOrderTimestamp(message.createdAt);
          if (message.kind === "event") {
            return (
              <li key={message.id} className="flex justify-center">
                <p className="max-w-md text-center text-body text-muted-foreground">
                  {eventText(t, message, labels)}
                  {time ? <span className="ms-2">{time}</span> : null}
                </p>
              </li>
            );
          }
          const fromStore = message.authorType === "staff";
          const internal = message.visibility === "internal";
          const name = authorName(t, message, currentUserId, thread.customerName);
          return (
            <li key={message.id} className={fromStore ? "flex justify-end" : "flex justify-start"}>
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
          );
        })}
      </ol>
    </div>
  );
}
