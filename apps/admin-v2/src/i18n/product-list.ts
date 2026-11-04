import { defineMessages } from "./index";
import { productMessages } from "./products";

/**
 * The products list's own words: its columns, bulk actions and their
 * dialogs. The product page never shows them, so it never downloads them.
 */
const ownCopy = defineMessages({
  en: {
    columnCategory: "Category",
    columnPrice: "Price",
    uncategorized: "No category",
    untitled: "Untitled product",
    copyShortcode: "Copy shortcode",
    shortcodeCopied: "Shortcode copied",
    shortcodeCopyFailed: "Couldn't copy. Try again.",
    settingActive: "Setting as active…",
    settingDraft: "Setting as draft…",
    changingCategory: "Changing category…",
    needsPrice: "{name} needs a price first.",
    needsPriceMore: "{name} and {count} more need a price first.",
    nothingChanged: "No products were changed",
    draftConfirmTitle: "Set {count, plural, one {# product} other {# products}} as draft?",
    draftConfirmBody: "{count} of them are on your store now. Customers won't see them until you set them active again.",
    makeAvailable: "Make available on channels",
    makeUnavailable: "Make unavailable on channels",
    columnInventory: "Inventory",
    saleOnSome: "Sale on some variants",
    keptForHistory: "Kept for stock history",
    addToCollection: "Add to collection",
    removeFromCollection: "Remove from collection",
    changeCategory: "Change category",
    categoryChanged: "Category changed",
    addedToCollection: "Added to collection",
    removedFromCollection: "Removed from collection",
    chooseCollection: "Choose a collection",
    noManualCollections: "No hand-picked collections yet.",
    changeCategoryTitle: "Change category ({count} selected)",
    addToCollectionTitle: "Add to a collection ({count} selected)",
    removeFromCollectionTitle: "Remove from a collection ({count} selected)",
    changeCategoryHelp: "Each product moves to the category you choose.",
    manualCollectionsHelp: "Only hand-picked collections are listed. Automatic ones choose products by their rule.",
  },
  bn: {
    columnCategory: "ক্যাটাগরি",
    columnPrice: "দাম",
    uncategorized: "ক্যাটাগরি নেই",
    untitled: "নামহীন পণ্য",
    copyShortcode: "শর্টকোড কপি করুন",
    shortcodeCopied: "শর্টকোড কপি হয়েছে",
    shortcodeCopyFailed: "কপি করা যায়নি। আবার চেষ্টা করুন।",
    settingActive: "সক্রিয় করা হচ্ছে…",
    settingDraft: "খসড়া করা হচ্ছে…",
    changingCategory: "ক্যাটাগরি বদলানো হচ্ছে…",
    needsPrice: "আগে {name}-এর দাম দিন।",
    needsPriceMore: "আগে {name} আর আরও {count}টির দাম দিন।",
    nothingChanged: "কোনো পণ্য বদলায়নি",
    draftConfirmTitle: "{count}টি পণ্য খসড়া করবেন?",
    draftConfirmBody: "এর মধ্যে {count}টি এখন আপনার স্টোরে আছে। আবার অ্যাক্টিভ না করা পর্যন্ত কাস্টমাররা এগুলো দেখতে পাবেন না।",
    makeAvailable: "চ্যানেলে পাওয়া যাবে",
    makeUnavailable: "চ্যানেলে পাওয়া যাবে না",
    columnInventory: "স্টক",
    saleOnSome: "কিছু ভ্যারিয়েন্টে ছাড়",
    keptForHistory: "স্টকের হিসাবের জন্য রাখা",
    addToCollection: "কালেকশনে যোগ করুন",
    removeFromCollection: "কালেকশন থেকে সরান",
    changeCategory: "ক্যাটাগরি বদলান",
    categoryChanged: "ক্যাটাগরি বদলানো হয়েছে",
    addedToCollection: "কালেকশনে যোগ হয়েছে",
    removedFromCollection: "কালেকশন থেকে সরানো হয়েছে",
    chooseCollection: "একটি কালেকশন বেছে নিন",
    noManualCollections: "হাতে বাছাই করা কোনো কালেকশন এখনো নেই।",
    changeCategoryTitle: "ক্যাটাগরি বদলান ({count}টি বাছাই করা)",
    addToCollectionTitle: "কালেকশনে যোগ করুন ({count}টি বাছাই করা)",
    removeFromCollectionTitle: "কালেকশন থেকে সরান ({count}টি বাছাই করা)",
    changeCategoryHelp: "প্রতিটি পণ্য আপনার বাছাই করা ক্যাটাগরিতে যাবে।",
    manualCollectionsHelp: "শুধু হাতে বাছাই করা কালেকশন দেখানো হয়েছে। অটোমেটিক কালেকশন নিজের নিয়মে পণ্য বাছাই করে।",
  },
});

/** productMessages with these parts' own words. */
export const productListMessages = defineMessages({
  en: { ...productMessages.en, ...ownCopy.en },
  bn: { ...productMessages.bn, ...ownCopy.bn },
});

export type ProductListMessageKey = keyof typeof productListMessages.en;
