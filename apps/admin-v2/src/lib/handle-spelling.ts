// Handles made from a name as the merchant types it. Plain ASCII reads the
// same with no script's spelling (handle-rules), so the spelling tables
// (@scalius/shared/handle: Bangla, Hindi, Cyrillic…) download only once a
// name needs them, never with a form's first render.
import { useEffect, useState } from "react";
import { handleSpelling, type HandleResource, type HandleSpelling } from "@scalius/shared/handle-rules";

/** Printable ASCII, tabs and line breaks: what transliteration leaves as it is. */
const PLAIN_ASCII = /^[\t\n\r -~]*$/;
const asciiSpelling = handleSpelling((text) => text);
let fullSpelling: HandleSpelling | undefined;
let load: Promise<HandleSpelling> | null = null;

export function loadHandleSpelling(): Promise<HandleSpelling> {
  load ??= import("@scalius/shared/handle").then(
    ({ toHandle, handleFromText, skuCodeFromText }) => (fullSpelling = { toHandle, handleFromText, skuCodeFromText }),
    (error: unknown) => {
      // A failed download is tried again by the next name that needs it.
      load = null;
      throw error;
    },
  );
  return load;
}

/** The spelling that reads `text` exactly now: ASCII needs no tables, other text has one once they downloaded. */
export function handleSpellingFor(text: string): HandleSpelling | undefined {
  return fullSpelling ?? (PLAIN_ASCII.test(text) ? asciiSpelling : undefined);
}

/** `handleSpellingFor` in a component: downloads the tables for a name that needs them and renders again when they land. */
export function useHandleSpelling(text: string): HandleSpelling | undefined {
  const spelling = handleSpellingFor(text);
  const [, setLoaded] = useState(false);
  useEffect(() => {
    if (spelling) return;
    let live = true;
    loadHandleSpelling().then(() => { if (live) setLoaded(true); }, () => {});
    return () => { live = false; };
  }, [spelling, text]);
  return spelling;
}

/**
 * The handle the server makes from a new item's name; empty until there is a
 * name, and for the moment a name in another script waits for its spelling.
 */
export function useAutoHandle(name: string, resource: HandleResource): string {
  const spelling = useHandleSpelling(name);
  return name.trim() && spelling ? spelling.handleFromText(name, resource) : "";
}
