import { useId, useLayoutEffect, useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { toast } from "~/lib/toast";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
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
  type UploadedImage,
} from "./inbox-api";
import { matchesShortcut } from "../layout/shortcuts";

interface StagedImage extends UploadedImage {
  name: string;
  preview: string;
}

/**
 * The reply box (Shopify Inbox): Reply or Internal note, up to three images,
 * Ctrl/⌘+Enter to send. A draft keeps one request key until it is sent, so a
 * double send posts once. Posting on an order without a thread starts it.
 */
export function ConversationComposer({
  conversationId,
  orderId,
  onPosted,
  primary = true,
  allowInternalNotes = true,
}: {
  conversationId: string | null;
  orderId?: string | null;
  onPosted?: (thread: StaffThread) => void;
  primary?: boolean;
  /** Hide when the page already offers a team-note composer for this user. */
  allowInternalNotes?: boolean;
}) {
  const t = useMessages(inboxMessages);
  const fieldId = useId();
  const helpId = useId();
  const [mode, setMode] = useState<"public" | "internal">("public");
  const [body, setBody] = useState("");
  const [images, setImages] = useState<StagedImage[]>([]);
  const [uploading, setUploading] = useState(0);
  const [imageError, setImageError] = useState<string | null>(null);
  const lastAttempt = useRef<{ signature: string; key: string } | null>(null);
  const draftRevision = useRef(0);
  const previewUrls = useRef(new Set<string>());
  const fileInput = useRef<HTMLInputElement>(null);
  const post = usePostMessage({ conversationId, orderId });
  const target = { conversationId, orderId };
  const lifetime = useRef<object | null>(null);
  const owner = orderId ? `order:${orderId}` : `conversation:${conversationId}`;
  useLayoutEffect(() => {
    lifetime.current = {};
    lastAttempt.current = null;
    draftRevision.current += 1;
    setBody("");
    setMode("public");
    setImages([]);
    setUploading(0);
    setImageError(null);
    return () => {
      lifetime.current = null;
      for (const preview of previewUrls.current) URL.revokeObjectURL(preview);
      previewUrls.current.clear();
    };
  }, [owner]);

  const tooLong = body.length > MAX_BODY_LENGTH;
  const canSend = body.trim().length > 0 && !tooLong && uploading === 0 && !post.isPending;

  const send = () => {
    if (!canSend) return;
    const currentLifetime = lifetime.current;
    const submittedRevision = draftRevision.current;
    const payload = { body, visibility: mode, attachmentIds: images.length > 0 ? images.map((image) => image.attachmentId) : undefined };
    const signature = JSON.stringify(payload);
    if (lastAttempt.current?.signature !== signature) lastAttempt.current = { signature, key: newRequestKey() };
    post.mutate({ ...payload, requestKey: lastAttempt.current.key }, {
      onSuccess: (thread) => {
        if (lifetime.current !== currentLifetime) return;
        const sentIds = new Set(images.map((image) => image.attachmentId));
        for (const image of images) {
          if (previewUrls.current.delete(image.preview)) URL.revokeObjectURL(image.preview);
        }
        if (draftRevision.current === submittedRevision) setBody("");
        setImages((current) => current.filter((image) => !sentIds.has(image.attachmentId)));
        lastAttempt.current = null;
        toast.success(t(mode === "public" ? "toast.sent" : "toast.noted"));
        onPosted?.(thread);
      },
    });
  };

  const pickImages = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const currentLifetime = lifetime.current;
    const { accepted, rejection } = acceptImages([...files], images.length + uploading);
    setImageError(rejection ? t(rejection) : null);
    setUploading((count) => count + accepted.length);
    for (const file of accepted) {
      if (lifetime.current !== currentLifetime) break;
      try {
        const uploaded = await uploadConversationImage(file, target);
        if (lifetime.current !== currentLifetime) break;
        const preview = URL.createObjectURL(file);
        previewUrls.current.add(preview);
        setImages((current) => [...current, { ...uploaded, name: file.name, preview }]);
      } catch (error) {
        if (lifetime.current !== currentLifetime) break;
        setImageError(getServerFnError(error));
      } finally {
        if (lifetime.current === currentLifetime) setUploading((count) => count - 1);
      }
    }
    if (lifetime.current === currentLifetime && fileInput.current) fileInput.current.value = "";
  };

  return (
    <div className="flex flex-col gap-2">
      {allowInternalNotes ? (
        <Tabs value={mode} onValueChange={(value) => { draftRevision.current += 1; setMode(value as "public" | "internal"); }}>
          <TabsList aria-label={t("replyLabel")}>
            <TabsTrigger value="public">{t("reply")}</TabsTrigger>
            <TabsTrigger value="internal">{t("note")}</TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}
      {post.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{getServerFnError(post.error)}</AlertDescription>
        </Alert>
      ) : null}
      <label htmlFor={fieldId} className="sr-only">{t(mode === "public" ? "replyLabel" : "noteLabel")}</label>
      <div className="flex flex-col gap-1">
        <Textarea
          id={fieldId}
          value={body}
          onChange={(event) => { draftRevision.current += 1; setBody(event.target.value); }}
          onKeyDown={(event) => {
            if (matchesShortcut("submit", event)) {
              event.preventDefault();
              send();
            }
          }}
          placeholder={t(mode === "public" ? "replyPlaceholder" : "notePlaceholder")}
          aria-describedby={helpId}
          aria-invalid={tooLong || undefined}
          className="min-h-24"
        />
        <p id={helpId} className="text-body text-muted-foreground">
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
                  if (previewUrls.current.delete(image.preview)) URL.revokeObjectURL(image.preview);
                  setImages((current) => current.filter((item) => item.attachmentId !== image.attachmentId));
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
      {imageError ? <p className="text-body text-destructive">{imageError}</p> : null}
      {tooLong ? <p className="text-body text-destructive">{t("tooLong", { count: MAX_BODY_LENGTH })}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
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
          <Button
            type="button"
            variant="ghost"
            disabled={images.length + uploading >= MAX_IMAGES}
            onClick={() => fileInput.current?.click()}
          >
            <ImagePlus aria-hidden />
            {t("attach")}
          </Button>
        </div>
        <Button type="button" variant={primary ? "default" : "outline"} onClick={send} disabled={!canSend && !post.isPending} loading={post.isPending}>
          {t(mode === "public" ? "send" : "addNote")}
        </Button>
      </div>
    </div>
  );
}
