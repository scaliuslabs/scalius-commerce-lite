// The demo feature's admin page: what the demo store holds, the import and
// removal progress, and what is left for the merchant to wire in the theme
// editor (an app cannot write the theme or the menus; BURST-NOTES.md).

import { ui, type PluginAdminLocale, type PluginContext } from "@scalius/plugin-sdk";
import type { PluginUiNode } from "@scalius/shared/plugins";
import type { DemoPack } from "../../demo-pack";
import { importPlan } from "./plan";
import { readJob, readRecords } from "./run";

const words = {
  en: {
    title: "Demo store",
    intro: "Imports a complete gadget store: categories with their tree, brands, products with options, photos and specifications, collections and the home page's banners. Every demo item is hidden from search engines. Removal trashes only what the import created and keeps anything you changed since.",
    imported: "Imported",
    of: (done: number, total: number) => `${done} of ${total}`,
    status: "Status",
    idle: "Ready",
    importing: "Importing: continues every minute, or press Continue",
    removing: "Removing: continues every minute, or press Continue",
    import: "Import demo store",
    continue: "Continue",
    remove: "Remove demo content",
    removeTitle: "Remove the demo content?",
    removeText: "Moves every product, category, brand, collection and file the demo created to the trash. Items you edited since the import are kept.",
    kept: (count: number) => `${count} demo items you changed were kept.`,
    finish: "Finish the home page",
    finishText: "Apply the Volt template in Online store → Theme, then point its sections at the demo: the hero's slides and side banners at the banner files, Featured Category at the categories below, and each product tab at a collection or category.",
    name: "Demo item",
    id: "Id",
  },
  bn: {
    title: "ডেমো স্টোর",
    intro: "একটি সম্পূর্ণ গ্যাজেট স্টোর ইমপোর্ট করে: ক্যাটাগরি, ব্র্যান্ড, অপশন ও স্পেসিফিকেশনসহ পণ্য, কালেকশন এবং হোম পেজের ব্যানার। সব ডেমো আইটেম সার্চ ইঞ্জিন থেকে লুকানো। সরালে শুধু ইমপোর্ট করা জিনিসগুলো ট্র্যাশে যায়; আপনার বদলানো আইটেম থেকে যায়।",
    imported: "ইমপোর্ট হয়েছে",
    of: (done: number, total: number) => `${total}টির মধ্যে ${done}টি`,
    status: "অবস্থা",
    idle: "প্রস্তুত",
    importing: "ইমপোর্ট চলছে: প্রতি মিনিটে চলবে, অথবা চালিয়ে যান চাপুন",
    removing: "সরানো চলছে: প্রতি মিনিটে চলবে, অথবা চালিয়ে যান চাপুন",
    import: "ডেমো স্টোর ইমপোর্ট করুন",
    continue: "চালিয়ে যান",
    remove: "ডেমো কনটেন্ট সরান",
    removeTitle: "ডেমো কনটেন্ট সরাবেন?",
    removeText: "ডেমোর তৈরি সব পণ্য, ক্যাটাগরি, ব্র্যান্ড, কালেকশন ও ফাইল ট্র্যাশে যাবে। ইমপোর্টের পরে বদলানো আইটেম থেকে যাবে।",
    kept: (count: number) => `আপনার বদলানো ${count}টি ডেমো আইটেম রাখা হয়েছে।`,
    finish: "হোম পেজ সাজানো শেষ করুন",
    finishText: "অনলাইন স্টোর → থিমে Volt টেমপ্লেট দিন, তারপর সেকশনগুলো ডেমোর সাথে যুক্ত করুন: হিরোর স্লাইড ও পাশের ব্যানার, ফিচার্ড ক্যাটাগরি এবং প্রতিটি প্রোডাক্ট ট্যাব।",
    name: "ডেমো আইটেম",
    id: "আইডি",
  },
};

export async function demoPage(ctx: PluginContext, pack: DemoPack, locale: PluginAdminLocale) {
  const w = words[locale];
  const [job, records] = await Promise.all([readJob(ctx), readRecords(ctx)]);
  const total = importPlan(pack).length;
  const busy = job.mode !== "idle";
  const status = job.mode === "import" ? w.importing : job.mode === "remove" ? w.removing : w.idle;
  const nodes: PluginUiNode[] = [
    ui.text(w.intro),
    ui.columns([ui.stat(w.imported, w.of(records.size, total)), ui.stat(w.status, status)]),
  ];
  if (job.error) nodes.push(ui.banner("critical", job.error));
  if (job.kept > 0 && job.mode !== "import") nodes.push(ui.banner("info", w.kept(job.kept)));
  const actions = [
    job.mode === "remove"
      ? ui.button(w.continue, ui.route("demo-remove"), { tone: "primary" })
      : ui.button(job.mode === "import" ? w.continue : w.import, ui.route("demo-import"), { tone: "primary", disabled: !busy && records.size >= total }),
    ...(records.size > 0 && job.mode !== "remove"
      ? [ui.button(w.remove, ui.route("demo-remove"), { tone: "critical", confirm: { title: w.removeTitle, text: w.removeText, confirmLabel: w.remove, destructive: true } })]
      : []),
  ];
  nodes.push(ui.stack(actions));
  const wiring = [...records.values()]
    .filter((record) => record.data.kind === "collection" || (record.data.kind === "media" && record.data.key.startsWith("banner-")) || (record.data.kind === "category" && record.data.depth === 0))
    .sort((a, b) => a.data.kind.localeCompare(b.data.kind) || a.id.localeCompare(b.id));
  if (wiring.length > 0) {
    nodes.push(ui.card(w.finish, [
      ui.text(w.finishText),
      ui.table({
        columns: [{ key: "name", label: w.name }, { key: "id", label: w.id }],
        rows: wiring.map((record) => ({ id: record.id, cells: { name: record.id, id: record.data.resource_id } })),
      }),
    ]));
  }
  return ui.page(nodes, { title: w.title });
}
