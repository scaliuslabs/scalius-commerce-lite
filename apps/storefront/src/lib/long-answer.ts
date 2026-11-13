/**
 * A buyer's long answer on a line (an engraving, a note, a 1,000-character
 * message) folds to three lines with "Show more" on every surface that lists
 * it: the cart page, the drawer, quick checkout, the receipt and the account's
 * order page. A cart of long answers once printed them in full, so its
 * message and Place order sat 68,000 px down the page.
 *
 * The fold is a `<details>` and a stylesheet rule (global.css
 * `.long-answer`), so it costs no script and works on a page that runs none;
 * the whole answer stays in the page, so a screen reader reads all of it. A
 * short answer is drawn as it is: only a fold that holds more than fits gets
 * the control.
 */
import { cartLineCopy, isLongAnswer } from "./cart-line-copy";

export { isLongAnswer, LONG_ANSWER_CHARACTERS } from "./cart-line-copy";

export interface LongAnswerWords {
  more: string;
  less: string;
}

/** The fold's words in the page's language (the cart line's catalogue holds them). */
export function longAnswerWords(language: string): LongAnswerWords {
  const copy = cartLineCopy(language);
  return { more: copy.answerMore, less: copy.answerLess };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * The answer as escaped HTML: as it is when short, else folded. `innerHtml`
 * is already-escaped markup to fold instead of `text` (a label in bold, say);
 * `text` still decides whether it is long.
 */
export function longAnswerHtml(text: string, words: LongAnswerWords, innerHtml: string = escapeHtml(text)): string {
  if (!isLongAnswer(text)) return innerHtml;
  return `<span class="long-answer block" data-long-answer><span class="long-answer-text" data-answer-text>${innerHtml}</span><details class="long-answer-toggle"><summary><span class="long-answer-more">${escapeHtml(words.more)}</span><span class="long-answer-less">${escapeHtml(words.less)}</span></summary></details></span>`;
}
