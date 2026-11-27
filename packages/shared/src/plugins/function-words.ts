// An app's labels in a function's answer that are drawn as or beside the
// store's money rows: an add-on's title and detail lines (`cart.line_prices`
// adjustments and offers), a discount's title (`checkout.discounts`) and a
// bundle's title (`cart.transform`). One that passes for the store's amount
// word (store-words.ts) is never allowed to stand, and never allowed to drop
// the answer either: a refused answer would lose an app's other operations, or
// stop every checkout where the app is blocking, for one word a merchant may
// have typed in the app's settings. So the label alone is replaced by the
// store's own neutral word for that row (or left out where the row has a name
// of its own), and the app is told in its log; the rest of the answer stands.
// Payment method and shipping rate renames are names in a list the buyer picks
// from, drawn inside the store's own words on the totals row ("Delivery ·
// {method}"), and are not held to these words.
import { STORE_ACTION_AND_AMOUNT_WORDS, storeWordsIssue, storeWordsMessage, type StoreWordLabelKind } from "../store-words";
import { LINE_ENTRY_WORDS_BN, lineEntryWords } from "../line-entry-words";

type Row = Record<string, unknown>;

/** The answer with each label that passes for the store's word replaced, and what was replaced (for the app's log). */
export function adjustFunctionWords(point: string, value: unknown, language: string | null): { value: unknown; notices: string[] } {
  const notices: string[] = [];
  if (point !== "cart.line_prices" && point !== "checkout.discounts" && point !== "cart.transform") return { value, notices };
  // The buyer's language, as the store's line words choose it (Bangla for `bn`, else English).
  const words = lineEntryWords(language);
  const discountWord = STORE_ACTION_AND_AMOUNT_WORDS.discountText![words === LINE_ENTRY_WORDS_BN ? "bn" : "en"];
  /** The label, or the neutral word when it passes for the store's (null: leave it out). */
  const checked = (text: unknown, kind: StoreWordLabelKind, where: string, neutral: string | null): string | null | undefined => {
    if (typeof text !== "string") return text as undefined;
    const issue = storeWordsIssue(text, kind);
    if (!issue) return text;
    notices.push(`${where}: ${storeWordsMessage(text, issue, "name what yours is")} ${neutral === null ? "It was left out." : `It was drawn as "${neutral}".`}`);
    return neutral;
  };
  const answer = structuredClone(value) as Row;
  const rows = (key: string) => (Array.isArray(answer[key]) ? answer[key] as Row[] : []);
  if (point === "cart.line_prices") {
    for (const [index, row] of rows("adjustments").entries()) {
      row.title = checked(row.title, "add-on", `adjustments.${index}.title`, words.lineAddOnText);
      if (Array.isArray(row.details)) {
        const details = (row.details as string[]).map((detail, at) => checked(detail, "add-on-detail", `adjustments.${index}.details.${at}`, null));
        row.details = details.filter((detail): detail is string => typeof detail === "string");
      }
    }
    for (const [index, row] of rows("offers").entries()) row.title = checked(row.title, "add-on", `offers.${index}.title`, words.lineAddOnText);
  } else if (point === "checkout.discounts") {
    for (const [index, row] of rows("discounts").entries()) row.title = checked(row.title, "discount", `discounts.${index}.title`, discountWord);
  } else {
    for (const [index, row] of rows("operations").entries()) {
      if (row.op === "merge") row.title = checked(row.title, "bundle", `operations.${index}.title`, words.lineBundleText);
      if (row.op === "expand" && row.title !== undefined && checked(row.title, "bundle", `operations.${index}.title`, null) === null) delete row.title;
    }
  }
  return notices.length === 0 ? { value, notices } : { value: answer, notices };
}
