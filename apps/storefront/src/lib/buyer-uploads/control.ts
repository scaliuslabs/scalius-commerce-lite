/**
 * The buyer's file upload control, the behaviour (loaded by load.ts only
 * where a file input is drawn, as its own chunk). It enhances the markup
 * BuyerUploadField.astro and the checkout renderer (lib/buyer-ui) draw:
 *
 * - the chosen files are checked here first (kind, size, how many: model.ts;
 *   the API checks again from the bytes), then sent one at a time to the
 *   same-origin `/api/uploads` with their progress shown;
 * - the answer (the upload ids joined by commas) is the hidden input under
 *   the field's normal name, so the buy form, the cart line and the checkout
 *   answers carry it as they carry any other answer (an `input` and a
 *   `change` event tell their listeners);
 * - Remove drops a file from the answer and takes back, best effort, a file
 *   this page uploaded that no cart line holds (the sweep deletes the rest).
 *
 * The file names stay in this page's memory: they are never stored, logged
 * or put in a URL. A file the answer held before this page is named by its
 * place ("Uploaded file 1").
 */
import { buyerUploadCopy, type BuyerUploadCopy } from "@/lib/buyer-upload-copy";
import { formatPageNumber, pageLanguage } from "@/lib/store-time-zone";
import { BUYER_UPLOAD_SELECTOR } from "./load";
import {
  BUYER_UPLOAD_ENDPOINT,
  buyerUploadAnswer,
  buyerUploadAnswerIds,
  buyerUploadFailure,
  buyerUploadPercent,
  buyerUploadProblemText,
  formatBuyerUploadSize,
  planBuyerUploadSelection,
  readBuyerUploadDataset,
  readStagedBuyerUpload,
  type BuyerUploadField,
  type BuyerUploadProblem,
} from "./model";

const UPLOAD_TIMEOUT_MS = 120_000;

type EntryStatus = "queued" | "uploading" | "done" | "error";

interface Entry {
  uid: number;
  id: string | null;
  name: string;
  size: number;
  status: EntryStatus;
  percent: number;
  problem: BuyerUploadProblem | null;
  /** Uploaded by this page: Remove may take it back. */
  own: boolean;
  file: File | null;
  xhr: XMLHttpRequest | null;
  node: HTMLLIElement | null;
}

interface Parts {
  root: HTMLElement;
  input: HTMLInputElement;
  answer: HTMLInputElement;
  list: HTMLElement;
  status: HTMLElement | null;
  pick: HTMLElement | null;
  pickLabel: HTMLElement | null;
}

interface UploadState {
  field: BuyerUploadField;
  parts: Parts;
  entries: Entry[];
  sending: boolean;
  readonly: boolean;
}

/** One state per control (by its file input's id), so a re-drawn checkout keeps an upload in flight. */
const states = new Map<string, UploadState>();
/** What this page uploaded, by id: the names it shows after a re-draw. */
const uploaded = new Map<string, { name: string; size: number }>();
let nextUid = 1;

function text(): { copy: BuyerUploadCopy; language: string } {
  const language = pageLanguage();
  return { copy: buyerUploadCopy(language), language };
}

function partsOf(root: HTMLElement): Parts | null {
  const input = root.querySelector<HTMLInputElement>("input[type=file][data-buyer-upload-input]");
  const answer = root.querySelector<HTMLInputElement>("input[data-buyer-upload-answer]");
  const list = root.querySelector<HTMLElement>("[data-buyer-upload-list]");
  if (!input || !answer || !list) return null;
  return {
    root,
    input,
    answer,
    list,
    status: root.querySelector<HTMLElement>("[data-buyer-upload-status]"),
    pick: root.querySelector<HTMLElement>("[data-buyer-upload-pick]"),
    pickLabel: root.querySelector<HTMLElement>("[data-buyer-upload-pick-label]"),
  };
}

function keptEntry(id: string, position: number, copy: BuyerUploadCopy, language: string): Entry {
  const known = uploaded.get(id);
  return {
    uid: nextUid++,
    id,
    name: known?.name || copy.keptFile(formatPageNumber(position, language)),
    size: known?.size ?? 0,
    status: "done",
    percent: 100,
    problem: null,
    own: Boolean(known),
    file: null,
    xhr: null,
    node: null,
  };
}

function doneIds(state: UploadState): string[] {
  return state.entries.flatMap((entry) => (entry.status === "done" && entry.id ? [entry.id] : []));
}

function held(state: UploadState): number {
  return state.entries.filter((entry) => entry.status !== "error").length;
}

function busy(state: UploadState): boolean {
  return state.entries.some((entry) => entry.status === "queued" || entry.status === "uploading");
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** The answer's files as entries, keeping the entries of the ids it already shows (and any upload in flight). */
function reconcile(state: UploadState): void {
  const ids = buyerUploadAnswerIds(state.parts.answer.value, state.field.maxFiles);
  if (sameIds(ids, doneIds(state))) return;
  const { copy, language } = text();
  const byId = new Map(state.entries.flatMap((entry) => (entry.status === "done" && entry.id ? [[entry.id, entry] as const] : [])));
  const pending = state.entries.filter((entry) => entry.status !== "done");
  state.entries = [...ids.map((id, index) => byId.get(id) ?? keptEntry(id, index + 1, copy, language)), ...pending];
}

function announce(state: UploadState, message: string): void {
  const status = state.parts.status;
  if (!status) return;
  // A repeated message is still heard: clear, then say it in the next frame.
  status.textContent = "";
  requestAnimationFrame(() => { status.textContent = message; });
}

function fieldLabel(state: UploadState): string {
  const id = state.parts.input.id;
  const label = id ? state.parts.root.ownerDocument.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`) : null;
  return label?.textContent?.replace(/\s+/g, " ").trim() || state.field.field;
}

/** The picker's state and the message a form check reports: wait for an upload, or upload a required file. */
function syncControl(state: UploadState): void {
  const { copy } = text();
  const { input, root, pick, pickLabel } = state.parts;
  const full = held(state) >= state.field.maxFiles;
  if (pickLabel) pickLabel.textContent = state.field.maxFiles > 1 ? copy.chooseFiles : copy.chooseFile;
  if (full) input.setAttribute("aria-disabled", "true");
  else input.removeAttribute("aria-disabled");
  pick?.classList.toggle("opacity-50", full);
  const waiting = busy(state);
  if (waiting) root.dataset.buyerUploadBusy = "true";
  else delete root.dataset.buyerUploadBusy;
  input.setCustomValidity(
    waiting ? copy.wait : state.field.required && doneIds(state).length === 0 ? copy.required(fieldLabel(state)) : "",
  );
}

/** Writes the answer; the form's listeners hear an `input` and a `change`. */
function commit(state: UploadState): void {
  const value = buyerUploadAnswer(doneIds(state));
  const { answer } = state.parts;
  if (answer.value !== value) {
    answer.value = value;
    answer.dispatchEvent(new Event("input", { bubbles: true }));
    answer.dispatchEvent(new Event("change", { bubbles: true }));
  }
  syncControl(state);
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function entryNode(state: UploadState, entry: Entry): HTMLLIElement {
  if (entry.node) return entry.node;
  const item = element("li", "flex flex-col gap-2 rounded-lg border border-border bg-background p-3 sm:flex-row sm:items-center");
  const body = element("div", "min-w-0 flex-1 space-y-1");
  const name = element("p", "break-all text-sm font-medium text-foreground");
  name.dataset.uploadName = "";
  const meta = element("p", "text-sm text-muted-foreground");
  meta.dataset.uploadMeta = "";
  const progress = element("progress", "block h-2 w-full overflow-hidden rounded-full accent-primary");
  progress.max = 100;
  progress.dataset.uploadProgress = "";
  const error = element("p", "text-sm font-medium text-destructive");
  error.dataset.uploadError = "";
  body.append(name, meta, progress, error);
  item.append(body);
  if (!state.readonly) {
    const remove = element(
      "button",
      "inline-flex min-h-11 w-full shrink-0 items-center justify-center rounded-lg border border-input bg-background px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 sm:w-auto",
    );
    remove.type = "button";
    remove.dataset.uploadRemove = "";
    remove.addEventListener("click", () => removeEntry(state, entry));
    item.append(remove);
  }
  entry.node = item;
  return item;
}

function paintEntry(state: UploadState, entry: Entry): void {
  const { copy, language } = text();
  const item = entryNode(state, entry);
  const name = item.querySelector<HTMLElement>("[data-upload-name]")!;
  const meta = item.querySelector<HTMLElement>("[data-upload-meta]")!;
  const progress = item.querySelector<HTMLProgressElement>("[data-upload-progress]")!;
  const error = item.querySelector<HTMLElement>("[data-upload-error]")!;
  const remove = item.querySelector<HTMLButtonElement>("[data-upload-remove]");
  name.textContent = entry.name;
  const size = entry.size > 0 ? formatBuyerUploadSize(entry.size, language) : "";
  const sending = entry.status === "queued" || entry.status === "uploading";
  const progressText = copy.uploading(`${formatPageNumber(entry.percent, language)}%`);
  meta.textContent = sending
    ? [size, progressText].filter(Boolean).join(" · ")
    : entry.status === "done" ? [size, copy.uploaded].filter(Boolean).join(" · ") : size;
  meta.hidden = !meta.textContent;
  progress.hidden = !sending;
  progress.value = entry.percent;
  progress.setAttribute("aria-label", entry.name);
  progress.setAttribute("aria-valuetext", progressText);
  error.hidden = entry.status !== "error";
  error.textContent = entry.status === "error" && entry.problem
    ? buyerUploadProblemText(copy, entry.problem, state.field, language)
    : "";
  item.toggleAttribute("aria-invalid", entry.status === "error");
  if (remove) {
    remove.textContent = copy.remove;
    remove.setAttribute("aria-label", copy.removeFor(entry.name));
  }
}

/** Draws the list: entries in their order, each node kept (a focused Remove keeps its focus while others update). */
function paint(state: UploadState): void {
  for (const entry of state.entries) paintEntry(state, entry);
  const nodes = state.entries.map((entry) => entry.node!);
  const { list } = state.parts;
  const current = Array.from(list.children);
  if (current.length !== nodes.length || current.some((node, index) => node !== nodes[index])) list.replaceChildren(...nodes);
  list.hidden = nodes.length === 0;
  syncControl(state);
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Takes back, best effort, a file this page uploaded that nothing holds now. */
async function takeBack(field: BuyerUploadField, id: string): Promise<void> {
  if (field.target === "line" && await heldByCart(id)) return;
  try {
    await fetch(`${BUYER_UPLOAD_ENDPOINT}/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      keepalive: true,
    });
  } catch {
    // The scheduled sweep deletes a file no order takes.
  }
}

/** Whether a cart line answers with this upload (the line added earlier keeps its file). */
async function heldByCart(id: string): Promise<boolean> {
  try {
    const { cartStore } = await import("@/store/cart");
    return Object.values(cartStore.get().items).some((item) =>
      (item.properties ?? []).some((property) => property.value.split(",").some((value) => value.trim() === id)));
  } catch {
    return true;
  }
}

function send(state: UploadState, entry: Entry): Promise<void> {
  return new Promise((resolve) => {
    const file = entry.file;
    if (!file) {
      resolve();
      return;
    }
    const xhr = new XMLHttpRequest();
    entry.xhr = xhr;
    entry.status = "uploading";
    paint(state);
    const finish = (problem: BuyerUploadProblem | null) => {
      entry.xhr = null;
      entry.file = null;
      if (state.entries.includes(entry)) {
        if (problem) {
          entry.status = "error";
          entry.problem = problem;
          const { copy, language } = text();
          announce(state, `${entry.name}: ${buyerUploadProblemText(copy, problem, state.field, language)}`);
        }
        paint(state);
        commit(state);
      }
      resolve();
    };
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || !state.entries.includes(entry)) return;
      entry.percent = buyerUploadPercent(event.loaded, event.total);
      paintEntry(state, entry);
    });
    xhr.addEventListener("load", () => {
      const payload = safeJson(xhr.responseText);
      const staged = xhr.status === 201 ? readStagedBuyerUpload(payload) : null;
      if (!staged) {
        finish(buyerUploadFailure(xhr.status, payload));
        return;
      }
      uploaded.set(staged.id, { name: staged.filename || entry.name, size: staged.sizeBytes || entry.size });
      if (!state.entries.includes(entry)) {
        // Removed while it was sending: nothing holds it.
        void takeBack(state.field, staged.id);
        finish(null);
        return;
      }
      entry.id = staged.id;
      entry.name = staged.filename || entry.name;
      entry.size = staged.sizeBytes || entry.size;
      entry.status = "done";
      entry.percent = 100;
      entry.own = true;
      announce(state, `${entry.name}: ${text().copy.uploaded}`);
      finish(null);
    });
    xhr.addEventListener("error", () => finish("failed"));
    xhr.addEventListener("timeout", () => finish("failed"));
    xhr.addEventListener("abort", () => finish(null));
    const body = new FormData();
    body.append("field", state.field.field);
    body.append("target", state.field.target);
    if (state.field.target === "line" && state.field.productId) body.append("productId", state.field.productId);
    body.append("file", file, file.name);
    xhr.open("POST", BUYER_UPLOAD_ENDPOINT);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.send(body);
  });
}

/** Sends the queued files one at a time (each passes the API's per-visitor limits on its own). */
async function pump(state: UploadState): Promise<void> {
  if (state.sending) return;
  state.sending = true;
  try {
    for (let next = state.entries.find((entry) => entry.status === "queued"); next; next = state.entries.find((entry) => entry.status === "queued")) {
      await send(state, next);
    }
  } finally {
    state.sending = false;
  }
}

function choose(state: UploadState): void {
  const { input } = state.parts;
  const files = Array.from(input.files ?? []);
  // The picker starts empty again: the list shows what was chosen, and the same file can be chosen again.
  input.value = "";
  if (files.length === 0) return;
  // A refused file from an earlier choice gives its place to the new ones.
  state.entries = state.entries.filter((entry) => entry.status !== "error");
  const plan = planBuyerUploadSelection(files, state.field, held(state));
  const entry = (file: File, status: EntryStatus, problem: BuyerUploadProblem | null): Entry => ({
    uid: nextUid++, id: null, name: file.name, size: file.size, status, percent: 0, problem, own: false,
    file: status === "queued" ? file : null, xhr: null, node: null,
  });
  state.entries.push(
    ...plan.send.map((file) => entry(file, "queued", null)),
    ...plan.refused.map(({ file, problem }) => entry(file, "error", problem)),
  );
  paint(state);
  const { copy, language } = text();
  const first = plan.refused[0];
  announce(state, first
    ? `${first.file.name}: ${buyerUploadProblemText(copy, first.problem, state.field, language)}`
    : plan.send.length > 0 ? `${plan.send[0]!.name}: ${copy.uploading(`${formatPageNumber(0, language)}%`)}` : "");
  void pump(state);
}

function removeEntry(state: UploadState, entry: Entry): void {
  const index = state.entries.indexOf(entry);
  if (index < 0) return;
  state.entries.splice(index, 1);
  entry.xhr?.abort();
  if (entry.status === "done" && entry.id) {
    const id = entry.id;
    uploaded.delete(id);
    // A file the answer held before this page may be an order's or a line's: the sweep decides.
    if (entry.own) void takeBack(state.field, id);
  }
  paint(state);
  commit(state);
  const { copy } = text();
  announce(state, copy.removed(entry.name));
  // Focus stays in the control: the next file's Remove, else the previous one's, else the picker.
  const neighbour = state.entries[index] ?? state.entries[index - 1];
  const target = neighbour?.node?.querySelector<HTMLButtonElement>("[data-upload-remove]") ?? state.parts.input;
  target.focus();
}

function enhance(root: HTMLElement): void {
  const field = readBuyerUploadDataset(root);
  const parts = partsOf(root);
  if (!field || !parts) return;
  const key = parts.input.id || field.field;
  let state = states.get(key);
  if (state && state.parts.root === root) {
    // Called again (the product page filled an edited line's answer): show what the answer holds now.
    if (!busy(state)) {
      reconcile(state);
      paint(state);
    }
    return;
  }
  const readonly = parts.input.disabled || root.hasAttribute("data-upload-readonly");
  if (state && !state.parts.root.isConnected) {
    // The checkout drew this field again: the same files, and any upload in flight, carry over.
    for (const entry of state.entries) entry.node = null;
    state.parts = parts;
    state.field = field;
    state.readonly = readonly;
  } else {
    state = { field, parts, entries: [], sending: false, readonly };
  }
  states.set(key, state);
  reconcile(state);
  const current = state;
  if (!readonly) {
    parts.input.addEventListener("click", (event) => {
      if (held(current) < current.field.maxFiles) return;
      // Full: the picker stays closed and says why.
      event.preventDefault();
      const { copy, language } = text();
      announce(current, copy.full(formatPageNumber(current.field.maxFiles, language)));
    });
    parts.input.addEventListener("change", (event) => {
      // The picker's own change is the control's, not the form's: the answer's change follows.
      event.stopPropagation();
      choose(current);
    });
    parts.input.addEventListener("input", (event) => event.stopPropagation());
  }
  paint(state);
}

/** Enhances every file input under `root` (and `root` itself, when it is one); idempotent. */
export function enhanceBuyerUploads(root: ParentNode = document): void {
  const roots = [
    ...(root instanceof HTMLElement && root.matches(BUYER_UPLOAD_SELECTOR) ? [root] : []),
    ...Array.from(root.querySelectorAll<HTMLElement>(BUYER_UPLOAD_SELECTOR)),
  ];
  for (const element of roots) enhance(element);
}

/** Whether a control under `root` is still sending a file (a form waits for it). */
export function buyerUploadsBusy(root: ParentNode): boolean {
  return root.querySelector("[data-buyer-upload][data-buyer-upload-busy]") !== null;
}
