import { defineMessages } from "./index";

/** The customer page's Tax exemption card. */
export const customerTaxExemptionMessages = defineMessages({
  en: {
    title: "Tax exemption",
    taxExempt: "Tax exempt",
    help: "Their orders pay no tax. Existing orders keep the tax they were placed with.",
    exemptionNumber: "Exemption number",
    exemptionNumberHelp: "A VAT registration or resale certificate number. It is printed on their invoices.",
    save: "Save",
    saved: "Tax exemption saved",
    stateExempt: "Tax exempt",
    stateNotExempt: "Not tax exempt",
    numberLabel: "Exemption number: {number}",
  },
  bn: {
    title: "কর অব্যাহতি",
    taxExempt: "কর অব্যাহতিপ্রাপ্ত",
    help: "তাঁর অর্ডারে কোনো কর লাগে না। আগের অর্ডারে যে কর ধরা হয়েছিল, তা-ই থাকে।",
    exemptionNumber: "অব্যাহতি নম্বর",
    exemptionNumberHelp: "ভ্যাট রেজিস্ট্রেশন বা পুনর্বিক্রয় সনদের নম্বর। এটি তাঁর ইনভয়েসে ছাপা হয়।",
    save: "সেভ করুন",
    saved: "কর অব্যাহতি সেভ হয়েছে",
    stateExempt: "কর অব্যাহতিপ্রাপ্ত",
    stateNotExempt: "কর অব্যাহতি নেই",
    numberLabel: "অব্যাহতি নম্বর: {number}",
  },
});
