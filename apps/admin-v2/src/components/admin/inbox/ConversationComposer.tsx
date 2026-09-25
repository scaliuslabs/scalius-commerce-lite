import { useId, useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Textarea } from "~/components/ui/textarea";
import { useMessages } from "~/i18n";
import { inboxMessages } from "~/i18n/inbox";
import { getServerFnError } from "~/lib/api-helpers";
import { MAX_BODY_LENGTH, MAX_IMAGES, acceptImages } from "./conversation-format";
import {
  newRequestKey,
  uploadConversationImage,
  usePostMessage,
  type StaffThread,
  type UploadedImage,
} from "./inbox-api";

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
}: {
  conversationId: string | null;
  orderId?: string | null;
  onPosted?: (thread: StaffThread) => void;
}) {
  const t = useMessages(inboxMessages);
  const fieldId = useId();
  const helpId = useId();
  const [mode, setMode] = useState<"public" | "internal">("public");
  const [body, setBody] = useState("");
  const [images, setImages] = useState<StagedImage[]>([]);
  const [uploading, setUploading] = useState(0);
  const [imageError, setImageError] = useState<string | null>(null);
  const requestKey = useRef(newRequestKey());
  const fileInput = useRef<HTMLInputElement>(null);
  const post = usePostMessage({ conversationId, orderId });
  const target = { conversationId, orderId };

  const tooLong = body.length > MAX_BODY_LENGTH;
  const canSend = body.trim().length > 0 && !tooLong && uploading === 0 && !post.isPending;

  const send = () => {
    if (!canSend) return;
    post.mutate({
      body,
      visibility: mode,
      requestKey: requestKey.current,
      attachmentIds: images.length > 0 ? images.map((image) => image.attachmentId) : undefined,
    }, {
      onSuccess: (thread) => {
        for (const image of images) URL.revokeObjectURL(image.preview);
        setBody("");
        setImages([]);
        requestKey.current = newRequestKey();
        toast.success(t(mode === "public" ? "toast.sent" : "toast.noted"));
        onPosted?.(thread);
      },
    });
  };

  const pickImages = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const { accepted, rejection } = acceptImages([...files], images.length + uploading);
    setImageError(rejection ? t(rejection) : null);
    setUploading((count) => count + accepted.length);
    for (const file of accepted) {
      try {
        const uploaded = await uploadConversationImage(file, target);
        setImages((current) => [...current, { ...uploaded, name: file.name, preview: URL.createObjectURL(file) }]);
      } catch (error) {
        setImageError(getServerFnError(error));
      } finally {
        setUploading((count) => count - 1);
      }
    }
    if (fileInput.current) fileInput.current.value = "";
  };

  return (
    <div className="flex flex-col gap-2">
      <Tabs value={mode} onValueChange={(value) => setMode(value as "public" | "internal")}>
        <TabsList aria-label={t("replyLabel")}>
          <TabsTrigger value="public">{t("reply")}</TabsTrigger>
          <TabsTrigger value="internal">{t("note")}</TabsTrigger>
        </TabsList>
      </Tabs>
      {post.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{getServerFnError(post.error)}</AlertDescription>
        </Alert>
      ) : null}
      <label htmlFor={fieldId} className="sr-only">{t(mode === "public" ? "replyLabel" : "noteLabel")}</label>
      <Textarea
        id={fieldId}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            send();
          }
        }}
        placeholder={t(mode === "public" ? "replyPlaceholder" : "notePlaceholder")}
        aria-describedby={helpId}
        aria-invalid={tooLong || undefined}
        className="min-h-24"
      />
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
            size="sm"
            disabled={images.length + uploading >= MAX_IMAGES}
            onClick={() => fileInput.current?.click()}
          >
            <ImagePlus aria-hidden />
            {t("attach")}
          </Button>
          <p id={helpId} className="hidden text-body text-muted-foreground sm:block">
            {t(mode === "public" ? "replyHelp" : "noteHelp")} · {t("sendShortcut")}
          </p>
        </div>
        <Button type="button" onClick={send} disabled={!canSend && !post.isPending} loading={post.isPending}>
          {t(mode === "public" ? "send" : "addNote")}
        </Button>
      </div>
    </div>
  );
}
