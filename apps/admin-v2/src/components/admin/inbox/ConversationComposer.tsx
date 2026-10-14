import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouteContext } from "@tanstack/react-router";
import { ImagePlus, Lock, Plus, X } from "lucide-react";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { useHasPermission } from "~/contexts/PermissionContext";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { SavedRepliesDialog } from "./SavedRepliesDialog";
import { ConversationProductsDialog } from "./ConversationProductsDialog";
import { toast } from "~/lib/toast";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { Textarea } from "~/components/ui/textarea";
import { useMessages } from "~/i18n";
import { inboxMessages } from "~/i18n/inbox";
import { getServerFnError } from "~/lib/api-helpers";
import type { StaffThread } from "~/lib/api-query-options/inbox";
import { MAX_BODY_LENGTH, MAX_IMAGES, acceptImages } from "./conversation-format";
import {
  newRequestKey,
  uploadConversationImage,
  usePostMessage,
} from "./inbox-api";
import { sameDraftPayload, activateInboxDraftAccount, completeInboxDraft, getInboxDrafts, inboxDraftGeneration, subscribeInboxDrafts, updateInboxDraft, type DraftMode, type DraftPayload, type DraftImage } from "~/lib/inbox-drafts";
import { matchesShortcut } from "../layout/shortcuts";

/**
 * The reply box (Shopify Inbox): Reply or Internal note, up to three images,
 * Ctrl/⌘+Enter to send. A draft keeps one request key until it is sent, so a
 * double send posts once. Posting on an order without a thread starts it.
 */
type ComposerProps = {
  conversationId: string | null;
  orderId?: string | null;
  onPosted?: (thread: StaffThread) => void;
  primary?: boolean;
  allowInternalNotes?: boolean;
  focusRequest?: { mode: DraftMode; serial: number };
};

export function ConversationComposer(props: ComposerProps) {
  const userId = useRouteContext({ from: "/admin", select: (context) => context.user?.id ?? null });
  const [readyAccount, setReadyAccount] = useState<string | null>(null);
  useLayoutEffect(() => {
    activateInboxDraftAccount(userId);
    setReadyAccount(userId);
  }, [userId]);
  const owner = props.orderId ? `order:${props.orderId}` : `conversation:${props.conversationId}`;
  if (!userId || readyAccount !== userId) return null;
  return <AccountComposer key={`${userId}:${owner}`} {...props} userId={userId} owner={owner} />;
}

function AccountComposer({ conversationId, orderId, onPosted, primary = true, allowInternalNotes = true, focusRequest, userId, owner }: ComposerProps & { userId: string; owner: string }) {
  const t = useMessages(inboxMessages);
  const fieldId = useId();
  const canViewProducts = useHasPermission(PERMISSIONS.PRODUCTS_VIEW);
  const [savedRepliesOpen, setSavedRepliesOpen] = useState(false);
  const [productsOpen, setProductsOpen] = useState(false);
  const insertion = useRef({ start: 0, end: 0 });
  const helpId = useId();
  const [selectedMode, setMode] = useState<DraftMode>("public");
  const mode = allowInternalNotes ? selectedMode : "public";
  const drafts = useSyncExternalStore(subscribeInboxDrafts, () => getInboxDrafts(userId, owner));
  const draft = drafts[mode];
  const { body, images, uploading, products } = draft;
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const post = usePostMessage({ conversationId, orderId });
  const lifetime = useRef<object | null>(null);
  const epoch = useRef(inboxDraftGeneration()).current;
  const update = (targetMode: DraftMode, change: Parameters<typeof updateInboxDraft>[3]) => updateInboxDraft(userId, owner, targetMode, change, epoch);
  useLayoutEffect(() => {
    lifetime.current = {};
    return () => {
      lifetime.current = null;
      for (const targetMode of ["public", "internal"] as const) {
        updateInboxDraft(userId, owner, targetMode, (current) => ({ ...current, omittedImages: Math.min(3, current.omittedImages + current.uploading), uploading: 0 }), epoch);
      }
    };
  }, [userId, owner, epoch]);
  useLayoutEffect(() => {
    if (!focusRequest || (focusRequest.mode === "internal" && !allowInternalNotes)) return;
    setMode(focusRequest.mode);
    textarea.current?.focus();
  }, [focusRequest, allowInternalNotes]);

  useLayoutEffect(() => {
    const input = textarea.current;
    if (!input) return;
    const fit = () => {
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight}px`;
    };
    fit();
    // Reflow after a pane or viewport changes width, even when the draft is unchanged.
    let width = input.clientWidth;
    let frame: number | null = null;
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width ?? input.clientWidth;
      if (nextWidth === width) return;
      width = nextWidth;
      frame ??= requestAnimationFrame(() => { frame = null; fit(); });
    });
    observer.observe(input);
    return () => { observer.disconnect(); if (frame !== null) cancelAnimationFrame(frame); };
  }, [body, mode]);

  const restoredAttachments = draft.retryImages && images.length === 0 && draft.omittedImages > 0 && draft.attempt?.payload.body === body
    ? draft.attempt.payload.attachmentIds : undefined;
  const payload: DraftPayload = { body, visibility: mode, ...(mode === "public" && products.length ? { products: products.map(({ productId, skuId }) => ({ productId, skuId })) } : {}), ...((images.length || restoredAttachments?.length)
    ? { attachmentIds: images.length ? images.map((image) => image.attachmentId) : restoredAttachments } : {}) };
  const tooLong = body.length > MAX_BODY_LENGTH;
  const canSend = (body.trim().length > 0 || mode === "public" && products.length > 0) && !tooLong && uploading === 0 && !post.isPending;
  const changedAfterAttempt = draft.attempt !== null && !sameDraftPayload(draft.attempt.payload, payload);
  const send = () => {
    if (!canSend) return;
    const submittedMode = mode;
    const currentLifetime = lifetime.current;
    const sent = draft.attempt && !changedAfterAttempt ? draft.attempt : { key: newRequestKey(), payload };
    // Persist the exact attempt before issuing it: refresh or navigation can lose the response.
    update(submittedMode, (current) => ({ ...current, attempt: sent, error: null }));
    void post.mutateAsync({ ...sent.payload, requestKey: sent.key }).then((thread) => {
      completeInboxDraft(userId, owner, submittedMode, sent, epoch);
      if (lifetime.current !== currentLifetime || epoch !== inboxDraftGeneration()) return;
      toast.success(t(submittedMode === "public" ? "toast.sent" : "toast.noted"));
      onPosted?.(thread);
    }).catch((error: unknown) => {
      update(submittedMode, (current) => ({ ...current, error: getServerFnError(error) }));
    });
  };

  const pickImages = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const targetMode = mode;
    const currentLifetime = lifetime.current;
    const { accepted, rejection } = acceptImages([...files], images.length + uploading);
    update(targetMode, (current) => ({ ...current, error: rejection ? t(rejection) : null, uploading: current.uploading + accepted.length }));
    for (const file of accepted) {
      if (lifetime.current !== currentLifetime || epoch !== inboxDraftGeneration()) break;
      try {
        const uploaded = await uploadConversationImage(file, { conversationId, orderId });
        if (lifetime.current !== currentLifetime || epoch !== inboxDraftGeneration()) break;
        const image: DraftImage = { ...uploaded, name: file.name, preview: URL.createObjectURL(file) };
        update(targetMode, (current) => ({ ...current, images: [...current.images, image], omittedImages: 0, retryImages: false }));
      } catch (error) {
        if (lifetime.current !== currentLifetime) break;
        update(targetMode, (current) => ({ ...current, error: getServerFnError(error) }));
      } finally {
        if (lifetime.current === currentLifetime) update(targetMode, (current) => ({ ...current, uploading: Math.max(0, current.uploading - 1) }));
      }
    }
    if (lifetime.current === currentLifetime && fileInput.current) fileInput.current.value = "";
  };

  const openReplies = () => { insertion.current = { start: textarea.current?.selectionStart ?? body.length, end: textarea.current?.selectionEnd ?? body.length }; setSavedRepliesOpen(true); };
  const insertReply = (text: string) => {
    const current = getInboxDrafts(userId, owner)[mode];
    const start = Math.min(insertion.current.start, current.body.length);
    const end = Math.min(insertion.current.end, current.body.length);
    const collapsed = start === end;
    const before = collapsed && start > 0 && !/\s/.test(current.body[start - 1]!) && !/^\s/.test(text) ? " " : "";
    const after = collapsed && end < current.body.length && !/\s/.test(current.body[end]!) && !/\s$/.test(text) ? " " : "";
    const next = current.body.slice(0, start) + before + text + after + current.body.slice(end);
    const caret = start + before.length + text.length;
    update(mode, (value) => ({ ...value, body: next }));
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(caret, caret); });
  };
  return (
    <div className={mode === "internal" ? "@container/composer flex flex-col gap-2 rounded-lg bg-caution-surface p-2" : "@container/composer flex flex-col gap-2"}>
      {draft.error ? (
        <Alert variant="destructive">
          <AlertDescription>{draft.error}</AlertDescription>
        </Alert>
      ) : null}
      <label htmlFor={fieldId} className="sr-only">{t(mode === "public" ? "replyLabel" : "noteLabel")}</label>
      <div className="flex flex-col gap-1">
        <Textarea
          ref={textarea}
          id={fieldId}
          value={body}
          onChange={(event) => update(mode, (current) => ({ ...current, body: event.target.value }))}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === "/" && !body) { event.preventDefault(); openReplies(); return; }
            if (matchesShortcut("submit", event)) {
              event.preventDefault();
              send();
            }
          }}
          placeholder={t(mode === "public" ? "replyPlaceholder" : "notePlaceholder")}
          aria-describedby={helpId}
          aria-invalid={tooLong || undefined}
          rows={1}
          // eslint-disable-next-line shadcn/no-restyle -- compact conversation composer, capped before it consumes the reading viewport
          className="min-h-11 max-h-36 resize-none sm:min-h-9 sm:max-h-[min(16rem,35dvh)]"
        />
        <p id={helpId} className="sr-only">
          {t(mode === "public" ? "replyHelp" : "noteHelp")} · {t("sendShortcut")}
        </p>
      </div>
      {images.length > 0 || uploading > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {images.map((image) => (
            <li key={image.attachmentId} className="relative">
              <img src={image.preview} alt={image.name} className="size-16 rounded-lg bg-muted object-cover" />
              <Button
                type="button"
                size="icon-sm"
                variant="secondary"
                className="absolute -end-2 -top-2"
                aria-label={t("removeImage")}
                onClick={() => {
                  URL.revokeObjectURL(image.preview);
                  update(mode, (current) => ({ ...current, retryImages: false, images: current.images.filter((item) => item.attachmentId !== image.attachmentId) }));
                }}
              >
                <X aria-hidden />
              </Button>
            </li>
          ))}
          {uploading > 0 ? (
            <li className="flex size-16 items-center justify-center rounded-lg bg-muted text-caption text-muted-foreground">
              {t("uploading")}
            </li>
          ) : null}
        </ul>
      ) : null}
      {products.length && mode === "public" ? <ul className="flex flex-wrap gap-2">{products.map((product) => <li key={product.skuId} className="flex min-w-0 max-w-full items-center gap-1 rounded-lg bg-muted px-2 py-1"><span className="min-w-0 truncate text-body">{product.title}{product.variantLabel ? ` · ${product.variantLabel}` : ""}</span><Button size="icon-sm" variant="ghost" aria-label={t("removeProduct")} onClick={() => update("public", (current) => ({ ...current, products: current.products.filter((item) => item.skuId !== product.skuId) }))}><X aria-hidden /></Button></li>)}</ul> : null}
      {drafts.storageFailed ? <p role="status" className="text-body text-muted-foreground">{t("draftNotStored")}</p> : null}
      {draft.omittedImages > 0 ? <p role="status" className="text-body text-muted-foreground">{t(restoredAttachments?.length ? "draftRetryImages" : "draftReselectImages", { count: draft.omittedImages })}</p> : null}
      {changedAfterAttempt ? <p role="status" className="text-body text-muted-foreground">{t("draftEarlierSend")}</p> : null}
      {tooLong ? <p className="text-body text-destructive">{t("tooLong", { count: MAX_BODY_LENGTH })}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1">
      {allowInternalNotes ? (
        <Tabs value={mode} onValueChange={(value) => setMode(value as DraftMode)}>
          <TabsList aria-label={t("replyLabel")}>
            <TabsTrigger value="public">{t("reply")}</TabsTrigger>
            <TabsTrigger value="internal" aria-label={t("note")}><Lock aria-hidden className="size-3.5" />{t("noteTab")}</TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => void pickImages(event.target.files)}
          />
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={t("composerTools")}><Plus aria-hidden /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem disabled={images.length + uploading >= MAX_IMAGES} onSelect={() => fileInput.current?.click()}>{t("attach")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={openReplies}>{t("savedReplies")}</DropdownMenuItem>
              {mode === "public" && canViewProducts ? <DropdownMenuItem disabled={products.length >= 3} onSelect={() => setProductsOpen(true)}>{t("addProduct")}</DropdownMenuItem> : null}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="hidden @lg/composer:block"><Tooltip><TooltipTrigger asChild><Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("attach")}
            disabled={images.length + uploading >= MAX_IMAGES}
            onClick={() => fileInput.current?.click()}
          >
            <ImagePlus aria-hidden />
          </Button></TooltipTrigger><TooltipContent>{t("attach")} · {t("attachHelp")}</TooltipContent></Tooltip></div>
        </div>
        <Button type="button" aria-label={t(mode === "public" ? "send" : "addNote")} variant={primary ? "default" : "outline"} onClick={send} disabled={!canSend && !post.isPending} loading={post.isPending}>
          {t(mode === "public" ? "send" : "addNote")}
        </Button>
      </div>
      <SavedRepliesDialog key={mode} open={savedRepliesOpen} onOpenChange={setSavedRepliesOpen} mode={mode} onInsert={insertReply} />
      {canViewProducts && mode === "public" ? <ConversationProductsDialog open={productsOpen} onOpenChange={setProductsOpen} selectedIds={products.map((product) => product.skuId)} onPick={(product) => update("public", (current) => current.products.length >= 3 || current.products.some((item) => item.skuId === product.skuId) ? current : ({ ...current, products: [...current.products, product] }))} /> : null}
    </div>
  );
}
