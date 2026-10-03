import { defineMessages } from "./index";

/**
 * Archiving and unarchiving orders and the bulk runs behind them: the orders
 * list and the order page both say these, so they are apart from the list's
 * own catalog (which the order page would otherwise download).
 */
export const orderArchiveMessages = defineMessages({
  en: {
    bulkFailedGeneric: "Couldn't update this order.",
    bulkRequestFailed: "Couldn't reach the server. Nothing changed for these orders. Try again.",
    archivedOne: "Order archived",
    archivedOther: "{count} orders archived",
    archiveSkipped: "{count} skipped (still open)",
    archiveFailed: "Archive failed",
    undo: "Undo",
    restoredOne: "Order unarchived",
    restoredOther: "Orders unarchived",
    undoFailed: "Some orders couldn't be unarchived. Reload and try again.",
  },
  bn: {
    bulkFailedGeneric: "এই অর্ডারটি আপডেট করা যায়নি।",
    bulkRequestFailed: "সার্ভারের সাথে যোগাযোগ হয়নি। এই অর্ডারগুলোর কিছুই বদলায়নি। আবার চেষ্টা করুন।",
    archivedOne: "অর্ডার আর্কাইভ হয়েছে",
    archivedOther: "{count}টি অর্ডার আর্কাইভ হয়েছে",
    archiveSkipped: "{count}টি বাদ গেছে (এখনো চলছে)",
    archiveFailed: "আর্কাইভ হয়নি",
    undo: "আগের মতো করুন",
    restoredOne: "অর্ডার আনআর্কাইভ হয়েছে",
    restoredOther: "অর্ডারগুলো আনআর্কাইভ হয়েছে",
    undoFailed: "কিছু অর্ডার আনআর্কাইভ করা যায়নি। রিলোড করে আবার চেষ্টা করুন।",
  },
});
