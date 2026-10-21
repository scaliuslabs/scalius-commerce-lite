// The customer account's own words (the shell and navigation, Orders, an
// order's page, Profile and the address book, phone verification, payment
// recovery) in English and Bangla, keyed by the page's language like
// lib/storefront-copy.ts. The account follows the store's language: a Bangla
// store's account pages are Bangla. Downloads, gift cards, the inbox and a
// shared cart keep their words beside their code (account-downloads.ts,
// account-gift-cards.ts, account-inbox.ts, conversation-cart-share.ts), each
// in both languages; reviews and warranties use the checkout language.
// account-copy.test.ts fails when a language lacks a key. Counts, amounts and
// dates arrive already formatted in the page's digits; these functions only
// place them in words.
import { storefrontLanguage, type StorefrontLanguage } from "./storefront-copy";
import { pageLanguage } from "./store-time-zone";

export interface AccountCopy {
  shell: {
    nav: string;
    orders: string;
    profile: string;
    inbox: string;
    reviews: string;
    downloads: string;
    giftCards: string;
    warranties: string;
    /** Read after an Inbox badge: "3 unread". */
    unread: string;
    /** Read after a Reviews badge: "2 to review". */
    toReview: string;
    signOut: string;
    signIn: string;
    signInTitle: string;
    signInBody: string;
    unavailable: string;
    retry: string;
    close: string;
    goToOrders: string;
  };
  format: {
    paymentNeedsAttention: string;
    cancellationRequested: string;
    returnRequested: string;
    refundRequested: string;
    requestOpen: string;
    /** The option name a re-ordered line carries when the order kept only its label. */
    variant: string;
  };
  orders: {
    title: string;
    count: (count: string, one: boolean) => string;
    signInTitle: string;
    signInBody: string;
    phoneVerified: string;
    noOlder: string;
    none: string;
    noneBody: string;
    startShopping: string;
    trackGuest: string;
    order: (number: string) => string;
    items: (count: string, one: boolean) => string;
    buyAgain: string;
    newest: string;
    older: string;
    allGone: string;
    someGone: string;
  };
  order: {
    pageTitle: string;
    signInTitle: string;
    trackInstead: string;
    noScript: string;
    trackThis: string;
    loading: string;
    backToOrders: string;
    status: string;
    updates: string;
    items: string;
    shippingAddress: string;
    payment: string;
    paymentMethod: string;
    help: string;
    /** Over the order's requests, unless the store wrote its own (Settings → Customer requests). */
    helpIntro: string;
    reason: string;
    note: string;
    cancel: string;
    submit: string;
    submitting: string;
    cancelReasons: readonly string[];
    returnReasons: readonly string[];
    /** The reason that needs a note; the last of both lists. */
    other: string;
    chooseReason: string;
    tellStore: string;
    requestFailed: string;
    title: (number: string) => string;
    placed: (date: string) => string;
    notFound: string;
    linkIncomplete: string;
    notInAccount: string;
    unreachable: string;
    wentWrong: string;
    couldNotShow: string;
    expectedDelivery: (date: string) => string;
    product: string;
    quantity: (count: string, unit: string) => string;
    lineDiscount: (amount: string) => string;
    subtotal: string;
    tax: string;
    taxIncluded: (label: string) => string;
    total: string;
    deliveryMethod: (name: string) => string;
    updated: (date: string) => string;
    paid: (amount: string) => string;
    collected: (amount: string) => string;
    advance: (amount: string) => string;
    refundOnWay: (amount: string) => string;
  };
  /**
   * Where an order is, worded here by the API's stable keys (milestones,
   * courier states, payment events), so the account speaks the page's
   * language whatever words the API composed.
   */
  tracking: {
    milestones: Record<"placed" | "confirmed" | "shipped" | "delivered" | "cancelled" | "returned" | "refunded" | "partially_refunded", string>;
    awaitingPayment: string;
    placedDetails: string;
    confirmedDetails: string;
    shippedDetails: string;
    withCourier: (courier: string) => string;
    shipments: Record<"picked_up" | "in_transit" | "out_for_delivery" | "delivered" | "partial_delivered" | "delivery_failed" | "pickup_failed" | "on_hold" | "returned" | "cancelled", string>;
    booked: string;
    paymentReceived: string;
    paymentFailed: string;
  };
  recovery: {
    balanceTitle: string;
    depositTitle: string;
    retryTitle: string;
    balanceText: string;
    depositText: string;
    retryText: string;
    enterCard: string;
    payBalance: string;
    retryPayment: string;
    continueWith: (provider: string) => string;
    amountDue: (description: string, amount: string) => string;
    cardFormUnavailable: string;
    cardCouldNotStart: string;
    enterCardThenConfirm: string;
    confirmCard: string;
    cardNotReady: string;
    confirming: string;
    cardFailed: string;
    notCompleted: string;
    submitted: string;
    updating: string;
    couldNotComplete: string;
    preparing: string;
    retryingIn: (message: string, seconds: string) => string;
    couldNotStart: string;
    pageCouldNotOpen: string;
    redirecting: string;
    cancelledTitle: string;
    cancelledText: string;
    failedTitle: string;
    failedText: string;
    submittedTitle: string;
    submittedText: string;
  };
  phone: {
    notice: (phone: string) => string;
    verify: string;
    resend: string;
    resendIn: (wait: string) => string;
    submit: string;
    code: string;
    sending: string;
    verifying: string;
    enterCode: string;
    tryAgainIn: (error: string, wait: string) => string;
  };
  profile: {
    title: string;
    signInTitle: string;
    signInBody: string;
    details: string;
    name: string;
    edit: string;
    editName: string;
    fullName: string;
    cancel: string;
    save: string;
    email: string;
    phone: string;
    notAdded: string;
    addresses: string;
    addAddress: string;
    editAddress: string;
    noAddress: string;
    noAddressBody: string;
    defaultAddress: string;
    address: string;
    default: string;
    defaultBilling: string;
    remove: string;
    makeDefault: string;
    useForBilling: string;
    removeTitle: string;
    removeDefaultNote: string;
    removeNote: string;
    removeAddress: string;
    wentWrong: string;
    savedName: string;
    savedAddress: string;
    removed: string;
    defaultChanged: string;
    billingChanged: string;
    enterName: string;
    enterAddress: string;
    enterDeliveryAddress: string;
    completeAddress: (min: string) => string;
    chooseCity: string;
    chooseArea: string;
    addressLabel: string;
    addressPlaceholder: string;
    makeDefaultAddress: string;
    saveAddress: string;
  };
}

const EN: AccountCopy = {
  shell: {
    nav: "Account",
    orders: "Orders",
    profile: "Profile",
    inbox: "Inbox",
    reviews: "Reviews",
    downloads: "Downloads",
    giftCards: "Gift cards",
    warranties: "Warranties",
    unread: "unread",
    toReview: "to review",
    signOut: "Sign out",
    signIn: "Sign in",
    signInTitle: "Sign in to your account",
    signInBody: "Track orders, message the store and save your delivery details.",
    unavailable: "We couldn't reach the store. Check your connection and try again.",
    retry: "Retry",
    close: "Close",
    goToOrders: "Go to your orders",
  },
  format: {
    paymentNeedsAttention: "Payment needs attention",
    cancellationRequested: "Cancellation requested",
    returnRequested: "Return requested",
    refundRequested: "Refund requested",
    requestOpen: "Request open",
    variant: "Variant",
  },
  orders: {
    title: "Orders",
    count: (count, one) => `${count} ${one ? "order" : "orders"}`,
    signInTitle: "Sign in to see your orders",
    signInBody: "Track orders and save your delivery details for faster checkout.",
    phoneVerified: "Phone verified. Orders placed with it are now in your account.",
    noOlder: "No older orders",
    none: "No orders yet",
    noneBody: "When you place an order, it shows here with its status and delivery updates.",
    startShopping: "Start shopping",
    trackGuest: "Track an order placed without signing in",
    order: (number) => `Order ${number}`,
    items: (count, one) => `${count} ${one ? "item" : "items"}`,
    buyAgain: "Buy again",
    newest: "Newest orders",
    older: "Older orders",
    allGone: "These items are no longer available.",
    someGone: "Some items are no longer available, so they weren't added.",
  },
  order: {
    pageTitle: "Order",
    signInTitle: "Sign in to see this order",
    trackInstead: "Track this order instead",
    noScript: "This order page needs JavaScript. You can still follow the order without it.",
    trackThis: "Track this order",
    loading: "Loading your order",
    backToOrders: "Back to your orders",
    status: "Status",
    updates: "Updates",
    items: "Items",
    shippingAddress: "Shipping address",
    payment: "Payment",
    paymentMethod: "Payment method",
    help: "Order help",
    helpIntro: "Send a request and the store will review it before changing payment, shipment, or inventory.",
    reason: "Reason",
    note: "Note (required for Other)",
    cancel: "Cancel",
    submit: "Submit request",
    submitting: "Submitting…",
    cancelReasons: ["Ordered by mistake", "Found a better price", "Delivery is too slow", "Need to change the address or items", "Other"],
    returnReasons: ["Damaged or defective", "Wrong item received", "Not as described", "Changed my mind", "Other"],
    other: "Other",
    chooseReason: "Choose a reason.",
    tellStore: "Tell the store what you need.",
    requestFailed: "Request could not be sent. Try again.",
    title: (number) => `Order ${number}`,
    placed: (date) => `Placed ${date}`,
    notFound: "Order not found",
    linkIncomplete: "This order link is incomplete.",
    notInAccount: "We couldn't find this order in your account.",
    unreachable: "We couldn't reach the store",
    wentWrong: "Something went wrong",
    couldNotShow: "This order could not be shown. Try again.",
    expectedDelivery: (date) => `Expected delivery: ${date}`,
    product: "Product",
    quantity: (count, unit) => `Qty ${count} × ${unit}`,
    lineDiscount: (amount) => `Discount -${amount}`,
    subtotal: "Subtotal",
    tax: "Tax",
    taxIncluded: (label) => `${label} (included)`,
    total: "Total",
    deliveryMethod: (name) => `Delivery method: ${name}`,
    updated: (date) => `Updated ${date}`,
    paid: (amount) => `${amount} paid`,
    collected: (amount) => `${amount} collected`,
    advance: (amount) => `Advance ${amount}`,
    refundOnWay: (amount) => `${amount} is on its way back to you.`,
  },
  tracking: {
    milestones: {
      placed: "Order placed", confirmed: "Confirmed", shipped: "On its way", delivered: "Delivered",
      cancelled: "Cancelled", returned: "Returned", refunded: "Refunded", partially_refunded: "Partly refunded",
    },
    awaitingPayment: "Awaiting payment",
    placedDetails: "We received your order.",
    confirmedDetails: "The store confirmed your order.",
    shippedDetails: "Your order is with the courier.",
    withCourier: (courier) => `With ${courier}.`,
    shipments: {
      picked_up: "On its way", in_transit: "On its way", out_for_delivery: "Out for delivery", delivered: "Delivered",
      partial_delivered: "Partly delivered", delivery_failed: "Delivery attempt failed", pickup_failed: "Delayed",
      on_hold: "Delayed", returned: "Returned to the store", cancelled: "Cancelled",
    },
    booked: "Booked with courier",
    paymentReceived: "Payment received",
    paymentFailed: "Payment didn't go through",
  },
  recovery: {
    balanceTitle: "Remaining balance is due",
    depositTitle: "Advance payment is due",
    retryTitle: "Payment needs attention",
    balanceText: "Complete the remaining online payment for this order.",
    depositText: "Pay the required advance to keep this order moving.",
    retryText: "Retry the online payment for this order.",
    enterCard: "Enter card details",
    payBalance: "Pay balance",
    retryPayment: "Retry payment",
    continueWith: (provider) => `Continue with ${provider}`,
    amountDue: (description, amount) => `${description} Amount due: ${amount}.`,
    cardFormUnavailable: "Card payment form is unavailable. Refresh and try again.",
    cardCouldNotStart: "Card payment could not start. Try again.",
    enterCardThenConfirm: "Enter your card details, then confirm payment.",
    confirmCard: "Confirm card payment",
    cardNotReady: "The card form is not ready yet.",
    confirming: "Confirming…",
    cardFailed: "Card payment failed.",
    notCompleted: "Payment was not completed.",
    submitted: "Payment submitted. Updating the order…",
    updating: "Updating…",
    couldNotComplete: "Payment could not be completed.",
    preparing: "Preparing payment…",
    retryingIn: (message, seconds) => `${message} Retrying in ${seconds}s…`,
    couldNotStart: "Payment could not start. Try again.",
    pageCouldNotOpen: "The payment page could not open. Try again.",
    redirecting: "Redirecting…",
    cancelledTitle: "Payment was cancelled",
    cancelledText: "Your order is still saved. You can retry payment from this page.",
    failedTitle: "Payment did not complete",
    failedText: "The gateway reported a failed payment. You can retry when ready.",
    submittedTitle: "Payment submitted",
    submittedText: "We are checking the gateway confirmation. This page will show the latest payment status.",
  },
  phone: {
    notice: (phone) => `Verify your phone number ${phone} to add orders you placed with it.`,
    verify: "Verify phone",
    resend: "Send a new code",
    resendIn: (wait) => `Send a new code in ${wait}`,
    submit: "Verify",
    code: "Code",
    sending: "Sending…",
    verifying: "Verifying…",
    enterCode: "Enter the code we sent.",
    tryAgainIn: (error, wait) => `${error} Try again in ${wait}.`,
  },
  profile: {
    title: "Profile",
    signInTitle: "Sign in to see your profile",
    signInBody: "Save your delivery details for faster checkout.",
    details: "Your details",
    name: "Name",
    edit: "Edit",
    editName: "Edit name",
    fullName: "Full name",
    cancel: "Cancel",
    save: "Save",
    email: "Email",
    phone: "Phone",
    notAdded: "Not added",
    addresses: "Addresses",
    addAddress: "Add address",
    editAddress: "Edit address",
    noAddress: "No saved address",
    noAddressBody: "Add one and checkout fills it in for you.",
    defaultAddress: "Default address",
    address: "Address",
    default: "Default",
    defaultBilling: "Default billing",
    remove: "Remove",
    makeDefault: "Make default",
    useForBilling: "Use for billing",
    removeTitle: "Remove this address?",
    removeDefaultNote: "Your most recently changed other address becomes the default.",
    removeNote: "Checkout will ask for your delivery address again next time.",
    removeAddress: "Remove address",
    wentWrong: "Something went wrong. Try again.",
    savedName: "Name saved.",
    savedAddress: "Address saved.",
    removed: "Address removed.",
    defaultChanged: "Default address changed.",
    billingChanged: "Billing address changed.",
    enterName: "Enter your full name.",
    enterAddress: "Enter your address.",
    enterDeliveryAddress: "Enter your delivery address.",
    completeAddress: (min) => `Enter a complete delivery address (at least ${min} characters).`,
    chooseCity: "Choose a city.",
    chooseArea: "Choose an area in this thana, or leave it empty.",
    addressLabel: "Address",
    addressPlaceholder: "House, road, area",
    makeDefaultAddress: "Make this my default address",
    saveAddress: "Save address",
  },
};

const BN: AccountCopy = {
  shell: {
    nav: "অ্যাকাউন্ট",
    orders: "অর্ডার",
    profile: "প্রোফাইল",
    inbox: "ইনবক্স",
    reviews: "রিভিউ",
    downloads: "ডাউনলোড",
    giftCards: "গিফট কার্ড",
    warranties: "ওয়ারেন্টি",
    unread: "অপঠিত",
    toReview: "রিভিউ বাকি",
    signOut: "সাইন আউট",
    signIn: "সাইন ইন",
    signInTitle: "আপনার অ্যাকাউন্টে সাইন ইন করুন",
    signInBody: "অর্ডার ট্র্যাক করুন, স্টোরকে মেসেজ পাঠান এবং ডেলিভারির তথ্য সেভ রাখুন।",
    unavailable: "স্টোরের সাথে যোগাযোগ করা যায়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।",
    retry: "আবার চেষ্টা করুন",
    close: "বন্ধ করুন",
    goToOrders: "আপনার অর্ডারে যান",
  },
  format: {
    paymentNeedsAttention: "পেমেন্টে সমস্যা হয়েছে",
    cancellationRequested: "বাতিলের অনুরোধ করা হয়েছে",
    returnRequested: "ফেরতের অনুরোধ করা হয়েছে",
    refundRequested: "রিফান্ডের অনুরোধ করা হয়েছে",
    requestOpen: "অনুরোধ চলমান",
    variant: "ধরন",
  },
  orders: {
    title: "অর্ডার",
    count: (count) => `${count}টি অর্ডার`,
    signInTitle: "আপনার অর্ডার দেখতে সাইন ইন করুন",
    signInBody: "অর্ডার ট্র্যাক করুন এবং দ্রুত চেকআউটের জন্য ডেলিভারির তথ্য সেভ রাখুন।",
    phoneVerified: "ফোন নম্বর যাচাই হয়েছে। এই নম্বরে দেওয়া অর্ডারগুলো এখন আপনার অ্যাকাউন্টে আছে।",
    noOlder: "এর আগের কোনো অর্ডার নেই",
    none: "এখনো কোনো অর্ডার নেই",
    noneBody: "অর্ডার দিলে তার অবস্থা ও ডেলিভারির খবরসহ এখানে দেখা যাবে।",
    startShopping: "কেনাকাটা শুরু করুন",
    trackGuest: "সাইন ইন না করে দেওয়া অর্ডার ট্র্যাক করুন",
    order: (number) => `অর্ডার ${number}`,
    items: (count) => `${count}টি পণ্য`,
    buyAgain: "আবার কিনুন",
    newest: "সাম্প্রতিক অর্ডার",
    older: "পুরোনো অর্ডার",
    allGone: "এই পণ্যগুলো আর পাওয়া যাচ্ছে না।",
    someGone: "কিছু পণ্য আর পাওয়া যাচ্ছে না, তাই সেগুলো যোগ করা হয়নি।",
  },
  order: {
    pageTitle: "অর্ডার",
    signInTitle: "এই অর্ডার দেখতে সাইন ইন করুন",
    trackInstead: "এর বদলে অর্ডারটি ট্র্যাক করুন",
    noScript: "এই অর্ডারের পেজ দেখতে জাভাস্ক্রিপ্ট লাগে। তবু অর্ডারটির খবর রাখতে পারবেন।",
    trackThis: "অর্ডারটি ট্র্যাক করুন",
    loading: "আপনার অর্ডার লোড হচ্ছে",
    backToOrders: "আপনার অর্ডারে ফিরুন",
    status: "অবস্থা",
    updates: "আপডেট",
    items: "পণ্য",
    shippingAddress: "ডেলিভারির ঠিকানা",
    payment: "পেমেন্ট",
    paymentMethod: "পেমেন্টের মাধ্যম",
    help: "অর্ডার নিয়ে সাহায্য",
    helpIntro: "অনুরোধ পাঠান, পেমেন্ট, শিপমেন্ট বা স্টকে কোনো পরিবর্তনের আগে স্টোর তা দেখে নেবে।",
    reason: "কারণ",
    note: "নোট (অন্য কারণ হলে লিখতে হবে)",
    cancel: "বাতিল",
    submit: "অনুরোধ পাঠান",
    submitting: "পাঠানো হচ্ছে…",
    cancelReasons: ["ভুল করে অর্ডার দিয়েছি", "অন্য কোথাও কম দামে পেয়েছি", "ডেলিভারিতে অনেক দেরি হচ্ছে", "ঠিকানা বা পণ্য বদলাতে চাই", "অন্য কারণ"],
    returnReasons: ["পণ্য নষ্ট বা ত্রুটিপূর্ণ", "ভুল পণ্য পেয়েছি", "বর্ণনার সাথে মেলে না", "মত বদলেছি", "অন্য কারণ"],
    other: "অন্য কারণ",
    chooseReason: "একটি কারণ বেছে নিন।",
    tellStore: "আপনার কী দরকার, স্টোরকে লিখে জানান।",
    requestFailed: "অনুরোধ পাঠানো যায়নি। আবার চেষ্টা করুন।",
    title: (number) => `অর্ডার ${number}`,
    placed: (date) => `অর্ডারের সময় ${date}`,
    notFound: "অর্ডার পাওয়া যায়নি",
    linkIncomplete: "এই অর্ডারের লিংকটি অসম্পূর্ণ।",
    notInAccount: "আপনার অ্যাকাউন্টে এই অর্ডারটি পাওয়া যায়নি।",
    unreachable: "স্টোরের সাথে যোগাযোগ করা যায়নি",
    wentWrong: "কিছু একটা সমস্যা হয়েছে",
    couldNotShow: "অর্ডারটি দেখানো যায়নি। আবার চেষ্টা করুন।",
    expectedDelivery: (date) => `সম্ভাব্য ডেলিভারি: ${date}`,
    product: "পণ্য",
    quantity: (count, unit) => `পরিমাণ ${count} × ${unit}`,
    lineDiscount: (amount) => `ছাড় -${amount}`,
    subtotal: "সাবটোটাল",
    tax: "ট্যাক্স",
    taxIncluded: (label) => `${label} (দামে ধরা আছে)`,
    total: "মোট",
    deliveryMethod: (name) => `ডেলিভারির ধরন: ${name}`,
    updated: (date) => `আপডেট ${date}`,
    paid: (amount) => `${amount} পরিশোধিত`,
    collected: (amount) => `${amount} সংগ্রহ করা হয়েছে`,
    advance: (amount) => `অগ্রিম ${amount}`,
    refundOnWay: (amount) => `${amount} আপনার কাছে ফেরত আসছে।`,
  },
  tracking: {
    milestones: {
      placed: "অর্ডার দেওয়া হয়েছে", confirmed: "নিশ্চিত হয়েছে", shipped: "পথে আছে", delivered: "ডেলিভারি হয়েছে",
      cancelled: "বাতিল হয়েছে", returned: "ফেরত এসেছে", refunded: "রিফান্ড হয়েছে", partially_refunded: "আংশিক রিফান্ড হয়েছে",
    },
    awaitingPayment: "পেমেন্টের অপেক্ষায়",
    placedDetails: "আমরা আপনার অর্ডার পেয়েছি।",
    confirmedDetails: "স্টোর আপনার অর্ডার নিশ্চিত করেছে।",
    shippedDetails: "আপনার অর্ডার কুরিয়ারের কাছে আছে।",
    withCourier: (courier) => `${courier}-এর কাছে আছে।`,
    shipments: {
      picked_up: "পথে আছে", in_transit: "পথে আছে", out_for_delivery: "ডেলিভারির জন্য বের হয়েছে", delivered: "ডেলিভারি হয়েছে",
      partial_delivered: "আংশিক ডেলিভারি হয়েছে", delivery_failed: "ডেলিভারির চেষ্টা ব্যর্থ হয়েছে", pickup_failed: "দেরি হচ্ছে",
      on_hold: "দেরি হচ্ছে", returned: "স্টোরে ফেরত গেছে", cancelled: "বাতিল হয়েছে",
    },
    booked: "কুরিয়ারে বুক করা হয়েছে",
    paymentReceived: "পেমেন্ট পাওয়া গেছে",
    paymentFailed: "পেমেন্ট হয়নি",
  },
  recovery: {
    balanceTitle: "বাকি টাকা পরিশোধ করতে হবে",
    depositTitle: "অগ্রিম পেমেন্ট করতে হবে",
    retryTitle: "পেমেন্টে সমস্যা হয়েছে",
    balanceText: "এই অর্ডারের বাকি অনলাইন পেমেন্ট সম্পন্ন করুন।",
    depositText: "অর্ডারটি এগিয়ে নিতে প্রয়োজনীয় অগ্রিম দিন।",
    retryText: "এই অর্ডারের অনলাইন পেমেন্ট আবার করুন।",
    enterCard: "কার্ডের তথ্য দিন",
    payBalance: "বাকি টাকা দিন",
    retryPayment: "আবার পেমেন্ট করুন",
    continueWith: (provider) => `${provider} দিয়ে এগিয়ে যান`,
    amountDue: (description, amount) => `${description} পরিশোধ বাকি: ${amount}।`,
    cardFormUnavailable: "কার্ডে পেমেন্টের ফর্মটি এখন পাওয়া যাচ্ছে না। পেজ রিফ্রেশ করে আবার চেষ্টা করুন।",
    cardCouldNotStart: "কার্ডে পেমেন্ট শুরু করা যায়নি। আবার চেষ্টা করুন।",
    enterCardThenConfirm: "কার্ডের তথ্য দিন, তারপর পেমেন্ট নিশ্চিত করুন।",
    confirmCard: "কার্ডে পেমেন্ট নিশ্চিত করুন",
    cardNotReady: "কার্ডের ফর্মটি এখনো তৈরি হয়নি।",
    confirming: "নিশ্চিত করা হচ্ছে…",
    cardFailed: "কার্ডে পেমেন্ট হয়নি।",
    notCompleted: "পেমেন্ট সম্পন্ন হয়নি।",
    submitted: "পেমেন্ট জমা হয়েছে। অর্ডারটি আপডেট করা হচ্ছে…",
    updating: "আপডেট হচ্ছে…",
    couldNotComplete: "পেমেন্ট সম্পন্ন করা যায়নি।",
    preparing: "পেমেন্ট তৈরি হচ্ছে…",
    retryingIn: (message, seconds) => `${message} ${seconds} সেকেন্ড পরে আবার চেষ্টা করা হবে…`,
    couldNotStart: "পেমেন্ট শুরু করা যায়নি। আবার চেষ্টা করুন।",
    pageCouldNotOpen: "পেমেন্টের পেজ খোলা যায়নি। আবার চেষ্টা করুন।",
    redirecting: "নিয়ে যাওয়া হচ্ছে…",
    cancelledTitle: "পেমেন্ট বাতিল হয়েছে",
    cancelledText: "আপনার অর্ডারটি সেভ আছে। এই পেজ থেকে আবার পেমেন্ট করতে পারবেন।",
    failedTitle: "পেমেন্ট সম্পন্ন হয়নি",
    failedText: "পেমেন্ট গেটওয়ে জানিয়েছে পেমেন্টটি হয়নি। প্রস্তুত হলে আবার চেষ্টা করুন।",
    submittedTitle: "পেমেন্ট জমা হয়েছে",
    submittedText: "গেটওয়ের নিশ্চিতকরণ যাচাই করা হচ্ছে। এই পেজে পেমেন্টের সর্বশেষ অবস্থা দেখা যাবে।",
  },
  phone: {
    notice: (phone) => `${phone} নম্বরে দেওয়া অর্ডারগুলো যোগ করতে নম্বরটি যাচাই করুন।`,
    verify: "ফোন নম্বর যাচাই করুন",
    resend: "নতুন কোড পাঠান",
    resendIn: (wait) => `${wait} পরে নতুন কোড পাঠান`,
    submit: "যাচাই করুন",
    code: "কোড",
    sending: "পাঠানো হচ্ছে…",
    verifying: "যাচাই করা হচ্ছে…",
    enterCode: "আমাদের পাঠানো কোডটি লিখুন।",
    tryAgainIn: (error, wait) => `${error} ${wait} পরে আবার চেষ্টা করুন।`,
  },
  profile: {
    title: "প্রোফাইল",
    signInTitle: "আপনার প্রোফাইল দেখতে সাইন ইন করুন",
    signInBody: "দ্রুত চেকআউটের জন্য ডেলিভারির তথ্য সেভ রাখুন।",
    details: "আপনার তথ্য",
    name: "নাম",
    edit: "বদলান",
    editName: "নাম বদলান",
    fullName: "পুরো নাম",
    cancel: "বাতিল",
    save: "সেভ করুন",
    email: "ইমেইল",
    phone: "ফোন",
    notAdded: "যোগ করা হয়নি",
    addresses: "ঠিকানা",
    addAddress: "ঠিকানা যোগ করুন",
    editAddress: "ঠিকানা বদলান",
    noAddress: "কোনো ঠিকানা সেভ করা নেই",
    noAddressBody: "একটি যোগ করুন, চেকআউটে সেটি নিজে থেকেই বসে যাবে।",
    defaultAddress: "ডিফল্ট ঠিকানা",
    address: "ঠিকানা",
    default: "ডিফল্ট",
    defaultBilling: "ডিফল্ট বিলিং",
    remove: "মুছুন",
    makeDefault: "ডিফল্ট করুন",
    useForBilling: "বিলিংয়ে ব্যবহার করুন",
    removeTitle: "এই ঠিকানাটি মুছবেন?",
    removeDefaultNote: "সবশেষে বদলানো অন্য ঠিকানাটি ডিফল্ট হবে।",
    removeNote: "পরের বার চেকআউটে আবার ডেলিভারির ঠিকানা চাওয়া হবে।",
    removeAddress: "ঠিকানা মুছুন",
    wentWrong: "কিছু একটা সমস্যা হয়েছে। আবার চেষ্টা করুন।",
    savedName: "নাম সেভ হয়েছে।",
    savedAddress: "ঠিকানা সেভ হয়েছে।",
    removed: "ঠিকানা মুছে ফেলা হয়েছে।",
    defaultChanged: "ডিফল্ট ঠিকানা বদলানো হয়েছে।",
    billingChanged: "বিলিংয়ের ঠিকানা বদলানো হয়েছে।",
    enterName: "আপনার পুরো নাম লিখুন।",
    enterAddress: "আপনার ঠিকানা লিখুন।",
    enterDeliveryAddress: "ডেলিভারির ঠিকানা লিখুন।",
    completeAddress: (min) => `ডেলিভারির পুরো ঠিকানা লিখুন (কমপক্ষে ${min} অক্ষর)।`,
    chooseCity: "একটি শহর বেছে নিন।",
    chooseArea: "এই থানার একটি এলাকা বেছে নিন, অথবা খালি রাখুন।",
    addressLabel: "ঠিকানা",
    addressPlaceholder: "বাড়ি, রাস্তা, এলাকা",
    makeDefaultAddress: "এটিকে আমার ডিফল্ট ঠিকানা করুন",
    saveAddress: "ঠিকানা সেভ করুন",
  },
};

const COPY: Record<StorefrontLanguage, AccountCopy> = { en: EN, bn: BN };

/** The account's words in the page's language (Bangla on a Bangla store). */
export function accountCopy(language: string = pageLanguage()): AccountCopy {
  return COPY[storefrontLanguage(language)];
}
