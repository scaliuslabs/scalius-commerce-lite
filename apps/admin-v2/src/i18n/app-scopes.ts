import type { PluginScope } from "@scalius/shared/plugins/scopes";
import { defineMessages } from "./index";

/**
 * The consent screen's words for each app access scope (`PLUGIN_SCOPES`): a
 * short name and what it lets the app do. Every scope has both, in every
 * language (checked by the type below).
 */
type ScopeCopy = Record<`scope_${PluginScope}` | `scope_${PluginScope}_help`, string>;

const en = {
  scope_read_products: "View products",
  scope_read_products_help: "Products, variants, stock levels, collections, categories, brands and attributes.",
  scope_write_products: "Manage products",
  scope_write_products_help: "Create, edit, trash and restore products, variants, collections, categories and brands, and adjust stock. It can't delete anything permanently.",
  scope_read_orders: "View orders",
  scope_read_orders_help: "Orders with their items, payments, shipments, returns and timeline, and abandoned checkouts. Orders include buyers' names, phone numbers and addresses.",
  scope_write_orders: "Manage orders",
  scope_write_orders_help: "Create orders, change their status and delivery details, and add notes to their timeline.",
  scope_write_fulfillments: "Fulfil orders",
  scope_write_fulfillments_help: "Hand over order items, book courier shipments and mark orders delivered.",
  scope_read_customers: "View customers",
  scope_read_customers_help: "Customers with their contact details, addresses, tags and marketing choices, and send them order messages.",
  scope_write_customers: "Manage customers",
  scope_write_customers_help: "Create and edit customers and their tags.",
  scope_write_marketing: "Send marketing",
  scope_write_marketing_help: "Send marketing email and text messages to customers who agreed to receive them. A staff member with the marketing permission approves each send.",
  scope_read_discounts: "View discounts",
  scope_read_discounts_help: "Discounts and their rules.",
  scope_write_discounts: "Manage discounts",
  scope_write_discounts_help: "Create, edit, pause, activate and archive discounts.",
  scope_read_content: "View pages",
  scope_read_content_help: "Your store's content pages.",
  scope_write_content: "Manage pages",
  scope_write_content_help: "Create, edit, publish and trash content pages.",
  scope_read_objects: "View store content types",
  scope_read_objects_help: "Entries of your store's own content types.",
  scope_write_objects: "Manage store content types",
  scope_write_objects_help: "Create, edit and delete entries of your store's own content types.",
  scope_read_files: "View files",
  scope_read_files_help: "Images and videos in your media library.",
  scope_write_files: "Manage files",
  scope_write_files_help: "Add files from a web address, rename, move and trash them.",
  scope_read_settings: "View store settings",
  scope_read_settings_help: "Business details, web addresses, markets, languages and custom field definitions.",
  scope_write_places: "Load delivery places",
  scope_write_places_help: "Add and update the cities, areas and postal codes buyers pick for delivery. It can't delete one.",
} satisfies ScopeCopy;

const bn = {
  scope_read_products: "প্রোডাক্ট দেখা",
  scope_read_products_help: "প্রোডাক্ট, ভ্যারিয়েন্ট, স্টকের পরিমাণ, কালেকশন, ক্যাটাগরি, ব্র্যান্ড ও অ্যাট্রিবিউট।",
  scope_write_products: "প্রোডাক্ট পরিচালনা",
  scope_write_products_help: "প্রোডাক্ট, ভ্যারিয়েন্ট, কালেকশন, ক্যাটাগরি ও ব্র্যান্ড তৈরি, এডিট, ট্র্যাশ ও ফিরিয়ে আনা, এবং স্টক বদলানো। কোনো কিছু স্থায়ীভাবে ডিলিট করতে পারে না।",
  scope_read_orders: "অর্ডার দেখা",
  scope_read_orders_help: "অর্ডারের আইটেম, পেমেন্ট, শিপমেন্ট, রিটার্ন ও টাইমলাইন, এবং অসম্পূর্ণ চেকআউট। অর্ডারে ক্রেতার নাম, ফোন নম্বর ও ঠিকানা থাকে।",
  scope_write_orders: "অর্ডার পরিচালনা",
  scope_write_orders_help: "অর্ডার তৈরি, স্ট্যাটাস ও ডেলিভারির তথ্য বদলানো, এবং টাইমলাইনে নোট যোগ করা।",
  scope_write_fulfillments: "অর্ডার ফুলফিল করা",
  scope_write_fulfillments_help: "অর্ডারের আইটেম হস্তান্তর, কুরিয়ার শিপমেন্ট বুক করা এবং অর্ডার ডেলিভার্ড চিহ্নিত করা।",
  scope_read_customers: "কাস্টমার দেখা",
  scope_read_customers_help: "কাস্টমারের যোগাযোগের তথ্য, ঠিকানা, ট্যাগ ও মার্কেটিং পছন্দ, এবং তাঁদের অর্ডারের মেসেজ পাঠানো।",
  scope_write_customers: "কাস্টমার পরিচালনা",
  scope_write_customers_help: "কাস্টমার ও তাঁদের ট্যাগ তৈরি ও এডিট করা।",
  scope_write_marketing: "মার্কেটিং পাঠানো",
  scope_write_marketing_help: "যেসব কাস্টমার রাজি হয়েছেন তাঁদের মার্কেটিং ইমেইল ও টেক্সট মেসেজ পাঠানো। মার্কেটিং অনুমতি থাকা একজন স্টাফ প্রতিটি পাঠানো অনুমোদন করেন।",
  scope_read_discounts: "ডিসকাউন্ট দেখা",
  scope_read_discounts_help: "ডিসকাউন্ট ও তার নিয়ম।",
  scope_write_discounts: "ডিসকাউন্ট পরিচালনা",
  scope_write_discounts_help: "ডিসকাউন্ট তৈরি, এডিট, থামানো, চালু ও আর্কাইভ করা।",
  scope_read_content: "পেজ দেখা",
  scope_read_content_help: "আপনার স্টোরের কনটেন্ট পেজ।",
  scope_write_content: "পেজ পরিচালনা",
  scope_write_content_help: "কনটেন্ট পেজ তৈরি, এডিট, প্রকাশ ও ট্র্যাশ করা।",
  scope_read_objects: "স্টোরের কনটেন্ট টাইপ দেখা",
  scope_read_objects_help: "আপনার স্টোরের নিজস্ব কনটেন্ট টাইপের এন্ট্রি।",
  scope_write_objects: "স্টোরের কনটেন্ট টাইপ পরিচালনা",
  scope_write_objects_help: "আপনার স্টোরের নিজস্ব কনটেন্ট টাইপের এন্ট্রি তৈরি, এডিট ও ডিলিট করা।",
  scope_read_files: "ফাইল দেখা",
  scope_read_files_help: "আপনার মিডিয়া লাইব্রেরির ছবি ও ভিডিও।",
  scope_write_files: "ফাইল পরিচালনা",
  scope_write_files_help: "ওয়েব ঠিকানা থেকে ফাইল যোগ করা, নাম বদলানো, সরানো ও ট্র্যাশ করা।",
  scope_read_settings: "স্টোরের সেটিংস দেখা",
  scope_read_settings_help: "ব্যবসার তথ্য, ওয়েব ঠিকানা, মার্কেট, ভাষা ও কাস্টম ফিল্ডের সংজ্ঞা।",
  scope_write_places: "ডেলিভারির জায়গা লোড করা",
  scope_write_places_help: "ডেলিভারির জন্য ক্রেতারা যে শহর, এলাকা ও পোস্টাল কোড বেছে নেন সেগুলো যোগ ও আপডেট করা। কোনোটি ডিলিট করতে পারে না।",
} satisfies ScopeCopy;

export const appScopeMessages = defineMessages({ en, bn });
