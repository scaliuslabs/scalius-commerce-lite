import { defineMessages } from "./index";

/** The line under a rich-text editor whose text runs past what search reads. */
export const searchTextMessages = defineMessages({
  en: {
    searchReadsStart: "Search finds words in the first {count} characters of this text only.",
  },
  bn: {
    searchReadsStart: "সার্চ এই লেখার শুধু প্রথম {count} অক্ষরের শব্দ খুঁজে পায়।",
  },
});
