// Progressive enhancement for conversation forms (ConversationReplyForm.astro).
// The form already works as a plain POST; this sends the same FormData with
// fetch, asks for JSON, and merges new rows into the thread. The message text
// stays in the request body and is never logged or sent to analytics.

import {
  checkAttachmentFiles,
  conversationStatusMessage,
  newClientMessageKey,
} from "@/lib/account-inbox";
import { pagePath } from "@/lib/presence-url";
import { encodeImageAsWebp } from "@scalius/shared/browser-image";
import { appendConversationItems, conversationRequest, notifyConversationSent, type ConversationItem } from "./conversation-live";

type Tone = "success" | "error";

interface PostAnswer {
  success?: boolean;
  data?: { message?: unknown; redirect?: unknown; conversationId?: string; items?: ConversationItem[]; hasOlder?: boolean };
  error?: { message?: unknown };
}

function setStatus(element: HTMLElement | null, text: string, tone: Tone): void {
  if (!element) return;
  element.textContent = text;
  element.classList.toggle("text-destructive", tone === "error");
  element.classList.toggle("text-primary", tone === "success");
}

/** The photos chosen in a form's data (an empty file part means none was chosen). */
function chosenPhotos(data: FormData): File[] {
  return data.getAll("images").filter((entry): entry is File => typeof entry !== "string" && entry.size > 0);
}

/**
 * Replaces every chosen photo with a copy scaled and encoded as WebP in this
 * browser (no Worker re-encodes images). A photo the browser cannot encode is
 * sent as chosen and the API says why it cannot take it.
 */
export async function encodePhotos(data: FormData, photos: File[]): Promise<void> {
  data.delete("images");
  for (const photo of photos) data.append("images", (await encodeImageAsWebp(photo)) ?? photo);
}

function bindForm(form: HTMLFormElement): void {
  if (form.dataset.conversationBound === "true") return;
  form.dataset.conversationBound = "true";
  form.dataset.enhanced = "true";

  const status = form.querySelector<HTMLElement>("[data-conversation-status]");
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
  const body = form.querySelector<HTMLTextAreaElement>("textarea[name=body]");
  const key = form.querySelector<HTMLInputElement>("input[name=clientMessageKey]");
  const files = form.querySelector<HTMLInputElement>("input[type=file][name=images]");
  const previews = form.querySelector<HTMLElement>("[data-conversation-previews]");
  const fitBody = () => {
    if (!body) return;
    body.style.height = "auto";
    const style = getComputedStyle(body);
    const max = parseFloat(style.maxHeight) || (form.dataset.conversationDock === "true" ? 160 : 192);
    const needed = body.scrollHeight + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
    body.style.height = `${Math.min(needed, max)}px`;
    body.style.overflowY = needed > max ? "auto" : "hidden";
  };
  body?.addEventListener("input", fitBody);
  fitBody();
  let previewUrls: string[] = [];
  let filesGeneration = 0;
  let unknownDraft: { body: string; files: number } | null = null;

  const clearPreviews = () => {
    previewUrls.forEach((url) => URL.revokeObjectURL(url));
    previewUrls = [];
    previews?.replaceChildren();
  };
  form.addEventListener("reset", clearPreviews);

  files?.addEventListener("change", () => {
    filesGeneration += 1;
    clearPreviews();
    const check = checkAttachmentFiles(Array.from(files.files ?? []));
    if (!check.ok) {
      const message = conversationStatusMessage("image").text;
      files.setCustomValidity(message);
      setStatus(status, message, "error");
      return;
    }
    files.setCustomValidity("");
    setStatus(status, "", "success");
    for (const file of check.files) {
      const url = URL.createObjectURL(file);
      previewUrls.push(url);
      const image = document.createElement("img");
      image.src = url;
      image.alt = "";
      image.className = "h-16 w-16 rounded-md border border-border object-cover";
      previews?.append(image);
    }
  });

  form.addEventListener("submit", async (event) => {
    const list = document.getElementById(form.dataset.messagesTarget ?? "");
    if (!list || typeof fetch !== "function") return; // the plain POST still works
    event.preventDefault();
    if (form.dataset.sending === "true") return;
    if (!form.reportValidity()) return;
    if (unknownDraft && (body?.value !== unknownDraft.body || filesGeneration !== unknownDraft.files) && key) key.value = newClientMessageKey();
    const sentBody = body?.value ?? "";
    const sentFiles = filesGeneration;
    const identity = identityVersion;

    form.dataset.sending = "true";
    if (button) {
      button.disabled = true;
      button.textContent = button.dataset.busyLabel ?? button.textContent;
    }
    setStatus(status, button?.dataset.busyLabel ?? "", "success");

    let answer: PostAnswer | null = null;
    let ok = false;
    const pending = conversationRequest(90_000);
    try {
      const data = new FormData(form);
      const photos = chosenPhotos(data);
      if (photos.length > 0) await encodePhotos(data, photos);
      const response = await fetch(form.action, {
        method: "POST",
        body: data,
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        signal: pending.signal,
      });
      answer = await response.json().catch(() => null) as PostAnswer | null;
      ok = response.ok && answer?.success === true;
    } catch {
      answer = null;
    } finally { pending.done(); }

    form.dataset.sending = "false";
    // Navigation and account changes invalidate DOM work, not a committed POST.
    if (!form.isConnected || identity !== identityVersion) return;
    if (button) {
      button.disabled = false;
      button.textContent = button.dataset.idleLabel ?? button.textContent;
    }

    if (!ok) {
      // Keep the text and the same idempotency key so a retry posts once.
      const message = typeof answer?.error?.message === "string"
        ? answer.error.message
        : conversationStatusMessage("unavailable").text;
      setStatus(status, message, "error");
      unknownDraft = { body: sentBody, files: sentFiles };
      body?.focus();
      return;
    }

    if (typeof answer?.data?.redirect === "string" && answer.data.redirect.startsWith("/")) {
      window.location.assign(pagePath(answer.data.redirect));
      return;
    }
    unknownDraft = null;
    if (Array.isArray(answer?.data?.items)) {
      const update = { conversationId: answer?.data?.conversationId ?? null, items: answer.data.items, hasOlder: answer.data.hasOlder };
      if (!notifyConversationSent(list, update)) {
        const cursor = Math.max(0, ...Array.from(list.querySelectorAll<HTMLElement>("[data-seq]")).map((node) => Number(node.dataset.seq) || 0));
        appendConversationItems(list, update.items, cursor);
      }
    }
    if (body?.value === sentBody) body.value = "";
    fitBody();
    if (filesGeneration === sentFiles) {
      if (files) files.value = "";
      clearPreviews();
    }
    if (key) key.value = newClientMessageKey();
    setStatus(status, typeof answer?.data?.message === "string" ? answer.data.message : conversationStatusMessage("sent").text, "success");
    body?.focus();
  });
}

let identityVersion = 0;
let identityBound = false;

/** Enhances every conversation form on the page once. */
export function bindConversationForms(): void {
  if (!identityBound) {
    identityBound = true;
    const changed = () => {
      identityVersion += 1;
      document.querySelectorAll<HTMLFormElement>("form[data-conversation-form]").forEach((form) => {
        form.reset();
        form.querySelectorAll<HTMLTextAreaElement>("textarea[name=body]").forEach((body) => { body.value = ""; });
        form.querySelectorAll<HTMLButtonElement>("button[type=submit]").forEach((button) => { button.disabled = true; });
        setStatus(form.querySelector("[data-conversation-status]"), "Your account changed. Reload before sending a message.", "error");
      });
    };
    window.addEventListener("customer-login", changed);
    window.addEventListener("customer-logout", changed);
  }
  document.querySelectorAll<HTMLFormElement>("form[data-conversation-form]").forEach(bindForm);
}
