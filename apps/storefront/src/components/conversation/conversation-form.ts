// Progressive enhancement for conversation forms (ConversationReplyForm.astro).
// The form already works as a plain POST; this sends the same FormData with
// fetch, asks for JSON, and swaps in the re-rendered thread. The message text
// stays in the request body and is never logged or sent to analytics.

import {
  checkAttachmentFiles,
  conversationStatusMessage,
  newClientMessageKey,
} from "@/lib/account-inbox";

type Tone = "success" | "error";

interface PostAnswer {
  success?: boolean;
  data?: { messagesHtml?: unknown; message?: unknown; redirect?: unknown };
  error?: { message?: unknown };
}

function setStatus(element: HTMLElement | null, text: string, tone: Tone): void {
  if (!element) return;
  element.textContent = text;
  element.classList.toggle("text-destructive", tone === "error");
  element.classList.toggle("text-primary", tone === "success");
}

function bindForm(form: HTMLFormElement): void {
  if (form.dataset.conversationBound === "true") return;
  form.dataset.conversationBound = "true";

  const status = form.querySelector<HTMLElement>("[data-conversation-status]");
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
  const body = form.querySelector<HTMLTextAreaElement>("textarea[name=body]");
  const key = form.querySelector<HTMLInputElement>("input[name=clientMessageKey]");
  const files = form.querySelector<HTMLInputElement>("input[type=file][name=images]");
  const previews = form.querySelector<HTMLElement>("[data-conversation-previews]");
  let previewUrls: string[] = [];

  const clearPreviews = () => {
    previewUrls.forEach((url) => URL.revokeObjectURL(url));
    previewUrls = [];
    previews?.replaceChildren();
  };

  files?.addEventListener("change", () => {
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

    form.dataset.sending = "true";
    if (button) {
      button.disabled = true;
      button.textContent = button.dataset.busyLabel ?? button.textContent;
    }
    setStatus(status, button?.dataset.busyLabel ?? "", "success");

    let answer: PostAnswer | null = null;
    let ok = false;
    try {
      const response = await fetch(form.action, {
        method: "POST",
        body: new FormData(form),
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      answer = await response.json().catch(() => null) as PostAnswer | null;
      ok = response.ok && answer?.success === true;
    } catch {
      answer = null;
    }

    form.dataset.sending = "false";
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
      body?.focus();
      return;
    }

    if (typeof answer?.data?.redirect === "string" && answer.data.redirect.startsWith("/")) {
      window.location.assign(answer.data.redirect);
      return;
    }
    if (typeof answer?.data?.messagesHtml === "string") {
      list.innerHTML = answer.data.messagesHtml;
      list.hidden = false;
      list.lastElementChild?.scrollIntoView({ block: "nearest" });
    }
    form.reset();
    clearPreviews();
    if (key) key.value = newClientMessageKey();
    setStatus(status, typeof answer?.data?.message === "string" ? answer.data.message : conversationStatusMessage("sent").text, "success");
    body?.focus();
  });
}

/** Enhances every conversation form on the page once. */
export function bindConversationForms(): void {
  document.querySelectorAll<HTMLFormElement>("form[data-conversation-form]").forEach(bindForm);
}
