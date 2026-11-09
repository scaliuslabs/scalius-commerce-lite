// The default notification copy per checkout language, apart from the
// renderer in ./notification-templates so the API Worker can ship it as a
// Text module. The API build swaps this module (`#notification-default-copy`,
// package.json "imports") for apps/api/src/text-data/notification-default-copy.ts,
// which parses the same object from a generated JSON text; the dashboard and
// tests import this file as it is.
import type { MessageLanguage } from "./message-copy";
import type { TemplatedNotificationType } from "./notification-types";

type DefaultCopy = Record<TemplatedNotificationType, { subject: string; message: string; sms: string }>;

// The default copy per checkout language. A {{tracking_id}} sits on its own
// line, so that line is left out while the tracking ID isn't known yet.
export const NOTIFICATION_DEFAULT_COPY: Record<MessageLanguage, { greeting: string; events: DefaultCopy }> = {
  en: {
    greeting: "Hi {{customer_name}},",
    events: {
      order_created: {
        subject: "We've received your order {{order_number}}",
        message: "Thank you for your order. We've received it and will let you know as it progresses.",
        sms: "your order {{order_number}} has been received. We'll process it shortly.",
      },
      order_confirmed: {
        subject: "Order {{order_number}} confirmed",
        message: "Your order is confirmed and we're getting it ready.",
        sms: "your order {{order_number}} has been confirmed and is being prepared.",
      },
      order_processing: {
        subject: "Order {{order_number}} is being prepared",
        message: "We're preparing your order and will let you know when it ships.",
        sms: "your order {{order_number}} is being processed. We'll update you when it ships.",
      },
      order_shipped: {
        subject: "Order {{order_number}} is on its way",
        message: "Your order is on its way.\nCourier: {{courier_name}}\nTracking ID: {{tracking_id}}\nTrack your parcel: {{tracking_url}}",
        sms: "your order {{order_number}} is on its way!\nTracking: {{tracking_id}} ({{courier_name}})",
      },
      order_ready_for_pickup: {
        subject: "Order {{order_number}} is ready for pickup",
        message: "Your order is ready for pickup.\nPickup at: {{pickup_address}}\nHours: {{pickup_hours}}",
        sms: "your order {{order_number}} is ready for pickup.\nPickup at: {{pickup_address}}\nHours: {{pickup_hours}}",
      },
      order_delivered: {
        subject: "Order {{order_number}} delivered",
        message: "Your order has been delivered. Thank you for shopping with us.\nStill being prepared: {{pending_downloads}}. Your download will arrive by email when it's ready.",
        sms: "your order {{order_number}} has been delivered. Enjoy!\nYour download arrives by email when it's ready: {{pending_downloads}}",
      },
      order_completed: {
        subject: "Order {{order_number}} completed",
        message: "Your order is complete. Thank you for shopping with us.",
        sms: "your order {{order_number}} has been completed. Thank you for shopping with us!",
      },
      order_cancelled: {
        subject: "Order {{order_number}} cancelled",
        message: "Your order has been cancelled.",
        sms: "your order {{order_number}} has been cancelled. Contact us if you have questions.",
      },
      order_returned: {
        subject: "Order {{order_number}} returned",
        message: "We've received the return for your order.",
        sms: "your order {{order_number}} has been marked as returned. Contact us if you have questions.",
      },
      order_updated: {
        subject: "Order {{order_number}} was updated",
        message: "We changed your order at your request. Here is the updated order.",
        sms: "your order {{order_number}} was updated. New total: {{order_total}}.",
      },
      return_approved: {
        subject: "Your return for order {{order_number}} is approved",
        message: "We approved your return. Please send the items back, and we'll let you know when they arrive.",
        sms: "your return for order {{order_number}} is approved. Please send the items back.",
      },
      return_received: {
        subject: "We received your return for order {{order_number}}",
        message: "The items you sent back have arrived. We'll let you know about your refund.",
        sms: "we received the items you returned for order {{order_number}}.",
      },
      refund_processing: {
        subject: "Refund in progress for order {{order_number}}",
        message: "We're processing the refund for this order and will let you know when it's done.\nRefund: {{refund_amount}}",
        sms: "your refund for order {{order_number}} is being processed. We'll update you when it is complete.",
      },
      refund_failed: {
        subject: "We couldn't refund order {{order_number}}",
        message: "We couldn't complete the refund for this order. Please contact us for help.",
        sms: "we couldn't complete the refund for order {{order_number}}. Please contact support for help.",
      },
      order_refunded: {
        subject: "Order {{order_number}} refunded",
        message: "The refund for this order has been processed.\nRefund: {{refund_amount}}",
        sms: "your order {{order_number}} has been refunded. Contact us if you have questions.\nRefund: {{refund_amount}}",
      },
      order_partially_refunded: {
        subject: "Order {{order_number}} partially refunded",
        message: "A partial refund for this order has been processed.\nRefund: {{refund_amount}}",
        sms: "a partial refund has been processed for order {{order_number}}. Contact us if you have questions.\nRefund: {{refund_amount}}",
      },
      payment_balance_paid: {
        subject: "Payment received for order {{order_number}}",
        message: "We've received the remaining payment for this order.",
        sms: "we received the remaining payment for order {{order_number}}. Your order is now fully paid.",
      },
      support_request_submitted: {
        subject: "We received your {{support_request}} for order {{order_number}}",
        message: "The store will review it and let you know.",
        sms: "we received your {{support_request}} for order {{order_number}}. We'll update you soon.",
      },
      support_request_status_updated: {
        subject: "Update on your {{support_request}} for order {{order_number}}",
        message: "Your {{support_request}} is {{support_status}}.",
        sms: "your {{support_request}} for order {{order_number}} is now {{support_status}}.",
      },
      order_digital_delivered: {
        subject: "Your downloads for order {{order_number}} are ready",
        message: "Your digital items are ready.\nFiles: {{download_names}}\nLicence keys: {{licence_keys}}\nGet them here: {{access_link}}",
        sms: "your digital items for order {{order_number}} are ready.\nKeys: {{sms_licence_keys}}\nCheck your email or account: {{access_link}}",
      },
      gift_card_issued: {
        subject: "Your {{store_name}} gift card",
        message: "You've received a gift card.\nFrom: {{gift_card_sender}}\n{{gift_card_message}}\nGift card code: {{gift_card_code}}\nValue: {{gift_card_value}}\nExpires: {{gift_card_expires}}\nUse it at checkout: {{gift_card_link}}",
        sms: "you've received a {{gift_card_value}} gift card from {{store_name}}.\nCode: {{gift_card_code}}\nExpires: {{gift_card_expires}}",
      },
      gift_card_sent: {
        subject: "Your gift card from order {{order_number}} was sent",
        message: "The {{gift_card_value}} gift card you bought was sent to {{gift_card_recipient}}. They'll get the code by email or SMS.",
        sms: "your {{gift_card_value}} gift card from order {{order_number}} was sent to {{gift_card_recipient}}.",
      },
      review_request: {
        subject: "How was your order {{order_number}}?",
        message: "Thank you for shopping with us. We'd love to hear what you think of {{review_products}}.\nWrite a review: {{review_link}}",
        sms: "how was your order {{order_number}}? Write a review: {{review_link}}",
      },
    },
  },
  bn: {
    greeting: "হ্যালো {{customer_name}},",
    events: {
      order_created: {
        subject: "আপনার অর্ডার {{order_number}} আমরা পেয়েছি",
        message: "অর্ডারের জন্য ধন্যবাদ। আপনার অর্ডার আমরা পেয়েছি, আপডেট হলেই জানিয়ে দেব।",
        sms: "আপনার অর্ডার {{order_number}} আমরা পেয়েছি। শিগগিরই প্রস্তুত করব।",
      },
      order_confirmed: {
        subject: "অর্ডার {{order_number}} কনফার্ম হয়েছে",
        message: "আপনার অর্ডার কনফার্ম হয়েছে, আমরা এটি প্রস্তুত করছি।",
        sms: "আপনার অর্ডার {{order_number}} কনফার্ম হয়েছে, আমরা এটি প্রস্তুত করছি।",
      },
      order_processing: {
        subject: "অর্ডার {{order_number}} প্রস্তুত হচ্ছে",
        message: "আপনার অর্ডার প্রস্তুত করা হচ্ছে। পাঠানোর সময় জানিয়ে দেব।",
        sms: "আপনার অর্ডার {{order_number}} প্রস্তুত করা হচ্ছে। পাঠানোর সময় জানিয়ে দেব।",
      },
      order_shipped: {
        subject: "অর্ডার {{order_number}} পাঠানো হয়েছে",
        message: "আপনার অর্ডার পাঠানো হয়েছে।\nকুরিয়ার: {{courier_name}}\nট্র্যাকিং আইডি: {{tracking_id}}\nপার্সেল ট্র্যাক করুন: {{tracking_url}}",
        sms: "আপনার অর্ডার {{order_number}} পাঠানো হয়েছে!\nট্র্যাকিং: {{tracking_id}} ({{courier_name}})",
      },
      order_ready_for_pickup: {
        subject: "অর্ডার {{order_number}} পিকআপের জন্য প্রস্তুত",
        message: "আপনার অর্ডার পিকআপের জন্য প্রস্তুত।\nপিকআপের ঠিকানা: {{pickup_address}}\nসময়: {{pickup_hours}}",
        sms: "আপনার অর্ডার {{order_number}} পিকআপের জন্য প্রস্তুত।\nঠিকানা: {{pickup_address}}\nসময়: {{pickup_hours}}",
      },
      order_delivered: {
        subject: "অর্ডার {{order_number}} ডেলিভারি হয়েছে",
        message: "আপনার অর্ডার ডেলিভারি হয়েছে। আমাদের সাথে কেনাকাটার জন্য ধন্যবাদ।\nএখনও প্রস্তুত হচ্ছে: {{pending_downloads}}। ডাউনলোড প্রস্তুত হলে ইমেইলে পাঠানো হবে।",
        sms: "আপনার অর্ডার {{order_number}} ডেলিভারি হয়েছে। ধন্যবাদ!\nডাউনলোড প্রস্তুত হলে ইমেইলে পাবেন: {{pending_downloads}}",
      },
      order_completed: {
        subject: "অর্ডার {{order_number}} সম্পন্ন হয়েছে",
        message: "আপনার অর্ডার সম্পন্ন হয়েছে। আমাদের সাথে কেনাকাটার জন্য ধন্যবাদ।",
        sms: "আপনার অর্ডার {{order_number}} সম্পন্ন হয়েছে। আমাদের সাথে কেনাকাটার জন্য ধন্যবাদ!",
      },
      order_cancelled: {
        subject: "অর্ডার {{order_number}} বাতিল হয়েছে",
        message: "আপনার অর্ডার বাতিল করা হয়েছে।",
        sms: "আপনার অর্ডার {{order_number}} বাতিল করা হয়েছে। কোনো প্রশ্ন থাকলে যোগাযোগ করুন।",
      },
      order_returned: {
        subject: "অর্ডার {{order_number}} রিটার্ন হয়েছে",
        message: "আপনার অর্ডারের রিটার্ন আমরা পেয়েছি।",
        sms: "আপনার অর্ডার {{order_number}}-এর রিটার্ন আমরা পেয়েছি। কোনো প্রশ্ন থাকলে যোগাযোগ করুন।",
      },
      order_updated: {
        subject: "অর্ডার {{order_number}} আপডেট হয়েছে",
        message: "আপনার অনুরোধে আমরা অর্ডারটি বদলেছি। আপডেট করা অর্ডার নিচে দেওয়া হলো।",
        sms: "আপনার অর্ডার {{order_number}} আপডেট হয়েছে। নতুন মোট: {{order_total}}।",
      },
      return_approved: {
        subject: "অর্ডার {{order_number}}-এর ফেরত অনুমোদিত হয়েছে",
        message: "আমরা আপনার ফেরত অনুমোদন করেছি। প্রোডাক্টগুলো ফেরত পাঠান, পৌঁছালে আমরা জানাব।",
        sms: "অর্ডার {{order_number}}-এর ফেরত অনুমোদিত হয়েছে। প্রোডাক্টগুলো ফেরত পাঠান।",
      },
      return_received: {
        subject: "অর্ডার {{order_number}}-এর ফেরত আমরা পেয়েছি",
        message: "আপনার ফেরত পাঠানো প্রোডাক্টগুলো পৌঁছেছে। রিফান্ডের খবর আমরা জানাব।",
        sms: "অর্ডার {{order_number}}-এর ফেরত পাঠানো প্রোডাক্টগুলো আমরা পেয়েছি।",
      },
      refund_processing: {
        subject: "অর্ডার {{order_number}}-এর রিফান্ড প্রক্রিয়াধীন",
        message: "এই অর্ডারের রিফান্ড প্রক্রিয়াধীন। শেষ হলেই জানিয়ে দেব।\nরিফান্ড: {{refund_amount}}",
        sms: "অর্ডার {{order_number}}-এর রিফান্ড প্রক্রিয়াধীন। শেষ হলেই জানিয়ে দেব।",
      },
      refund_failed: {
        subject: "অর্ডার {{order_number}}-এর রিফান্ড সম্পন্ন হয়নি",
        message: "এই অর্ডারের রিফান্ড সম্পন্ন করা যায়নি। সাহায্যের জন্য আমাদের সাথে যোগাযোগ করুন।",
        sms: "অর্ডার {{order_number}}-এর রিফান্ড সম্পন্ন করা যায়নি। সাহায্যের জন্য যোগাযোগ করুন।",
      },
      order_refunded: {
        subject: "অর্ডার {{order_number}}-এর রিফান্ড দেওয়া হয়েছে",
        message: "এই অর্ডারের রিফান্ড দেওয়া হয়েছে।\nরিফান্ড: {{refund_amount}}",
        sms: "অর্ডার {{order_number}}-এর রিফান্ড দেওয়া হয়েছে। কোনো প্রশ্ন থাকলে যোগাযোগ করুন।\nরিফান্ড: {{refund_amount}}",
      },
      order_partially_refunded: {
        subject: "অর্ডার {{order_number}}-এর আংশিক রিফান্ড দেওয়া হয়েছে",
        message: "এই অর্ডারের আংশিক রিফান্ড দেওয়া হয়েছে।\nরিফান্ড: {{refund_amount}}",
        sms: "অর্ডার {{order_number}}-এর আংশিক রিফান্ড দেওয়া হয়েছে। কোনো প্রশ্ন থাকলে যোগাযোগ করুন।\nরিফান্ড: {{refund_amount}}",
      },
      payment_balance_paid: {
        subject: "অর্ডার {{order_number}}-এর পেমেন্ট পেয়েছি",
        message: "এই অর্ডারের বাকি টাকা আমরা পেয়েছি।",
        sms: "অর্ডার {{order_number}}-এর বাকি টাকা আমরা পেয়েছি। এখন পুরো টাকা পরিশোধ হয়েছে।",
      },
      support_request_submitted: {
        subject: "অর্ডার {{order_number}}-এর {{support_request}} আমরা পেয়েছি",
        message: "স্টোর এটি দেখে আপনাকে জানাবে।",
        sms: "অর্ডার {{order_number}}-এর {{support_request}} আমরা পেয়েছি। শিগগিরই জানাব।",
      },
      support_request_status_updated: {
        subject: "অর্ডার {{order_number}}-এর {{support_request}} নিয়ে আপডেট",
        message: "আপনার {{support_request}} {{support_status}}।",
        sms: "অর্ডার {{order_number}}-এর {{support_request}} {{support_status}}।",
      },
      order_digital_delivered: {
        subject: "অর্ডার {{order_number}}-এর ডাউনলোড প্রস্তুত",
        message: "আপনার ডিজিটাল পণ্য প্রস্তুত।\nফাইল: {{download_names}}\nলাইসেন্স কী: {{licence_keys}}\nএখান থেকে নিন: {{access_link}}",
        sms: "অর্ডার {{order_number}}-এর ডিজিটাল পণ্য প্রস্তুত।\nকী: {{sms_licence_keys}}\nইমেইল বা অ্যাকাউন্টে দেখুন: {{access_link}}",
      },
      gift_card_issued: {
        subject: "আপনার {{store_name}} গিফট কার্ড",
        message: "আপনি একটি গিফট কার্ড পেয়েছেন।\nপাঠিয়েছেন: {{gift_card_sender}}\n{{gift_card_message}}\nগিফট কার্ড কোড: {{gift_card_code}}\nমূল্য: {{gift_card_value}}\nমেয়াদ: {{gift_card_expires}}\nচেকআউটে ব্যবহার করুন: {{gift_card_link}}",
        sms: "{{store_name}} থেকে আপনি {{gift_card_value}}-এর একটি গিফট কার্ড পেয়েছেন।\nকোড: {{gift_card_code}}\nমেয়াদ: {{gift_card_expires}}",
      },
      gift_card_sent: {
        subject: "অর্ডার {{order_number}}-এর গিফট কার্ড পাঠানো হয়েছে",
        message: "আপনার কেনা {{gift_card_value}}-এর গিফট কার্ডটি {{gift_card_recipient}}-কে পাঠানো হয়েছে। তিনি ইমেইল বা এসএমএসে কোডটি পাবেন।",
        sms: "অর্ডার {{order_number}}-এর {{gift_card_value}}-এর গিফট কার্ডটি {{gift_card_recipient}}-কে পাঠানো হয়েছে।",
      },
      review_request: {
        subject: "অর্ডার {{order_number}} কেমন লাগল?",
        message: "আমাদের সাথে কেনাকাটার জন্য ধন্যবাদ। {{review_products}} নিয়ে আপনার মতামত জানতে চাই।\nরিভিউ লিখুন: {{review_link}}",
        sms: "অর্ডার {{order_number}} কেমন লাগল? রিভিউ লিখুন: {{review_link}}",
      },
    },
  },
};
