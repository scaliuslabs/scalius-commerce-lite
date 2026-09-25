// The review forms in the browser: the same `method=post` to
// /api/reviews/submit, sent with fetch so an error shows beside the form
// without losing what the buyer typed. Success goes to the page the server
// names (the outcome flag and the line's anchor), exactly as without
// JavaScript. If the request itself fails, the form is posted normally.
// Review text only ever goes in the POST body.

interface ReviewPostAnswer {
  ok?: unknown;
  location?: unknown;
  message?: unknown;
  editHref?: unknown;
  editText?: unknown;
}

function sameOriginPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return null;
  return value;
}

function go(location: string): void {
  const next = new URL(location, window.location.origin);
  const here = new URL(window.location.href);
  if (next.pathname === here.pathname && next.search === here.search) {
    // Same page and query: a hash change alone would not reload it.
    window.location.hash = next.hash;
    window.location.reload();
    return;
  }
  window.location.assign(next.toString());
}

function showError(form: HTMLFormElement, answer: ReviewPostAnswer): void {
  const slot = form.querySelector<HTMLElement>("[data-review-form-error]");
  if (!slot || typeof answer.message !== "string") return;
  slot.textContent = answer.message;
  const editHref = sameOriginPath(answer.editHref);
  if (editHref && typeof answer.editText === "string") {
    const link = document.createElement("a");
    link.href = editHref;
    link.className = "ml-1 underline";
    link.textContent = answer.editText;
    slot.append(" ", link);
  }
  slot.hidden = false;
  slot.focus?.();
}

async function submit(form: HTMLFormElement): Promise<void> {
  const buttons = [...form.querySelectorAll<HTMLButtonElement>("button[type=submit]")];
  buttons.forEach((button) => { button.disabled = true; });
  const slot = form.querySelector<HTMLElement>("[data-review-form-error]");
  if (slot) slot.hidden = true;
  try {
    const response = await fetch(form.action, {
      method: "POST",
      body: new URLSearchParams(new FormData(form) as unknown as Record<string, string>),
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    const answer = await response.json() as ReviewPostAnswer;
    const location = sameOriginPath(answer.location);
    if (answer.ok === true && location) {
      go(location);
      return;
    }
    if (!response.ok || typeof answer.message !== "string") throw new Error("unreadable");
    showError(form, answer);
    buttons.forEach((button) => { button.disabled = false; });
  } catch {
    // The plain post still works (and reports the outcome on the page).
    form.dataset.reviewNative = "true";
    form.submit();
  }
}

/** Binds once per page, for every review form now and later (the account order page renders late). */
export function setupReviewForms(): void {
  const scope = window as Window & { __scaliusReviewForms?: boolean };
  if (scope.__scaliusReviewForms) return;
  scope.__scaliusReviewForms = true;
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-review-form")) return;
    if (form.dataset.reviewNative === "true" || typeof fetch !== "function") return;
    event.preventDefault();
    void submit(form);
  });
  // An emailed link (`#reviews`) or a returned outcome (`#review-<line>`):
  // bring the line into view once the page has rendered it.
  const hash = window.location.hash;
  if (!/^#reviews?(?:-[A-Za-z0-9_-]{1,128})?$/.test(hash)) return;
  let tries = 0;
  const reveal = () => {
    const target = hash === "#reviews"
      ? document.querySelector<HTMLElement>("[data-review-line]")
      : document.getElementById(hash.slice(1));
    if (target) {
      target.scrollIntoView({ block: "center" });
      return;
    }
    if ((tries += 1) < 40) window.setTimeout(reveal, 150);
  };
  reveal();
}
