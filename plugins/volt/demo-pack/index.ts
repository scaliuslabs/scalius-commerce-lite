// The Volt demo store: categories, brands, products (with options and
// specifications), collections and the home layout's media, as data. It is
// the demo content pack, kept apart from the theme code: the storefront
// module never imports it, and only the demo feature's importer reads it.
//
// Source: applegadgetsbd.com (product names, prices and photo URLs as read
// on 2026-10-20). Copying them is approved for the hidden, noindexed demo
// only (owner decision Oct 19); a public release swaps this pack for
// licensed content. Prices are in the store currency's major units (BDT).

export interface DemoCategory {
  key: string;
  name: string;
  parent?: string;
  image?: string;
}

export interface DemoBrand {
  key: string;
  name: string;
}

export interface DemoOption {
  name: string;
  mapping: "size" | "color" | "material" | "pattern" | "none";
  values: string[];
}

export interface DemoProduct {
  key: string;
  name: string;
  category: string;
  brand?: string;
  /** The price buyers pay. */
  price: number;
  /** The regular price, when the product is discounted. */
  was?: number;
  images: string[];
  code?: string;
  features?: string[];
  specs?: Array<{ group: string; rows: Array<{ label: string; value: string }> }>;
  /** Up to two axes; every combination becomes a SKU at the product's price. */
  options?: DemoOption[];
  stock?: number;
}

export interface DemoCollection {
  key: string;
  name: string;
  products: string[];
}

export interface DemoBanner {
  key: string;
  url: string;
  alt: string;
  link: string;
}

export interface DemoPack {
  version: number;
  categories: DemoCategory[];
  brands: DemoBrand[];
  products: DemoProduct[];
  collections: DemoCollection[];
  /** Hero slides and side banners: imported into Files for the home hero. */
  banners: DemoBanner[];
}

const M = "https://adminapi.applegadgetsbd.com/storage/media/";

const category = (key: string, name: string, parent?: string, image?: string): DemoCategory =>
  ({ key, name, ...(parent ? { parent } : {}), ...(image ? { image: M + image } : {}) });

const categories: DemoCategory[] = [
  category("apple", "Apple Products"),
  category("iphone", "iPhone", "apple", "thumb/iPhone-18-Pro-Max-1213.png"),
  category("ipad", "iPad", "apple", "thumb/iPad-Pro-M5-2025-whiter-9298.png"),
  category("macbook", "MacBook", "apple", "thumb/MacBook-Air-M4-13-Inchaaaa-2702.png"),
  category("airpods", "AirPods", "apple"),
  category("apple-watch", "Apple Watch", "apple"),
  category("phones", "Phones"),
  category("samsung-phones", "Samsung Phones", "phones"),
  category("xiaomi-phones", "Xiaomi Phones", "phones"),
  category("nothing-phones", "Nothing Phones", "phones"),
  category("oneplus-phones", "OnePlus Phones", "phones"),
  category("desktop", "Desktop"),
  category("gaming-pc", "Gaming PC", "desktop"),
  category("brand-pc", "Brand PC", "desktop"),
  category("components", "Computer Components", "desktop"),
  category("graphics-card", "Graphics Card", "components", "thumb/Graphics-Card-7294.png"),
  category("processor", "Computer Processor", "components", "thumb/Computer-Processor-7965.png"),
  category("motherboard", "Motherboard", "components", "thumb/Motherboard-4643.png"),
  category("power-supply", "Power Supply", "components", "thumb/Power-Supply-1803.png"),
  category("ram", "RAM", "components", "thumb/RAM-2888.png"),
  category("ssd", "SSD", "components", "thumb/SSD-6612.png"),
  category("casing", "Casing", "components"),
  category("monitor", "Monitor", "desktop", "thumb/Monitor-2663.png"),
  category("laptops", "Laptops", undefined, "thumb/Laptop-4138.png"),
  category("gaming-laptop", "Gaming Laptop", "laptops"),
  category("ultrabook", "Ultrabook", "laptops"),
  category("business-laptop", "Business Class", "laptops"),
  category("tablets", "Tablets & Accessories"),
  category("android-tab", "Android Tablet", "tablets"),
  category("smart-pen", "Smart Pen", "tablets"),
  category("hubs-docks", "Hubs & Docks", "tablets"),
  category("gadgets", "Gadgets & Accessories"),
  category("earbuds", "Earbuds", "gadgets"),
  category("headphone", "Headphone", "gadgets"),
  category("power-bank", "Power Bank", "gadgets"),
  category("chargers", "Chargers", "gadgets"),
  category("cables", "Cables", "gadgets"),
  category("appliances", "Appliances"),
  category("air-fryer", "Air Fryer", "appliances", "thumb/Philips-NA231-Air-Fryer---6.2Lfw-8017.jpg"),
  category("induction", "Induction Cooker", "appliances", "thumb/Philips-HD494400-Induction-Cooker-4533.png"),
  category("blender", "Mixer Grinder & Blender", "appliances"),
  category("television", "Television", "appliances"),
  category("air-conditioner", "Air Conditioner", "appliances"),
  category("refrigerator", "Refrigerator & Freezer", "appliances"),
  category("power-station", "Power Station", "appliances"),
  category("solar-panel", "Solar Panel", "appliances"),
  category("lifestyle", "Lifestyle"),
  category("smart-watch", "Smart Watch", "lifestyle", "thumb/Apple-Watch-Series-10-Aluminum-Silver-7765.jpg"),
  category("smart-band", "Smart Band", "lifestyle"),
  category("security", "Security & Networking"),
  category("router", "Wi-Fi Router", "security", "thumb/Wi-Fi-Router-3749.png"),
  category("hd-camera", "HD Camera", "security", "thumb/Dahua-HAC-T1A21P-2MP-HDCVI-IR-Eyeball-camerasdd-5795.png"),
];

const brands: DemoBrand[] = [
  "Apple", "Samsung", "Xiaomi", "Nothing", "OnePlus", "Realme", "Anker", "QCY", "JBL", "Philips", "Panasonic",
  "EcoFlow", "Bluetti", "TCL", "Midea", "Miyako", "Vision", "MSI", "Biostar", "Oscoo", "AITC", "1STPLAYER",
  "Value-Top", "Kieslect", "AMD", "Intel",
].map((name) => ({ key: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name }));

const product = (
  key: string, name: string, cat: string, brand: string | undefined, price: number, was: number | undefined, image: string,
  extra: Partial<DemoProduct> = {},
): DemoProduct => ({ key, name, category: cat, ...(brand ? { brand } : {}), price, ...(was ? { was } : {}), images: [M + image], ...extra });

const PHONE_SPECS = (display: string, chip: string, camera: string, battery: string) => [
  { group: "Display", rows: [{ label: "Size & Type", value: display }] },
  { group: "Platform", rows: [{ label: "Chipset", value: chip }] },
  { group: "Camera", rows: [{ label: "Main Camera", value: camera }] },
  { group: "Battery", rows: [{ label: "Capacity", value: battery }] },
  { group: "Warranty", rows: [{ label: "Warranty", value: "1 year official warranty" }] },
];

const products: DemoProduct[] = [
  // Volt Computers
  product("pc-5650ge", "AMD Ryzen 5 PRO 5650GE Budget Desktop PC", "brand-pc", "amd", 38999, 39400, "medium/AMD-Ryzen-5-PRO-5650GE-Budget-Desktop-PC-6570.png"),
  product("pc-5500-rx580", "AMD Ryzen 5 5500 with RX 580 Gaming PC", "gaming-pc", "amd", 62999, 63750, "medium/AMD-Ryzen-5-5500-with-Rx-850-Gaming-PC-9565.png"),
  product("pc-5600-rx580", "AMD Ryzen 5 5600 with RX 580 Gaming PC", "gaming-pc", "amd", 71999, 72100, "medium/AMD-Ryzen-5-5600-with-RX-580-Gaming-PC-7359.png"),
  product("pc-8400f-3050", "AMD Ryzen 5 8400F with RTX 3050 Gaming PC", "gaming-pc", "amd", 103999, 104400, "medium/AMD-Ryzen-5-8400F-with-RTX-3050-Gaming-PC-2175.png"),
  product("pc-8500g", "AMD Ryzen 5 8500G Desktop PC", "brand-pc", "amd", 56499, 56700, "medium/AMD-Ryzen-5-8500G-Desktop-PC-2981.png"),
  product("pc-i3-10100", "Intel 10th Gen Core i3 10100 Budget Desktop PC", "brand-pc", "intel", 35999, 36250, "medium/Intel-10th-Gen-Core-i3-10100-Budget-Desktop-PC-5163.png"),
  product("pc-i5-12400", "Intel 12th Gen Core i5-12400 Desktop PC", "brand-pc", "intel", 43999, 44450, "medium/Intel-12th-Gen-Core-i5-12400-Desktop-PC-3038.png"),
  product("pc-3400g", "AMD Ryzen 5 3400G Budget Desktop PC", "brand-pc", "amd", 28999, 31150, "medium/AMD-Ryzen-5-3400G-Budget-Desktop-PC-5996.png"),
  product("mb-a520m", "MSI A520M-A Pro AM4 AMD Micro-ATX Motherboard", "motherboard", "msi", 8000, 9500, "medium/MSI-A520M-A-Pro-AM4-AMD-Micro-ATX-Motherboard-5129.png"),
  product("ram-aitc-8", "AITC Kingsman Innovator DDR4 8GB 3200MHz Gaming Desktop Ram", "ram", "aitc", 9500, undefined, "medium/Web-Mokup-Recovered-1204.png"),
  product("ssd-m760", "BIOSTAR M760 256GB NVMe M.2 Gen3 SSD", "ssd", "biostar", 5999, undefined, "medium/Biostar-M760-256GB-M.2-Gen3-NVMe-SSD-2361.png"),
  product("ssd-on900", "Oscoo ON900 PCIe Gen3x4 NVMe SSD", "ssd", "oscoo", 4999, undefined, "medium/Oscoo-ON900-128GB-M.2-PCIe-Gen3x4-NVMe-SSD-2274.png"),
  product("case-mi2", "1STPLAYER Mi2 M-ATX Mid Tower Casing", "casing", "1stplayer", 3000, undefined, "medium/1STPLAYER-Mi2-M-ATX-Mid-Tower-Casing-3-6131.png"),
  product("case-v200", "Value-Top V200 Micro ATX Casing With PSU", "casing", "value-top", 2500, undefined, "medium/Value-Top-V200-Micro-ATX-Casing-With-PSU-6935.png"),
  // Apple Exclusive
  product("iphone-18-pro-max", "iPhone 18 Pro Max", "iphone", "apple", 186499, 191000, "medium/iPhone-18-Pro-Max-1213.png", {
    code: "VG18PM",
    options: [
      { name: "Color", mapping: "color", values: ["Cosmic Orange", "Deep Blue", "Silver"] },
      { name: "Storage", mapping: "none", values: ["256GB", "512GB"] },
    ],
    features: ["6.9-inch Super Retina XDR display with ProMotion", "A20 Pro chip", "48MP Fusion camera system", "All-day battery life"],
    specs: PHONE_SPECS("6.9-inch Super Retina XDR OLED, 120Hz", "Apple A20 Pro", "48MP + 48MP + 48MP", "Up to 33 hours video playback"),
  }),
  product("iphone-18-pro", "iPhone 18 Pro", "iphone", "apple", 176999, 186000, "medium/iPhone-18-Pro-glacier-3256.webp"),
  product("iphone-duo", "iPhone Duo", "iphone", "apple", 329999, undefined, "medium/iphone-duo-night-sky-1252.webp"),
  product("iphone-17-pro-max", "iPhone 17 Pro Max", "iphone", "apple", 153499, 159999, "medium/iPhone-17-Pro-Max-Silver-8139.jpg"),
  product("airpods-5", "Apple AirPods 5", "airpods", "apple", 19499, 22499, "medium/Apple-AirPods-5-2202.png"),
  product("airpods-pro-3", "AirPods Pro 3", "airpods", "apple", 25999, 28000, "medium/AirPods-Pro-3-8576.png"),
  product("watch-s12", "Apple Watch Series 12", "apple-watch", "apple", 57499, undefined, "medium/Apple-Watch-Series-12-light-gold-8118.png"),
  product("watch-ultra-4", "Apple Watch Ultra 4", "apple-watch", "apple", 100000, undefined, "medium/Apple-Watch-Ultra-4-9797.png"),
  product("ipad-11", "iPad 11th Gen - 2025", "ipad", "apple", 53999, 56999, "medium/iPad-10.9-10th-Gen---2022-Blue-2942.jpg"),
  product("macbook-neo", "MacBook Neo", "macbook", "apple", 84999, undefined, "medium/MacBook-Neo-(3)-5574.jpg"),
  // Phones
  product("galaxy-s26-ultra", "Galaxy S26 Ultra 5G", "samsung-phones", "samsung", 113999, 117000, "large/Galaxy-S26-Ultra-black-4396.png", {
    images: [M + "large/Galaxy-S26-Ultra-black-4396.png", M + "large/Galaxy-S26-Ultracobaltviolet-8743.png", M + "large/Galaxy-S26-Ultra-silvershadow-5304.png"],
    code: "VGL31896",
    options: [
      { name: "Color", mapping: "color", values: ["Black", "Cobalt Violet", "Silver Shadow"] },
      { name: "Storage", mapping: "none", values: ["12/256GB", "12/512GB", "16/1TB"] },
    ],
    features: ["6.9-inch Dynamic LTPO AMOLED 2X, 120Hz", "Snapdragon 8 Elite Gen 5", "200MP quad camera, 8K video", "5000 mAh, 60W wired charging"],
    specs: [
      { group: "Body", rows: [{ label: "Dimensions", value: "163.6 x 78.1 x 7.9 mm" }, { label: "Weight", value: "214 g" }, { label: "Build", value: "Gorilla Armor 2 front | Victus 2 back | aluminium frame" }] },
      { group: "Platform", rows: [{ label: "OS", value: "Android 16, One UI 8.5" }, { label: "Chipset", value: "Snapdragon 8 Elite Gen 5" }, { label: "GPU", value: "Adreno 840" }] },
      { group: "Display", rows: [{ label: "Type", value: "Dynamic LTPO AMOLED 2X, 120Hz, HDR10+, 2600 nits" }, { label: "Size", value: "6.9 inches" }, { label: "Resolution", value: "1440 x 3120 pixels" }] },
      { group: "Main Camera", rows: [{ label: "Quad", value: "200MP wide | 10MP telephoto | 50MP periscope | 50MP ultrawide" }, { label: "Video", value: "8K, 4K, 1080p" }] },
      { group: "Selfie Camera", rows: [{ label: "Single", value: "12MP, 4K video" }] },
      { group: "Battery", rows: [{ label: "Type", value: "5000 mAh" }, { label: "Charging", value: "60W wired | 25W wireless | 4.5W reverse wireless" }] },
      { group: "Connectivity", rows: [{ label: "Wireless", value: "Wi-Fi 7 | Bluetooth 6.0 | NFC | UWB" }] },
      { group: "Other", rows: [{ label: "Features", value: "IP68 | ultrasonic fingerprint | Samsung DeX | S Pen support" }] },
    ],
  }),
  product("galaxy-s25-ultra", "Galaxy S25 Ultra 5G", "samsung-phones", "samsung", 98999, 101000, "medium/Galaxy-S25-Ultra-5G-Titanium-Silver-Blue-1865.jpg"),
  product("nothing-4a", "Nothing Phone (4a)", "nothing-phones", "nothing", 46999, undefined, "medium/Nothing-Phone-(4a)as-9980.png"),
  product("redmi-note-15-pro-plus", "Redmi Note 15 Pro Plus 5G", "xiaomi-phones", "xiaomi", 40499, undefined, "medium/Redmi-Note-15-Pro-Plus-5Gas-2677.png"),
  // Home appliances
  product("philips-na231", "Philips NA231 Air Fryer - 6.2L", "air-fryer", "philips", 12500, 18500, "medium/Philips-NA231-Air-Fryer---6.2L-6524.png"),
  product("philips-na120", "PHILIPS NA120/00 Air Fryer 4.2L", "air-fryer", "philips", 7500, 12990, "medium/PHILIPS-NA12000-Air-Fryer-4.2L-6906.png"),
  product("miyako-af401", "Miyako AF-401-CG Inverter Air Fryer 4L", "air-fryer", "miyako", 5700, 6500, "medium/Miyako-AF-401-CG-Inverter-Air-Fryer-4L-7442.jpg"),
  product("tcl-65c6ks", "TCL 65C6KS 65\" Premium QD-Mini LED TV", "television", "tcl", 123999, 151990, "medium/TCL-65C6K-65-Inch-Premium-QD-Mini-LED-TV-6013.jpg"),
  product("philips-hl7757", "Philips HL7757 3 Jars Mixer Grinder - 750W", "blender", "philips", 6000, 10450, "medium/Philips-HL7757-3-Jars-Mixer-Grinder---750W-7177.png"),
  product("panasonic-ge3750", "Panasonic MX-GE3750 3 Jars Mixer Grinder - 1200W", "blender", "panasonic", 7700, 13000, "medium/Panasonic-MX-GE3750-3-Jars-Mixer-Grinder---1200W-8095.png"),
  product("ecoflow-river-2-max", "EcoFlow River 2 Max Portable Power Station", "power-station", "ecoflow", 42499, 45900, "medium/EcoFlow-River-2-Max-Portable-Power-Station-5919.png"),
  product("ecoflow-delta-3", "EcoFlow Delta 3 Portable Power Station", "power-station", "ecoflow", 71500, 77900, "medium/EcoFlow-Delta-3-Portable-Power-Station11-6526.png"),
  product("samsung-rt47", "Samsung RT47K6231UT/D3 Twin Cooling Refrigerator - 465L", "refrigerator", "samsung", 92000, 112900, "medium/Samsung-RT47K6231BSD3-465-L-Twin-Cooling-Refrigerator-7673.png"),
  product("vision-infrared", "Vision 751248 VSN-Flaming Infrared Cooker - 2000W", "induction", "vision", 4000, 4450, "medium/Vision-751248-VSN-Flaming-Infrared-Cooker---2000W-7917.png"),
  product("midea-18crn", "Midea MSI-18CRN Inverter Air Conditioner - 1.5 TON", "air-conditioner", "midea", 53999, undefined, "medium/Midea-MSI-18CRN-Inverter-Air-Conditioner---1.5-TON-9172.png"),
  product("bluetti-p30", "BLUETTI Premium 30 V2 600W Portable Power Station", "power-station", "bluetti", 29500, 31900, "medium/BLUETTI-Premium-30-V2-600W-Portable-Power-Stationas-3229.png"),
  product("ecoflow-solar-60", "EcoFlow 60W Portable Solar Panel", "solar-panel", "ecoflow", 9000, 9500, "medium/EcoFlow-60W-Portable-Solar-Panel-8883.png"),
  // Featured products
  product("buds4-pro", "Galaxy Buds4 Pro", "earbuds", "samsung", 18999, 19999, "medium/Galaxy-Buds4-Proaa-5621.png"),
  product("anker-r60i", "Anker Soundcore R60i NC TWS Earbuds", "earbuds", "anker", 2999, 3450, "medium/Anker-Soundcore-R60i-NC-TWS-Earbudssaa-9941.png"),
  product("anker-liberty-5", "Anker Soundcore Liberty 5 ANC TWS Earbuds", "earbuds", "anker", 7299, 8000, "medium/Anker-Soundcore-Liberty-5-ANC-TWS-Earbudsaa-9236.png"),
  product("qcy-n20-pro", "QCY MeloBuds N20 Pro Earbuds", "earbuds", "qcy", 2699, 2850, "medium/QCY-MeloBuds-N20-Pro-Earbuds-9271.png"),
  product("oneplus-buds-4", "OnePlus Buds 4 ANC TWS Earbuds", "earbuds", "oneplus", 7699, 9000, "medium/OnePlus-Buds-4-ANC-TWS-Earbuds-8805.png"),
  product("realme-t500-pro", "realme Buds T500 Pro ANC TWS Earbuds", "earbuds", "realme", 3599, 4100, "medium/realme-Buds-T500-Pro-ANC-TWS-Earbudsa-2232.png"),
  product("jbl-780nc", "JBL Tune 780NC Wireless Over Ear ANC Headphones", "headphone", "jbl", 7899, 8000, "medium/JBL-Tune-780NC-Wireless-Over-Ear-ANC-Headphones-01-5251.png"),
  product("kieslect-biokoop", "Kieslect Biokoop Fitness Tracker", "smart-band", "kieslect", 5250, undefined, "medium/Kieslect-Biokoop-Fitness-Tracker-2-8910.png"),
];

const collections: DemoCollection[] = [
  { key: "volt-computers", name: "Volt Computers", products: ["pc-5650ge", "pc-5500-rx580", "pc-5600-rx580", "pc-8400f-3050", "pc-8500g", "pc-i3-10100", "pc-i5-12400", "pc-3400g"] },
  { key: "apple-exclusive", name: "Apple Exclusive 2026", products: ["iphone-18-pro-max", "iphone-18-pro", "iphone-duo", "airpods-5", "watch-s12", "watch-ultra-4"] },
  {
    key: "exclusive-deals", name: "Exclusive Deals",
    products: ["ipad-11", "ram-aitc-8", "macbook-neo", "mb-a520m", "kieslect-biokoop", "case-mi2", "airpods-pro-3", "ssd-m760", "iphone-17-pro-max", "ssd-on900", "galaxy-s25-ultra", "case-v200", "jbl-780nc", "nothing-4a", "redmi-note-15-pro-plus"],
  },
  { key: "hot-deals", name: "Hot Deals", products: ["philips-na231", "philips-na120", "tcl-65c6ks", "miyako-af401", "philips-hl7757", "panasonic-ge3750", "ecoflow-river-2-max", "ecoflow-delta-3", "samsung-rt47", "vision-infrared"] },
];

const banners: DemoBanner[] = [
  { key: "slide-preorder", url: `${M}large/Pre-order-18-Pro-Series-(Ready-Stock)---Slider-5222.jpg`, alt: "Pre-order the 18 Pro series", link: "/categories/iphone" },
  { key: "slide-emi", url: `${M}large/City-&-EBL-0_-EMI---1t-3076.png`, alt: "Zero percent EMI on the iPhone 18 series", link: "/categories/iphone" },
  { key: "slide-ac", url: `${M}large/AC-Fest---Web-Slider_-5043.jpg`, alt: "AC fest", link: "/categories/air-conditioner" },
  { key: "slide-deals", url: `${M}large/All-Smart-deals---Web-Slider-1853.png`, alt: "All smart deals", link: "/categories/gadgets" },
  { key: "slide-s26", url: `${M}large/Samsung-s26-Ultra-top-slider1-4089.jpg`, alt: "Galaxy S26 Ultra", link: "/products/galaxy-s26-ultra" },
  { key: "slide-macmini", url: `${M}large/Mac-Mini-M6-&-Mac-Mini-M5-Pro---Top-Slider.jpg-6784.jpg`, alt: "Mac mini", link: "/categories/macbook" },
  { key: "slide-macbook-air", url: `${M}large/Macbook-Air-M5---Top-Slider1-3139.png`, alt: "MacBook Air", link: "/categories/macbook" },
  { key: "side-tab", url: `${M}large/Right-side-2668.png`, alt: "Tab carnival", link: "/categories/tablets" },
  { key: "side-computers", url: `${M}large/AG-Computer---Top-Right-6434.jpg`, alt: "Volt Computers", link: "/categories/desktop" },
];

export const VOLT_DEMO_PACK: DemoPack = { version: 1, categories, brands, products, collections, banners };
