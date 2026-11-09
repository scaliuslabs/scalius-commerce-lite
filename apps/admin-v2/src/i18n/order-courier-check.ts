import { defineMessages } from "./index";
import { orderDetailMessages } from "./order-detail";

/**
 * The courier check's own words (ShipmentCard's "Record courier check"
 * dialog), which load with the dialog when it is first opened.
 */
const courierCheckCopy = defineMessages({
  en: {
    "courier.checkHelp": "Check your {courier} account for this order before booking again, so it isn't sent twice.",
    "courier.outcome": "What did you find?",
    "courier.outcome.confirmed_existing": "It was booked",
    "courier.outcome.confirmed_not_created": "It wasn't booked",
    "courier.outcome.confirmed_cancelled": "It was cancelled",
    "courier.consignmentId": "Consignment ID",
    "courier.source": "Where did you check?",
    "courier.source.courier_portal": "Courier website",
    "courier.source.courier_support": "Courier support",
    "courier.details": "Details",
    "courier.detailsPlaceholder": "When you checked, and any support reference",
    "courier.notCreatedEvidence": "Search the courier for order ID {order} and write what it showed, including the order ID.",
    "courier.confirm": "I checked this exact order with the courier.",
  },
  bn: {
    "courier.checkHelp": "আবার বুক করার আগে আপনার {courier} অ্যাকাউন্টে এই অর্ডারটি দেখুন, যাতে দুবার না যায়।",
    "courier.outcome": "কী পেলেন?",
    "courier.outcome.confirmed_existing": "বুক হয়েছিল",
    "courier.outcome.confirmed_not_created": "বুক হয়নি",
    "courier.outcome.confirmed_cancelled": "বাতিল হয়েছিল",
    "courier.consignmentId": "কনসাইনমেন্ট আইডি",
    "courier.source": "কোথায় দেখেছেন?",
    "courier.source.courier_portal": "কুরিয়ারের ওয়েবসাইট",
    "courier.source.courier_support": "কুরিয়ার সাপোর্ট",
    "courier.details": "বিস্তারিত",
    "courier.detailsPlaceholder": "কখন দেখেছেন, এবং সাপোর্টের রেফারেন্স থাকলে",
    "courier.notCreatedEvidence": "কুরিয়ারে অর্ডার আইডি {order} খুঁজে যা দেখেছেন লিখুন, অর্ডার আইডিসহ।",
    "courier.confirm": "আমি কুরিয়ারের সাথে ঠিক এই অর্ডারটি যাচাই করেছি।",
  },
});

/** The order page's words with the courier check's own. */
export const orderCourierCheckMessages = defineMessages({
  en: { ...orderDetailMessages.en, ...courierCheckCopy.en },
  bn: { ...orderDetailMessages.bn, ...courierCheckCopy.bn },
});
