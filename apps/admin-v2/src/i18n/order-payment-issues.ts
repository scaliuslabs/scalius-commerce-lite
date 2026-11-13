import { defineMessages } from "./index";

/** The order payment card's provider updates that failed or wait: loaded with those notices (PaymentIssues). */
export const orderPaymentIssueMessages = defineMessages({
  en: {
    title: "A payment update failed",
    help: "Check your payment dashboard before changing this order.",
    "reason.manual_reconciliation": "A {gateway} payment update couldn't be applied. Check it in {gateway} and update the order by hand.",
    "reason.dead_letter": "A {gateway} payment update failed after every retry. Check it in {gateway} before changing the payment.",
    "reason.failed": "A {gateway} payment update failed. Check it in {gateway} before changing the payment.",
    externalTitle: "Refund made outside Scalius",
    externalHelp: "Scalius adds refunds made in your payment dashboard to the order on its next check.",
    "reason.external_refund": "{gateway} reports a refund this order doesn't show yet. If it's still here after a while, check the refund in {gateway}.",
    waitingTitle: "Payment waiting for the courier booking",
    waitingHelp: "It's recorded on its own once the booking is finished or released. To record it now, fix the shipment.",
    refundWaitingTitle: "Dispute waiting for a refund to settle",
    refundWaitingHelp: "It's recorded on its own the moment the refund settles. Until then the disputed payment can't be refunded.",
    "reason.shipment_claim": "A {gateway} payment arrived while this order's courier booking was unfinished. It will be added to the order then.",
    "reason.refund_in_flight": "A {gateway} dispute arrived while a refund on this order was still being processed. It will be recorded once the refund settles.",
  },
  bn: {
    title: "একটি পেমেন্ট আপডেট ব্যর্থ হয়েছে",
    help: "অর্ডার বদলানোর আগে পেমেন্ট ড্যাশবোর্ড দেখে নিন।",
    "reason.manual_reconciliation": "{gateway} থেকে আসা একটি পেমেন্ট আপডেট প্রয়োগ করা যায়নি। {gateway}-এ দেখে অর্ডারটি নিজে আপডেট করুন।",
    "reason.dead_letter": "{gateway}-এর একটি পেমেন্ট আপডেট সব চেষ্টার পরও ব্যর্থ হয়েছে। পেমেন্ট বদলানোর আগে {gateway}-এ দেখে নিন।",
    "reason.failed": "{gateway}-এর একটি পেমেন্ট আপডেট ব্যর্থ হয়েছে। পেমেন্ট বদলানোর আগে {gateway}-এ দেখে নিন।",
    externalTitle: "Scalius-এর বাইরে করা রিফান্ড",
    externalHelp: "পেমেন্ট ড্যাশবোর্ডে করা রিফান্ড Scalius পরের যাচাইয়ে অর্ডারে যোগ করে।",
    "reason.external_refund": "{gateway} এমন একটি রিফান্ডের কথা জানাচ্ছে যা এই অর্ডারে এখনো দেখা যাচ্ছে না। কিছুক্ষণ পরও থাকলে {gateway}-এ রিফান্ডটি দেখে নিন।",
    waitingTitle: "কুরিয়ার বুকিংয়ের অপেক্ষায় পেমেন্ট",
    waitingHelp: "বুকিং শেষ হলে বা ছেড়ে দিলে এটি নিজে থেকেই যোগ হবে। এখনই যোগ করতে শিপমেন্টটি ঠিক করুন।",
    refundWaitingTitle: "রিফান্ড সম্পন্ন হওয়ার অপেক্ষায় বিরোধ",
    refundWaitingHelp: "রিফান্ড সম্পন্ন হওয়ার সাথে সাথে এটি নিজে থেকেই রেকর্ড হবে। ততক্ষণ বিরোধের পেমেন্টটি রিফান্ড করা যাবে না।",
    "reason.shipment_claim": "এই অর্ডারের কুরিয়ার বুকিং অসম্পূর্ণ থাকা অবস্থায় {gateway}-এর একটি পেমেন্ট এসেছে। বুকিং শেষ হলে এটি অর্ডারে যোগ হবে।",
    "reason.refund_in_flight": "এই অর্ডারের একটি রিফান্ড প্রক্রিয়াধীন থাকা অবস্থায় {gateway}-এর একটি বিরোধ এসেছে। রিফান্ড সম্পন্ন হলে এটি রেকর্ড হবে।",
  },
});
