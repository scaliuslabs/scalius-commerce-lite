import { defineMessages } from "./index";
import { orderDetailMessages } from "./order-detail";

/** A buyer's files on the order page (names, sizes, Download): their words load with the list. */
const buyerFilesCopy = defineMessages({
  en: {
    "files.download": "Download",
    "files.downloadName": "Download {name}",
    "files.downloadFailed": "Couldn't download the file. Try again.",
    "files.gone": "This file is no longer kept.",
    "files.noLongerKept": "No longer kept",
    "files.typeImage": "Image",
    "files.typePdf": "PDF",
  },
  bn: {
    "files.download": "ডাউনলোড",
    "files.downloadName": "{name} ডাউনলোড করুন",
    "files.downloadFailed": "ফাইলটি ডাউনলোড করা যায়নি। আবার চেষ্টা করুন।",
    "files.gone": "এই ফাইলটি আর রাখা নেই।",
    "files.noLongerKept": "আর রাখা নেই",
    "files.typeImage": "ছবি",
    "files.typePdf": "PDF",
  },
});

/** The order page's words with the file list's own. */
export const orderBuyerFilesMessages = defineMessages({
  en: { ...orderDetailMessages.en, ...buyerFilesCopy.en },
  bn: { ...orderDetailMessages.bn, ...buyerFilesCopy.bn },
});
