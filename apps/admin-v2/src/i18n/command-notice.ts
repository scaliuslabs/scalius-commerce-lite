import { defineMessages } from "./index";

/**
 * What a screen says about its command's request key, in one pattern for
 * every command that moves money or stock: an earlier attempt may have gone
 * through (sending again is safe), or it did (sending again is a new request).
 */
export const commandNoticeMessages = defineMessages({
  en: {
    "open.order": "Your earlier attempt may have gone through. Check the order: trying again won't do it twice.",
    "open.stock": "Your earlier attempt may have gone through. Check the stock: trying again won't count it twice.",
    "open.giftCard": "Your earlier attempt may have gone through. Check the gift cards: trying again won't do it twice.",
    "open.document": "Your earlier attempt may have gone through. Check the document: trying again won't count it twice.",
    "open.keys": "Your earlier attempt may have gone through. Check the keys: trying again won't do it twice.",
    "landed.order": "Your earlier attempt went through. Check the order: sending again is a new request.",
    "landed.stock": "Your earlier attempt went through. Check the stock: sending again is a new change.",
    "landed.giftCard": "Your earlier attempt went through. Check the gift cards: sending again is a new request.",
    "landed.document": "Your earlier attempt went through. Check the document: sending again is a new receipt.",
    "landed.keys": "Your earlier attempt went through. Check the keys: sending again is a new request.",
    "unknown.order": "The server can't tell whether your earlier attempt went through, and can't repeat it. Check the order before you do anything else.",
    "startOver.payment": "Record as a new payment: only if the order shows no payment from your earlier attempt",
    "startOver.dispute": "Record as a new chargeback: only if the order shows no chargeback from your earlier attempt",
  },
  bn: {
    "open.order": "আপনার আগের চেষ্টাটি হয়তো সম্পন্ন হয়েছে। অর্ডারটি দেখে নিন: আবার চেষ্টা করলে এটি দুবার হবে না।",
    "open.stock": "আপনার আগের চেষ্টাটি হয়তো সম্পন্ন হয়েছে। স্টক দেখে নিন: আবার চেষ্টা করলে দুবার গোনা হবে না।",
    "open.giftCard": "আপনার আগের চেষ্টাটি হয়তো সম্পন্ন হয়েছে। গিফট কার্ডগুলো দেখে নিন: আবার চেষ্টা করলে এটি দুবার হবে না।",
    "open.document": "আপনার আগের চেষ্টাটি হয়তো সম্পন্ন হয়েছে। ডকুমেন্টটি দেখে নিন: আবার চেষ্টা করলে দুবার গোনা হবে না।",
    "open.keys": "আপনার আগের চেষ্টাটি হয়তো সম্পন্ন হয়েছে। কী-গুলো দেখে নিন: আবার চেষ্টা করলে এটি দুবার হবে না।",
    "landed.order": "আপনার আগের চেষ্টাটি সম্পন্ন হয়েছে। অর্ডারটি দেখে নিন: আবার পাঠালে এটি নতুন অনুরোধ হবে।",
    "landed.stock": "আপনার আগের চেষ্টাটি সম্পন্ন হয়েছে। স্টক দেখে নিন: আবার পাঠালে এটি নতুন পরিবর্তন হবে।",
    "landed.giftCard": "আপনার আগের চেষ্টাটি সম্পন্ন হয়েছে। গিফট কার্ডগুলো দেখে নিন: আবার পাঠালে এটি নতুন অনুরোধ হবে।",
    "landed.document": "আপনার আগের চেষ্টাটি সম্পন্ন হয়েছে। ডকুমেন্টটি দেখে নিন: আবার পাঠালে এটি নতুন রিসিভ হবে।",
    "landed.keys": "আপনার আগের চেষ্টাটি সম্পন্ন হয়েছে। কী-গুলো দেখে নিন: আবার পাঠালে এটি নতুন অনুরোধ হবে।",
    "unknown.order": "আপনার আগের চেষ্টাটি সম্পন্ন হয়েছে কি না সার্ভার বলতে পারছে না, আর এটি আবার চালাতেও পারছে না। অন্য কিছু করার আগে অর্ডারটি দেখে নিন।",
    "startOver.payment": "নতুন পেমেন্ট হিসেবে রেকর্ড করুন: শুধু যদি অর্ডারে আগের চেষ্টার কোনো পেমেন্ট না থাকে",
    "startOver.dispute": "নতুন চার্জব্যাক হিসেবে রেকর্ড করুন: শুধু যদি অর্ডারে আগের চেষ্টার কোনো চার্জব্যাক না থাকে",
  },
});

/** What a screen's command acts on, so the notice says what to check. */
export type CommandNoticeTarget = "order" | "stock" | "giftCard" | "document" | "keys";
