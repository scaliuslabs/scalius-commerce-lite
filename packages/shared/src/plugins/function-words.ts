// An app's labels in a function's answer that the buyer reads beside the
// store's money rows and actions: an add-on's title and detail lines
// (`cart.line_prices` adjustments and offers), a discount's title
// (`checkout.discounts`), a bundle's title (`cart.transform`) and a payment
// method's or shipping rate's new name (`rename`). One that passes for the
// store's word (store-words.ts) is never allowed to stand, and never allowed to
// drop the answer either: a refused answer would lose an app's other
// operations, or stop every checkout where the app is blocking, for one word a
// merchant may have typed in the app's settings. So that label alone gives
// way: a row's title becomes the store's own neutral word for that row (or is
// left out where the row has a name of its own), a rename is skipped (the
// store's own name stays), the app is told in its log, and the rest of the
// answer stands.
import { STORE_ACTION_AND_AMOUNT_WORDS, storeWordsIssue, storeWordsMessage, type StoreWordLabelKind } from "../store-words";
import { LINE_ENTRY_WORDS_BN, lineEntryWords } from "../line-entry-words";

type Row = Record<string, unknown>;
const POINTS = new Set(["cart.line_prices", "checkout.discounts", "cart.transform", "checkout.payment_methods", "checkout.shipping_rates"]);
const BANGLA_DIGITS = "০১২৩৪৫৬৭৮৯";

/** The answer with each label that passes for the store's word given way, and what gave way (for the app's log). */
export function adjustFunctionWords(point: string, value: unknown, language: string | null): { value: unknown; notices: string[] } {
  const notices: string[] = [];
  if (!POINTS.has(point)) return { value, notices };
  // The buyer's language, as the store's line words choose it (Bangla for `bn`, else English).
  const words = lineEntryWords(language);
  const bangla = words === LINE_ENTRY_WORDS_BN;
  const discountWord = STORE_ACTION_AND_AMOUNT_WORDS.discountText![bangla ? "bn" : "en"];
  /** Whether `text` passes for the store's word as a label of `kind`; noted with what the store does instead. */
  const refused = (text: unknown, kind: StoreWordLabelKind, where: string, instead: string): boolean => {
    if (typeof text !== "string") return false;
    const issue = storeWordsIssue(text, kind);
    if (issue) notices.push(`${where}: ${storeWordsMessage(text, issue, "name what yours is")} ${instead}`);
    return issue !== null;
  };
  const answer = structuredClone(value) as Row;
  const rows = (key: string) => (Array.isArray(answer[key]) ? answer[key] as Row[] : []);
  if (point === "cart.line_prices") {
    // Distinct add-ons whose titles gave way stay distinct rows: the summary groups rows by app and title,
    // so two "Add-on" rows would merge. With more than one, each is numbered by its own words ("Add-on 1").
    const replaced = rows("adjustments").filter((row) => typeof row.title === "string" && storeWordsIssue(row.title, "add-on"));
    const distinct = [...new Set(replaced.map((row) => row.title as string))];
    const numeral = (index: number) => [...String(index + 1)].map((digit) => (bangla ? BANGLA_DIGITS[Number(digit)] : digit)).join("");
    const neutral = (title: string) => (distinct.length > 1 ? `${words.lineAddOnText} ${numeral(distinct.indexOf(title))}` : words.lineAddOnText);
    for (const [index, row] of rows("adjustments").entries()) {
      const title = row.title as string;
      if (refused(title, "add-on", `adjustments.${index}.title`, `It was drawn as "${neutral(title)}".`)) row.title = neutral(title);
      if (Array.isArray(row.details)) {
        row.details = (row.details as string[]).filter((detail, at) => !refused(detail, "add-on-detail", `adjustments.${index}.details.${at}`, "It was left out."));
      }
    }
    for (const [index, row] of rows("offers").entries()) {
      if (refused(row.title, "add-on", `offers.${index}.title`, `It was drawn as "${words.lineAddOnText}".`)) row.title = words.lineAddOnText;
    }
  } else if (point === "checkout.discounts") {
    for (const [index, row] of rows("discounts").entries()) {
      if (refused(row.title, "discount", `discounts.${index}.title`, `It was drawn as "${discountWord}".`)) row.title = discountWord;
    }
  } else if (point === "cart.transform") {
    for (const [index, row] of rows("operations").entries()) {
      if (row.op === "merge" && refused(row.title, "bundle", `operations.${index}.title`, `It was drawn as "${words.lineBundleText}".`)) row.title = words.lineBundleText;
      if (row.op === "expand" && refused(row.title, "bundle", `operations.${index}.title`, "It was left out: the line's own title is drawn.")) delete row.title;
    }
  } else {
    // A rename that passes for the store's action or fixed words is skipped: the store's own name stays.
    const kind: StoreWordLabelKind = point === "checkout.payment_methods" ? "payment-method" : "shipping-rate";
    answer.operations = rows("operations").filter((row, index) => !(row.op === "rename" && refused(row.name, kind, `operations.${index}.name`, "That rename was skipped: the store's own name stays.")));
  }
  return notices.length === 0 ? { value, notices } : { value: answer, notices };
}
