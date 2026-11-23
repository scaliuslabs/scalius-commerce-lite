// An account edit form's Save waits for a change: each field marked
// `data-saved` holds the saved value, and Save is enabled only while one
// differs. A failed save re-renders with the posted values, which still differ
// from the saved ones, so the buyer can send them again. Without JavaScript
// the form keeps an enabled Save (the server answers an unchanged form too).
// A dialog (popover) closed without saving drops its edits.
import { onTextEdit } from "./text-edits";

/** Disables `form`'s submit buttons until a `[data-saved]` field differs from its saved value. */
export function saveWhenChanged(form: HTMLFormElement): void {
  const fields = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-saved]")];
  const buttons = [...form.querySelectorAll<HTMLButtonElement>("button[type=submit]")];
  if (fields.length === 0 || buttons.length === 0) return;
  const update = () => {
    const changed = fields.some((field) => field.value.trim() !== (field.dataset.saved ?? "").trim());
    for (const button of buttons) button.disabled = !changed;
  };
  // It only reads whether a field changed, so every composition step may run it.
  onTextEdit(form, update, undefined, { live: true });
  form.addEventListener("reset", () => queueMicrotask(update));
  form.closest("[popover]")?.addEventListener("toggle", (event) => {
    if ((event as Event & { newState?: string }).newState === "closed") form.reset();
  });
  update();
}
