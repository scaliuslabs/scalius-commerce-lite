import { useEffect, useState } from "react";
import type { KitLineRefusalReason } from "./kit-line-refusal-reason";

type Words = typeof import("~/i18n/kit-line-refusals");

/**
 * The dashboard's sentence for a bundle refusal, its words loaded only once
 * such a refusal arrives (an order without a bundle never downloads them).
 * Null while there is no reason, or for the moment the words load.
 */
export function useKitLineSentence(reason: KitLineRefusalReason | null | undefined): string | null {
  const [words, setWords] = useState<Words | null>(null);
  useEffect(() => {
    if (!reason || words) return;
    let live = true;
    void import("~/i18n/kit-line-refusals").then((module) => {
      if (live) setWords(() => module);
    }, () => {});
    return () => {
      live = false;
    };
  }, [reason, words]);
  return reason && words ? words.kitLineRefusalMessage(reason) : null;
}
