/**
 * The storefront's confirmation dialog: before an app's choice is taken (a
 * line input option's `confirm`: the app's agreement, an "I agree" tick box
 * and Go back / Confirm), and before a step the buyer can't undo (removing a
 * review: no tick box, focus starts on Go back). It is labelled by its title
 * and described by its text; the page behind is inert while it is open (a
 * modal `<dialog>`), so focus stays inside; Escape and Go back answer false
 * and record nothing; Confirm stays off until the box (when there is one) is
 * ticked. Focus returns to what opened it. Loaded only when it is needed.
 */
import { cartLineInputCopy } from "@/lib/cart-line-input-copy";

export interface ConfirmChoiceWords {
  title: string;
  /** The agreement, shown whole (the app's words in the buyer's language). */
  text: string;
  /** The tick box's words; without them there is no box and Confirm is on. */
  agree?: string;
  goBack: string;
  confirm: string;
  /** The items the agreement is taken for (Place order with undecided lines), under a heading. */
  items?: { heading: string; names: readonly string[] };
}

let sequence = 0;

/** Asks for an app choice's confirmation in the page's language (the host's words where the app gave none). */
export function confirmCartChoice(confirm: { text: string; title?: string; agree?: string }, opener?: HTMLElement): Promise<boolean> {
  const copy = cartLineInputCopy();
  return confirmLineChoice({
    title: confirm.title ?? copy.confirmTitle,
    text: confirm.text,
    agree: confirm.agree ?? copy.agree,
    goBack: copy.goBack,
    confirm: copy.confirm,
  }, document, opener);
}

/** Asks the buyer; resolves true only when they ticked the box and confirmed. */
export function confirmLineChoice(words: ConfirmChoiceWords, doc: Document = document, from?: HTMLElement): Promise<boolean> {
  // Focus returns to the control that asked (a select the buyer changed), else to what had it.
  const opener = from ?? (doc.activeElement instanceof HTMLElement ? doc.activeElement : null);
  const id = `scalius-confirm-${++sequence}`;
  const dialog = doc.createElement("dialog");
  dialog.setAttribute("aria-labelledby", `${id}-title`);
  dialog.setAttribute("aria-describedby", `${id}-text`);
  dialog.dataset.cartLineConfirm = "";
  dialog.className = "m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-border bg-card p-0 text-card-foreground shadow-xl backdrop:bg-black/50";

  const form = doc.createElement("form");
  form.method = "dialog";
  form.className = "grid gap-4 p-5";
  const title = doc.createElement("h2");
  title.id = `${id}-title`;
  title.className = "text-lg font-semibold text-foreground";
  title.textContent = words.title;
  const text = doc.createElement("p");
  text.id = `${id}-text`;
  text.className = "whitespace-pre-line text-sm text-muted-foreground";
  text.textContent = words.text;
  const label = words.agree === undefined ? null : doc.createElement("label");
  const box = label ? doc.createElement("input") : null;
  if (label && box) {
    label.className = "flex min-h-11 cursor-pointer items-start gap-3 text-sm font-medium text-foreground";
    box.type = "checkbox";
    box.className = "mt-0.5 size-5 shrink-0 accent-primary";
    const agree = doc.createElement("span");
    agree.textContent = words.agree!;
    label.append(box, agree);
  }
  const items = words.items && words.items.names.length > 0 ? doc.createElement("div") : null;
  if (items && words.items) {
    items.className = "grid gap-1 text-sm text-foreground";
    const heading = doc.createElement("p");
    heading.className = "font-medium";
    heading.textContent = words.items.heading;
    const list = doc.createElement("ul");
    list.className = "list-disc ps-5 text-muted-foreground";
    for (const name of words.items.names) {
      const entry = doc.createElement("li");
      entry.textContent = name;
      list.append(entry);
    }
    items.append(heading, list);
  }
  const actions = doc.createElement("div");
  actions.className = "flex flex-wrap justify-end gap-2";
  const back = doc.createElement("button");
  back.type = "button";
  back.className = "min-h-11 rounded-md border border-border px-4 text-sm font-medium text-foreground hover:bg-muted";
  back.textContent = words.goBack;
  const confirm = doc.createElement("button");
  confirm.type = "submit";
  confirm.disabled = box !== null;
  confirm.className = "min-h-11 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50";
  confirm.textContent = words.confirm;
  actions.append(back, confirm);
  form.append(title, text);
  if (items) form.append(items);
  if (label) form.append(label);
  form.append(actions);
  dialog.append(form);

  return new Promise<boolean>((resolve) => {
    let agreed = false;
    const finish = () => {
      dialog.remove();
      opener?.focus?.();
      resolve(agreed);
    };
    box?.addEventListener("change", () => { confirm.disabled = !box.checked; });
    back.addEventListener("click", () => dialog.close());
    form.addEventListener("submit", (event) => {
      if (box && !box.checked) {
        event.preventDefault();
        return;
      }
      agreed = true;
    });
    // Escape: the dialog cancels and nothing is recorded (also where the browser's own cancel does not run).
    dialog.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dialog.close();
    });
    dialog.addEventListener("close", finish, { once: true });
    doc.body.append(dialog);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    (box ?? back).focus();
  });
}
