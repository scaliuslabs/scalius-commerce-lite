const mappings = ["size", "color", "material", "pattern", "none"];

export const DEMO_STORE_CONTRACT = Object.freeze({
  storeName: "Scalius Market",
  categories: 5,
  products: 50,
  productsPerCategory: 10,
  skus: 177,
  optionedProducts: 46,
  simpleProducts: 4,
  collections: 5,
  offers: 18,
  productsWithTwoOrMoreSections: 19,
  additionalSections: 49,
});

export const STOCK_PROFILES = Object.freeze({
  steady: [18, 16, 14, 12, 10, 8],
  deep: [30, 25, 20, 18, 16, 12],
  scarce: [8, 6, 4, 3, 2, 0],
  simple: [24],
});

function option(name, mapping, values) {
  if (!mappings.includes(mapping)) throw new Error(`Unsupported mapping ${mapping}`);
  return { name, mapping, values };
}

function section(title, html) {
  return { title, html };
}

const sectionsBySlug = {
  "rider-court-trainers": [
    section("Fit & sizing", "<p>Regular fit. Choose your usual EU size, or compare a measured heel-to-toe length before ordering.</p>"),
    section("Materials & care", "<p>Spot clean the layered upper and rubber outsole with a soft damp cloth, then air-dry away from direct heat.</p>"),
    section("Delivery & returns", "<p>Try on indoors and keep the original box. Returns follow the store's configured unworn-item policy.</p>"),
  ],
  "vale-everyday-runners": [
    section("Ride & use", "<p>Designed for daily walking and easy training. This is a comfortable everyday runner, not a technical race shoe.</p>"),
    section("Fit guide", "<p>Allow comfortable toe room with the socks you normally wear and compare both feet against the size guide.</p>"),
  ],
  "monsoon-trail-sandals": [
    section("Adjusting the straps", "<p>Set the heel strap first, then secure the forefoot and instep straps without restricting circulation.</p>"),
    section("After wet wear", "<p>Rinse away grit, wipe the footbed, and air-dry fully. Do not place the sandals against direct heat.</p>"),
  ],
  "ridge-chelsea-boots": [
    section("Fit & socks", "<p>The rounded toe accommodates everyday medium-weight socks. Measure the larger foot before choosing a size.</p>"),
    section("Weather care", "<p>Brush off dry soil, wipe clean, air-dry, and condition when needed. The boot is not sold as waterproof.</p>"),
  ],
  "halo-arc-table-lamp": [
    section("Light & setup", "<p>Choose the saved plug option before checkout and use the photographed socket type with a warm indoor bulb.</p>"),
    section("Dimensions & placement", "<p>Check the compact footprint, cord route, and indoor clearance before placing the lamp on a desk or bedside table.</p>"),
    section("Care & safety", "<p>Unplug before care, let the lamp cool, and clean with a dry cloth. Keep the fitting away from moisture.</p>"),
  ],
  "soma-handloom-cushion-cover": [
    section("What is included", "<p>One cushion cover is included. The cushion insert is not included.</p>"),
    section("Textile care", "<p>Wash cold on a gentle cycle, reshape, and shade-dry. Small weave variations are natural to the textile.</p>"),
  ],
  "kori-oak-floating-shelf": [
    section("Installation", "<p>Choose fixings for the wall type and use two people to position the 90 cm shelf safely.</p>"),
    section("Load & materials", "<p>Use for evenly distributed decorative loads. Wall construction and fixings determine the final safe load.</p>"),
    section("In the box", "<p>Includes the shelf, concealed mounting rail, standard fixings, and installation guide.</p>"),
  ],
  "arka-round-wall-mirror": [
    section("Measure before ordering", "<p>Confirm the finished diameter, surrounding wall clearance, and the path into the intended room.</p>"),
    section("Hanging", "<p>Use two people and anchors appropriate for the wall construction. Do not rely on unsuitable general-purpose fixings.</p>"),
    section("Care", "<p>Clean glass with a lint-free cloth and wipe the powder-coated frame with a soft dry cloth.</p>"),
  ],
  "transit-daypack-18l": [
    section("Organization", "<p>A padded laptop sleeve, quick-access top pocket, and close-set bottle pockets separate daily essentials.</p>"),
    section("Fit & carry", "<p>Set shoulder straps evenly and adjust the sternum strap so the pack sits close without restricting movement.</p>"),
    section("Fabric care", "<p>Spot clean with mild soap, rinse the area with a damp cloth, and air-dry completely before storage.</p>"),
  ],
  "tidal-rolltop-backpack": [
    section("Weather resistance", "<p>Coated fabric helps through brief rain, but the bag is not intended for submersion and is not sold as waterproof.</p>"),
    section("Capacity guide", "<p>The 20L shape suits a day load; 28L adds room for a compact short-trip packing list.</p>"),
    section("Laptop access", "<p>Measure the device, use the side access carefully, and keep hard objects away from the screen.</p>"),
  ],
  "metro-tech-sleeve": [
    section("Device fit", "<p>Measure the complete device width, depth, and thickness instead of relying on screen diagonal alone.</p>"),
    section("Care", "<p>Spot clean, keep the zip track clear, and let the sleeve dry completely before storing a device.</p>"),
  ],
  "kansa-serve-bowl": [
    section("Size guide", "<p>Choose the diameter for the intended use: snacks and sides, shared dishes, or larger salads and rice.</p>"),
    section("Care", "<p>Hand wash, dry promptly, and expect a natural patina to develop on the warm-toned metal.</p>"),
  ],
  "nori-chef-knife-8-inch": [
    section("Steel & edge care", "<p>Hone regularly, sharpen when needed, hand wash, and dry immediately after every use.</p>"),
    section("Safe handling", "<p>Use a stable board, a controlled claw grip, and a dedicated storage position away from loose utensils.</p>"),
    section("In the box", "<p>Includes the chef's knife and a reusable blade guard for protected storage.</p>"),
  ],
  "ember-pour-over-kettle-1l": [
    section("Pour control", "<p>Respect the fill line, keep a balanced grip, and use a low steady flow for controlled brewing.</p>"),
    section("Use & care", "<p>Use only on a verified compatible heat source, descale as needed, and store completely dry.</p>"),
  ],
  "shada-stoneware-dinner-set": [
    section("What is included", "<p>The four- and six-person choices have distinct piece counts that will be confirmed against the final pack.</p>"),
    section("Glaze character", "<p>Small glaze and rim variations are part of the handcrafted character; cracks and chips are damage.</p>"),
    section("Care", "<p>Dishwasher and microwave guidance remains pending until it is verified against the final sourced set.</p>"),
  ],
  "orbit-gan-charger-65w": [
    section("Port output guide", "<p>Single- and multi-port power allocation will be stated from the verified final charger specification.</p>"),
    section("Compatibility", "<p>Use USB Power Delivery devices and appropriately rated cables; universal fast charging is not promised.</p>"),
    section("Safety", "<p>Keep ventilation clear and stop using damaged plugs or cables. No unverified certification claim is made.</p>"),
  ],
  "quietkey-wireless-keyboard": [
    section("Layout & pairing", "<p>Review the visible US or UK key legends, then follow the three-device switching guide after pairing.</p>"),
    section("Battery & charging", "<p>Runtime and charging details remain pending until verified against the final sourced keyboard.</p>"),
    section("Care", "<p>Disconnect power, remove loose dust gently, and wipe keycaps and surfaces with a barely damp cloth.</p>"),
  ],
  "vault-10k-power-bank": [
    section("Charging guide", "<p>Use the labelled input/output ports and included cable as documented with the final product.</p>"),
    section("Travel & storage", "<p>Check current airline rules, protect the terminals, and keep the battery away from excessive heat.</p>"),
  ],
  "dock-7-in-1-usb-c-hub": [
    section("Ports & displays", "<p>The final listing will state the exact seven ports and verified maximum display output.</p>"),
    section("Compatibility", "<p>The host computer must support the required USB-C data, display, and charging modes.</p>"),
    section("Power pass-through", "<p>A compatible charger and cable are sold separately unless the final pack explicitly includes them.</p>"),
  ],
};

const categoryDefinitions = [
  {
    name: "Footwear", slug: "footwear", brand: "Northline",
    description: "Comfort-first trainers, sandals, flats, and boots selected for Bangladesh's working week and warm-weather weekends. Clear fit choices, durable soles, and practical materials make every pair easy to choose and live in.",
  },
  {
    name: "Home & Living", slug: "home-living", brand: "Loom & Light",
    description: "Thoughtful lighting, décor, and textiles that make compact homes feel warmer, calmer, and more useful. Each object balances tactile materials with proportions suited to apartments and everyday rooms.",
  },
  {
    name: "Bags & Carry", slug: "bags-carry", brand: "Fieldwork",
    description: "Clean, organized carry for commutes, errands, and short trips. Quiet branding, repairable hardware, useful pockets, and practical sizes keep daily essentials organized without unnecessary bulk.",
  },
  {
    name: "Kitchen & Table", slug: "kitchen-table", brand: "Common Table",
    description: "Reliable cookware, prep tools, storage, and tableware chosen for daily meals rather than display-only kitchens. Materials, set contents, and care guidance are stated clearly so buyers know exactly what arrives.",
  },
  {
    name: "Desk & Mobile Tech", slug: "desk-mobile-tech", brand: "Orbit Works",
    description: "Compact power, input, audio, and desk accessories for hybrid work and travel. Compatibility, port behavior, power limits, and included cables are described plainly instead of hidden behind generic tech claims.",
  },
];

const O = option;
const productDefinitions = [
  ["footwear", "Rider Court Trainers", "rider-court-trainers", 8990, [O("Size", "size", ["40", "41", "42"]), O("Color", "color", ["Sand", "Onyx"])], ["P", "V:Sand", "D", "L"], "retained", null, false, "A retro-inspired everyday trainer built for all-day comfort. Layered suede-look panels, a cushioned footbed, and a grippy rubber outsole balance clean street style with dependable wear from the commute to the weekend.", { productId: "prod_9XNNERD2XpAOIoI1SN6gx", exactCombinations: [["40", "Sand"]] }],
  ["footwear", "Vale Everyday Runners", "vale-everyday-runners", 6490, [O("Size", "size", ["39", "41", "43"]), O("Color", "color", ["Chalk", "Slate"])], ["P", "V:Chalk", "V:Slate", "D"], "steady", { scope: "sku", combination: ["43", "Slate"], type: "percentage", value: 10 }, false, "A light daily runner for walking, commuting, and easy training. Breathable engineered mesh, a softly structured heel, and a flexible foam midsole keep the ride comfortable without a bulky profile.", { axis: "Color", exactValues: ["Chalk", "Slate"] }],
  ["footwear", "Monsoon Trail Sandals", "monsoon-trail-sandals", 4290, [O("Size", "size", ["40", "42", "44"]), O("Strap", "color", ["Olive", "Black"])], ["P", "V:Olive", "V:Black", "L"], "deep", null, false, "An open trail sandal tuned for warm, wet days. Three adjustable straps hold the foot securely, while the textured footbed and channelled rubber sole dry quickly after sudden rain.", { axis: "Strap", exactValues: ["Olive", "Black"] }],
  ["footwear", "Nila City Loafers", "nila-city-loafers", 7290, [O("Size", "size", ["38", "40", "42"]), O("Finish", "color", ["Cocoa", "Black"])], ["P", "V:Cocoa", "V:Black", "D"], "steady", { scope: "product", type: "fixed", value: 500 }, true, "A softly structured loafer that moves from office trousers to weekend denim. The clean apron seam, padded heel, and flexible low-profile sole give a polished shape without the stiffness of formal footwear.", { axis: "Finish", exactValues: ["Cocoa", "Black"] }],
  ["footwear", "Padma Knit Slip-Ons", "padma-knit-slip-ons", 4990, [O("Size", "size", ["39", "41", "43"]), O("Color", "color", ["Mist", "Navy"])], ["P", "V:Mist", "V:Navy", "D"], "scarce", null, false, "A breathable knit slip-on for errands, travel, and long standing days. The stretch collar is easy to step into, while the removable cushioned insole and flexible sole keep the pair light on foot.", { axis: "Color", exactValues: ["Mist", "Navy"] }],
  ["footwear", "Dune Leather Slides", "dune-leather-slides", 3490, [O("Size", "size", ["40", "42", "44"])], ["P", "D", "L"], "deep", { scope: "product", type: "percentage", value: 8 }, false, "A simple two-strap slide cut from smooth leather over a contoured footbed. Broad straps distribute pressure evenly, and the rubber base adds everyday grip indoors and out.", null],
  ["footwear", "Metro Low-Top Sneakers", "metro-low-top-sneakers", 7990, [O("Size", "size", ["40", "42", "44"]), O("Color", "color", ["White", "Graphite"])], ["P", "V:White", "V:Graphite", "D"], "steady", null, true, "A clean low-top sneaker with a durable cupsole, padded collar, and easy-to-maintain upper. Its restrained paneling works across casual uniforms without looking like performance footwear.", { axis: "Color", exactValues: ["White", "Graphite"] }],
  ["footwear", "Rove Packable Flats", "rove-packable-flats", 3990, [O("Size", "size", ["36", "38", "40"]), O("Color", "color", ["Rose", "Black"])], ["P", "V:Rose", "V:Black", "L"], "deep", { scope: "product", type: "percentage", value: 10 }, false, "A flexible ballet flat that folds into the included travel pouch without losing its shape. A cushioned heel pad and non-slip outsole make it a useful office, event, or cabin-bag backup.", { axis: "Color", exactValues: ["Rose"] }],
  ["footwear", "Ridge Chelsea Boots", "ridge-chelsea-boots", 10990, [O("Size", "size", ["40", "42", "44"]), O("Finish", "color", ["Tan", "Black"])], ["P", "V:Tan", "V:Black", "D", "L"], "scarce", null, true, "A weather-ready ankle boot with elastic side panels, a rear pull tab, and a lugged rubber outsole. The supportive footbed and rounded toe leave room for everyday socks while keeping a sharp profile.", { axis: "Finish", exactValues: ["Tan", "Black"] }],
  ["footwear", "Aster Studio Clogs", "aster-studio-clogs", 4590, [O("Size", "size", ["37", "39", "41"]), O("Color", "color", ["Cream", "Sage"])], ["P", "V:Cream", "V:Sage", "D"], "steady", { scope: "sku", combination: ["41", "Sage"], type: "fixed", value: 400 }, false, "A roomy closed-toe clog for studio work, kitchens, and slow weekends. The washable upper, supportive molded footbed, and grippy sole are designed for easy, low-fuss wear.", { axis: "Color", exactValues: ["Cream", "Sage"] }],

  ["home-living", "Halo Arc Table Lamp", "halo-arc-table-lamp", 2490, [O("Finish", "none", ["Matte", "Gloss"]), O("Plug", "none", ["EU", "US"])], ["P", "VID", "POSTER", "D"], "retained", { scope: "sku", combination: ["Matte", "EU"], type: "percentage", value: 10 }, false, "A softly diffused table lamp for focused work and relaxed evenings. The compact arched silhouette fits neatly on desks, bedside tables, and shelves, while the available plug-and-finish combinations keep ordering clear.", { productId: "prod_FOHvuxr0Hr11AA_hyLUpH", omit: [["Gloss", "US"]], exactCombinations: [["Matte", "EU"]] }],
  ["home-living", "Mira Pleated Bedside Lamp", "mira-pleated-bedside-lamp", 3290, [O("Shade", "color", ["Oat", "Ink"]), O("Plug", "none", ["EU", "US"])], ["P", "V:Oat", "V:Ink", "D"], "steady", null, false, "A warm bedside lamp with a finely pleated fabric shade and compact ceramic base. It casts a gentle pool of light for reading and winding down without overpowering a small nightstand.", { axis: "Shade", exactValues: ["Oat", "Ink"] }],
  ["home-living", "Soma Handloom Cushion Cover", "soma-handloom-cushion-cover", 1290, [O("Size", "size", ["45 cm", "50 cm"]), O("Weave", "pattern", ["Indigo", "Clay"])], ["P", "V:Indigo", "V:Clay", "D"], "deep", { scope: "sku", combination: ["45 cm", "Indigo"], type: "percentage", value: 10 }, false, "A tactile handloom cushion cover with a quiet geometric weave and concealed zip. The cotton-rich face adds texture to a sofa or bed, while the plain reverse keeps the piece easy to layer.", { axis: "Weave", exactValues: ["Indigo", "Clay"] }],
  ["home-living", "Noor Ceramic Vase", "noor-ceramic-vase", 2190, [], ["P", "D", "D", "L"], "simple", null, false, "A sculptural stoneware vase with a matte, softly speckled surface. Its narrow mouth supports a few stems neatly, and the balanced shape looks intentional even when left empty.", null],
  ["home-living", "Jute Nest Storage Basket", "jute-nest-storage-basket", 1790, [O("Size", "size", ["Small", "Medium", "Large"])], ["P", "D", "L"], "deep", { scope: "product", type: "fixed", value: 250 }, false, "A sturdy hand-braided jute basket for throws, toys, laundry, or entryway clutter. Integrated handles make it easy to move, and the three graduated sizes nest together when not in use.", null],
  ["home-living", "Luma Ribbed Glass Lantern", "luma-ribbed-glass-lantern", 2690, [O("Glass", "color", ["Clear", "Amber"])], ["P", "V:Clear", "V:Amber", "L"], "steady", null, false, "A ribbed glass lantern that turns a small candle into softly patterned light. The heat-safe inner cup lifts out for cleaning, while the metal handle makes the lantern easy to reposition once cool.", { axis: "Glass", exactValues: ["Clear", "Amber"] }],
  ["home-living", "Kori Oak Floating Shelf", "kori-oak-floating-shelf", 3990, [O("Length", "size", ["60 cm", "90 cm"]), O("Finish", "color", ["Natural", "Walnut"])], ["P", "V:Natural", "V:Walnut", "D", "L"], "steady", null, true, "A solid-wood floating shelf with a slim front edge and hidden mounting rail. It gives books, frames, and everyday objects a clean landing place without visible brackets.", { axis: "Finish", exactValues: ["Natural", "Walnut"] }],
  ["home-living", "Dhara Cotton Throw", "dhara-cotton-throw", 2890, [O("Color", "color", ["Sand", "Indigo", "Forest"])], ["P", "V:Sand", "V:Indigo", "V:Forest", "D"], "deep", { scope: "product", type: "percentage", value: 8 }, false, "A medium-weight cotton throw with a softly washed hand and fringed edge. It is breathable enough for an air-conditioned room yet substantial enough to add color and warmth at the end of a bed.", { axis: "Color", exactValues: ["Sand", "Indigo", "Forest"] }],
  ["home-living", "Arka Round Wall Mirror", "arka-round-wall-mirror", 7490, [O("Diameter", "size", ["60 cm", "80 cm"]), O("Frame", "color", ["Brass", "Black"])], ["P", "V:Brass", "V:Black", "D", "L"], "scarce", null, true, "A generous round mirror framed in slim metal for a light, architectural look. The deep lip adds definition without visual bulk, making it well suited to hallways, bedrooms, and compact vanities.", { axis: "Frame", exactValues: ["Brass"] }],
  ["home-living", "Terra Scented Candle Trio", "terra-scented-candle-trio", 1690, [O("Scent", "none", ["Cedar", "Citrus", "Linen"])], ["P", "V:Cedar", "V:Citrus", "V:Linen", "L"], "steady", null, false, "Three small soy-wax candles are blended for distinct moods: dry cedar, bright citrus, and clean linen. Each reusable glass cup has a cotton wick and a restrained scent throw for smaller rooms.", { axis: "Scent", exactValues: ["Cedar", "Citrus", "Linen"] }],

  ["bags-carry", "Transit Daypack 18L", "transit-daypack-18l", 5990, [O("Color", "color", ["Moss", "Black", "Stone", "Ochre"])], ["P", "V:Moss", "V:Black", "V:Stone", "V:Ochre", "D"], "deep", { scope: "sku", combination: ["Moss"], type: "percentage", value: 10 }, true, "A compact commuter pack with a padded laptop sleeve, quick-access top pocket, and two bottle pockets that stay close to the bag. The structured back panel carries comfortably without turning an everyday load into a hiking pack.", { axis: "Color", exactValues: ["Moss", "Black", "Stone", "Ochre"] }],
  ["bags-carry", "Orin Commuter Tote", "orin-commuter-tote", 4490, [O("Canvas", "color", ["Natural", "Ink"]), O("Strap", "none", ["Short", "Long"])], ["P", "V:Natural", "V:Ink", "D"], "steady", null, false, "A zip-top canvas tote with enough structure for a laptop, notebook, bottle, and daily extras. Choose short handles for hand carry or the longer strap for an easier shoulder drop.", { axis: "Canvas", exactValues: ["Natural", "Ink"] }],
  ["bags-carry", "Tidal Rolltop Backpack", "tidal-rolltop-backpack", 7990, [O("Capacity", "size", ["20L", "28L"]), O("Color", "color", ["Navy", "Black"])], ["P", "V:Navy", "V:Black", "D", "L"], "scarce", null, true, "A rolltop pack for wet commutes and flexible weekend loads. Coated fabric, sealed high-wear seams, and a side laptop access zip protect essentials while the expandable top adds spare room.", { axis: "Color", exactValues: ["Navy", "Black"] }],
  ["bags-carry", "Mini Crescent Crossbody", "mini-crescent-crossbody", 2790, [O("Color", "color", ["Cocoa", "Black", "Sage", "Rose"])], ["P", "V:Cocoa", "V:Black", "V:Sage", "V:Rose", "D"], "deep", { scope: "product", type: "percentage", value: 8 }, false, "A compact crescent bag that follows the body without feeling rigid. The wide adjustable strap, smooth two-way zip, and divided interior keep phone, wallet, keys, and small extras in easy reach.", { axis: "Color", exactValues: ["Cocoa", "Black", "Sage", "Rose"] }],
  ["bags-carry", "Field Canvas Messenger", "field-canvas-messenger", 4990, [O("Color", "color", ["Khaki", "Olive", "Black"])], ["P", "V:Khaki", "V:Olive", "V:Black", "D"], "steady", null, false, "A durable cotton-canvas messenger with a padded device divider and two organization pockets under the flap. Metal hardware and a replaceable webbing strap are chosen for long everyday use.", { axis: "Color", exactValues: ["Khaki", "Olive", "Black"] }],
  ["bags-carry", "Metro Tech Sleeve", "metro-tech-sleeve", 2190, [O("Device", "size", ["13-inch", "15-inch"]), O("Color", "color", ["Graphite", "Sand"])], ["P", "V:Graphite", "V:Sand", "D"], "steady", null, false, "A lightly padded laptop sleeve with a soft lining and external pocket for a charger, cable, and slim notebook. The water-resistant outer fabric protects against daily scuffs and brief rain.", { axis: "Color", exactValues: ["Graphite", "Sand"] }],
  ["bags-carry", "Weekender Duffel 35L", "weekender-duffel-35l", 6490, [O("Color", "color", ["Olive", "Navy", "Black"])], ["P", "V:Olive", "V:Navy", "V:Black", "L"], "scarce", null, true, "A cabin-friendly duffel with a wide opening, separate shoe pocket, and removable shoulder strap. Its 35-litre shape packs for a short trip without becoming awkward on buses or overhead racks.", { axis: "Color", exactValues: ["Olive", "Navy", "Black"] }],
  ["bags-carry", "Trail Belt Bag", "trail-belt-bag", 2390, [O("Color", "color", ["Rust", "Olive", "Black", "Stone"])], ["P", "V:Rust", "V:Olive", "V:Black", "V:Stone", "L"], "deep", null, false, "A low-profile belt bag with two zipped compartments and a breathable back panel. Wear it at the waist or across the chest for hands-free errands, travel days, and short walks.", { axis: "Color", exactValues: ["Rust", "Olive"] }],
  ["bags-carry", "Fold Market Tote Set", "fold-market-tote-set", 1190, [], ["P", "D", "D", "L"], "simple", { scope: "product", type: "percentage", value: 12 }, false, "Three lightweight reusable totes fold into their own attached pockets. Reinforced handles and broad gussets make them useful for groceries, books, or an unexpected extra carry.", null],
  ["bags-carry", "Passport Travel Wallet", "passport-travel-wallet", 2590, [O("Color", "color", ["Tan", "Forest", "Black"])], ["P", "V:Tan", "V:Forest", "V:Black", "D"], "steady", null, false, "A slim travel wallet has space for two passports, boarding cards, currency, and six cards. The full zip keeps documents together while a concealed pocket separates emergency cash.", { axis: "Color", exactValues: ["Tan", "Forest", "Black"] }],

  ["kitchen-table", "Kansa Serve Bowl", "kansa-serve-bowl", 2990, [O("Diameter", "size", ["18 cm", "24 cm", "30 cm"])], ["P", "D", "D", "L"], "steady", null, false, "A warm-toned metal serving bowl with a gently hammered exterior and smooth food-contact surface. The graduated sizes move easily from snacks and sides to salads and shared rice dishes.", null],
  ["kitchen-table", "Nori Chef Knife 8-inch", "nori-chef-knife-8-inch", 4790, [], ["P", "D", "D", "L", "VID", "POSTER"], "simple", null, true, "A balanced 8-inch chef's knife for slicing, chopping, and everyday prep. The full-tang handle offers a secure grip, while the fine plain edge is straightforward to hone and sharpen at home.", null],
  ["kitchen-table", "Bela Acacia Chopping Board", "bela-acacia-chopping-board", 2290, [O("Size", "size", ["Small", "Medium", "Large"])], ["P", "D", "D", "L"], "deep", null, false, "A reversible acacia board has a juice groove on one side and a clean flat surface on the other. Rounded edges and an integrated handhold make the solid board easier to lift and store.", null],
  ["kitchen-table", "Ripple Double-Wall Tumbler Pair", "ripple-double-wall-tumbler-pair", 1890, [O("Tint", "color", ["Clear", "Smoke", "Amber"])], ["P", "V:Clear", "V:Smoke", "V:Amber", "D"], "steady", { scope: "product", type: "fixed", value: 200 }, false, "Two ribbed double-wall glasses keep hot or cold drinks comfortable to hold. The lightweight shape stacks neatly in the hand, and tinted options add quiet color without printed motifs.", { axis: "Tint", exactValues: ["Clear", "Smoke", "Amber"] }],
  ["kitchen-table", "Ember Pour-Over Kettle 1L", "ember-pour-over-kettle-1l", 5490, [O("Finish", "color", ["Steel", "Black"])], ["P", "V:Steel", "V:Black", "D"], "scarce", null, true, "A stainless-steel gooseneck kettle is shaped for a controlled, even pour. The balanced handle, clear fill marks, and one-litre capacity work well for pour-over coffee and precise tea preparation.", { axis: "Finish", exactValues: ["Steel", "Black"] }],
  ["kitchen-table", "Shada Stoneware Dinner Set", "shada-stoneware-dinner-set", 8990, [O("Setting", "size", ["4-person", "6-person"]), O("Glaze", "color", ["Cloud", "Ink"])], ["P", "V:Cloud", "V:Ink", "D", "L"], "scarce", { scope: "sku", combination: ["4-person", "Cloud"], type: "percentage", value: 8 }, true, "A coordinated stoneware set has softly irregular rims and a durable satin glaze. Choose the four- or six-person set in Cloud or Ink for an everyday table that still feels considered.", { axis: "Glaze", exactValues: ["Cloud", "Ink"] }],
  ["kitchen-table", "Press Glass Storage Set", "press-glass-storage-set", 2490, [O("Set", "size", ["3-piece", "5-piece", "8-piece"])], ["P", "D", "D", "L"], "deep", { scope: "product", type: "percentage", value: 10 }, false, "Stackable borosilicate glass containers use locking lids and replaceable silicone seals. Clear bases move from refrigerator to microwave and table without hiding what is inside.", null],
  ["kitchen-table", "Soma Cross-Back Linen Apron", "soma-cross-back-linen-apron", 2190, [O("Color", "color", ["Oat", "Clay", "Forest"])], ["P", "V:Oat", "V:Clay", "V:Forest", "D"], "steady", null, false, "A washed linen-blend apron has broad cross-back straps that distribute weight without a neck tie. Two deep front pockets hold a towel, phone, or small tools while cooking or making.", { axis: "Color", exactValues: ["Oat", "Clay", "Forest"] }],
  ["kitchen-table", "Dhaka Spice Tin", "dhaka-spice-tin", 3790, [O("Insert", "size", ["7-cup", "12-cup"])], ["P", "V:7-cup", "V:12-cup", "D"], "steady", null, false, "A stainless-steel spice box has removable inner cups, a fitted lid, and a small measuring spoon. Choose seven or twelve cups to keep frequently used spices visible and close at hand.", { axis: "Insert", exactValues: ["7-cup", "12-cup"] }],
  ["kitchen-table", "Loop Silicone Utensil Set", "loop-silicone-utensil-set", 1690, [O("Color", "color", ["Charcoal", "Sage", "Terracotta"])], ["P", "V:Charcoal", "V:Sage", "V:Terracotta", "D"], "deep", null, false, "A coordinated set of heat-resistant silicone tools has firm internal cores and comfortable handles. The pieces are gentle on coated cookware and stand together in the included draining cup.", { axis: "Color", exactValues: ["Charcoal", "Sage", "Terracotta"] }],

  ["desk-mobile-tech", "Orbit GaN Charger 65W", "orbit-gan-charger-65w", 4990, [O("Plug", "none", ["EU", "UK"]), O("Color", "color", ["White", "Black"])], ["P", "V:White", "V:Black", "D", "L"], "scarce", null, true, "A compact 65-watt wall charger has two USB-C ports and one USB-A port for a laptop, phone, and accessory. Power is shared across connected devices, and the selected fixed plug is shown before checkout.", { axis: "Color", exactValues: ["White", "Black"] }],
  ["desk-mobile-tech", "Loom Braided USB-C Cable", "loom-braided-usb-c-cable", 990, [O("Length", "size", ["1 m", "2 m"]), O("Color", "color", ["Stone", "Black"])], ["P", "V:Stone", "V:Black", "D"], "deep", { scope: "product", type: "percentage", value: 10 }, false, "A soft-touch braided USB-C to USB-C cable is intended for charging and everyday data transfer. Reinforced strain relief and two useful lengths make it easy to keep one at a desk and one in a bag.", { axis: "Color", exactValues: ["Stone", "Black"] }],
  ["desk-mobile-tech", "Frame Aluminum Laptop Stand", "frame-aluminum-laptop-stand", 3290, [O("Finish", "color", ["Silver", "Space Gray"])], ["P", "V:Silver", "V:Space Gray", "L"], "steady", null, false, "A ventilated aluminum stand raises a laptop screen and opens desk space beneath it. Silicone contact pads protect the device, while the folded profile slips into a work bag.", { axis: "Finish", exactValues: ["Silver", "Space Gray"] }],
  ["desk-mobile-tech", "QuietKey Wireless Keyboard", "quietkey-wireless-keyboard", 6990, [O("Layout", "none", ["US", "UK"]), O("Color", "color", ["Mist", "Graphite"])], ["P", "V:Mist", "V:Graphite", "D", "L"], "scarce", { scope: "sku", combination: ["UK", "Graphite"], type: "fixed", value: 500 }, true, "A low-profile wireless keyboard has quiet scissor switches, multi-device pairing, and a compact layout that retains a full function row. Choose the printed key layout and color explicitly before adding it to the cart.", { axis: "Color", exactValues: ["Mist", "Graphite"] }],
  ["desk-mobile-tech", "Pebble Silent Mouse", "pebble-silent-mouse", 2790, [O("Color", "color", ["Mist", "Graphite", "Sage"])], ["P", "V:Mist", "V:Graphite", "V:Sage", "D"], "deep", null, false, "A compact wireless mouse has quiet clicks, a smooth scroll wheel, and an ambidextrous shape. Bluetooth and the included receiver offer flexible pairing across a desk, laptop bag, or shared workspace.", { axis: "Color", exactValues: ["Mist", "Graphite", "Sage"] }],
  ["desk-mobile-tech", "Beam Magnetic Desk Light", "beam-magnetic-desk-light", 3990, [O("Finish", "color", ["White", "Black"])], ["P", "V:White", "V:Black", "L"], "steady", null, false, "A slim rechargeable light bar attaches to its weighted stand magnetically. Rotate the head for task or ambient light, then use the stepped touch control to adjust warmth and brightness.", { axis: "Finish", exactValues: ["White"] }],
  ["desk-mobile-tech", "Vault 10K Power Bank", "vault-10k-power-bank", 4490, [O("Color", "color", ["White", "Navy", "Black"])], ["P", "V:White", "V:Navy", "V:Black", "D"], "scarce", null, true, "A 10,000 mAh travel battery has USB-C input/output, one USB-A port, and a clear remaining-charge display. Flat edges pack neatly beside a phone without the bulk of a high-capacity brick.", { axis: "Color", exactValues: ["White", "Navy", "Black"] }],
  ["desk-mobile-tech", "Dock 7-in-1 USB-C Hub", "dock-7-in-1-usb-c-hub", 5990, [], ["P", "D", "D", "L", "VID", "POSTER"], "simple", { scope: "product", type: "percentage", value: 8 }, true, "A compact hub adds HDMI, two USB-A ports, USB-C power pass-through, SD, microSD, and gigabit Ethernet to a compatible USB-C computer. Port labels are visible and the attached cable folds into the body for travel.", null],
  ["desk-mobile-tech", "Halo Magnetic Phone Stand", "halo-magnetic-phone-stand", 2490, [O("Finish", "color", ["Silver", "Black"])], ["P", "V:Silver", "V:Black", "L"], "steady", null, false, "A weighted aluminum phone stand has a magnetic head, adjustable viewing angle, and cable pass-through. It keeps a compatible phone visible for calls and charging without crowding the desk.", { axis: "Finish", exactValues: ["Silver", "Black"] }],
  ["desk-mobile-tech", "Echo Mini Bluetooth Speaker", "echo-mini-bluetooth-speaker", 3790, [O("Color", "color", ["Sand", "Ocean", "Black"])], ["P", "V:Sand", "V:Ocean", "V:Black", "D"], "deep", null, false, "A palm-sized speaker has a fabric wrap, simple top controls, and a rubber base that stays put. It is tuned for clear speech and balanced casual listening in a bedroom, kitchen, or small group.", { axis: "Color", exactValues: ["Sand", "Ocean", "Black"] }],
];

function cartesian(options) {
  if (!options.length) return [[]];
  return options.reduce(
    (rows, axis) => rows.flatMap((row) => axis.values.map((value) => [...row, value])),
    [[]],
  );
}

function comboKey(values) {
  return values.map((value) => value.trim().toLowerCase()).join("\u001f");
}

function skuToken(value) {
  return value.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toUpperCase();
}

function expandMedia(productName, slug, slots) {
  const seen = new Map();
  return slots.map((slot) => {
    const count = (seen.get(slot) ?? 0) + 1;
    seen.set(slot, count);
    const suffix = count > 1 ? `-${count}` : "";
    const [role, value] = slot.split(":");
    const logicalRole = role === "P" ? "primary" : role === "V" ? `variant-${skuToken(value).toLowerCase()}` : role === "D" ? `detail${suffix}` : role === "L" ? `lifestyle${suffix}` : role === "VID" ? `video${suffix}` : `poster${suffix}`;
    const altText = role === "P"
      ? `${productName} shown in a clean full product view`
      : role === "V"
        ? `${productName} in ${value}, shown in the matching variant view`
        : role === "D"
          ? `${productName} construction detail ${count}`
          : role === "L"
            ? `${productName} shown in an everyday setting ${count}`
            : role === "VID"
              ? `${productName} product walkthrough video`
              : `${productName} product video poster`;
    return {
      logicalKey: `${slug}:${logicalRole}`,
      slot,
      role: logicalRole,
      kind: role === "VID" ? "video" : "image",
      variantValue: role === "V" ? value : null,
      altText,
      caption: role === "VID" ? `${productName} product walkthrough` : null,
      intendedCrop: ["P", "V", "POSTER"].includes(role) ? "contain" : "cover",
      source: { kind: "pending-original", status: "not-staged" },
    };
  });
}

function expandProduct(definition) {
  const [categorySlug, name, slug, price, options, mediaSlots, stockProfile, offer, freeDelivery, description, rules] = definition;
  const omitted = new Set((rules?.omit ?? []).map(comboKey));
  const combinations = cartesian(options).filter((values) => !omitted.has(comboKey(values)));
  const profile = stockProfile === "retained" ? null : STOCK_PROFILES[stockProfile];
  const variants = combinations.map((values, index) => ({
    logicalKey: `${slug}:${values.length ? values.map(skuToken).join("-") : "default"}`,
    sku: `${skuToken(slug)}-${values.length ? values.map(skuToken).join("-") : "DEFAULT"}`,
    optionValues: values,
    price,
    inventory: stockProfile === "retained" ? { mode: "preserve" } : { mode: "tracked", onHand: profile[index] },
  }));
  const additionalSections = (sectionsBySlug[slug] ?? []).map((item, sortOrder) => ({
    logicalKey: `${slug}:section:${skuToken(item.title).toLowerCase()}`,
    title: item.title,
    html: item.html,
    sortOrder,
  }));
  return {
    logicalKey: `product:${slug}`,
    retainedProductId: rules?.productId ?? null,
    categorySlug,
    name,
    slug,
    brand: categoryDefinitions.find((category) => category.slug === categorySlug)?.brand,
    price,
    currency: "BDT",
    condition: "new",
    descriptionHtml: `<p>${description}</p>`,
    seo: { title: `${name} | Scalius Market`, description },
    options,
    omittedCombinations: rules?.omit ?? [],
    variants,
    media: expandMedia(name, slug, mediaSlots),
    variantImageIntent: rules?.axis
      ? { mode: "axis", axis: rules.axis, exactValues: rules.exactValues }
      : rules?.exactCombinations
        ? { mode: "combinations", exactCombinations: rules.exactCombinations }
        : { mode: "fallback" },
    additionalSections,
    stockProfile,
    offer,
    freeDelivery,
  };
}

export const demoStoreManifest = Object.freeze({
  schemaVersion: 1,
  store: { name: "Scalius Market", locale: "en-BD", currency: "BDT" },
  categories: categoryDefinitions.map((category, sortOrder) => ({
    logicalKey: `category:${category.slug}`,
    ...category,
    status: "published",
    sortOrder,
    seo: { title: `${category.name} | Scalius Market`, description: category.description },
    media: [{
      logicalKey: `category:${category.slug}:image`,
      kind: "image",
      role: "category",
      altText: `${category.name} category collection at Scalius Market`,
      intendedCrop: "cover",
      source: { kind: "pending-original", status: "not-staged" },
    }],
  })),
  products: productDefinitions.map(expandProduct),
  collections: [
    { logicalKey: "collection:new-noteworthy", name: "New & Noteworthy", source: "manual", presentation: "carousel", limit: 12 },
    { logicalKey: "collection:everyday-carry", name: "Everyday Carry", source: "dynamic", presentation: "grid", limit: 8 },
    { logicalKey: "collection:home-refresh", name: "Home Refresh", source: "dynamic", presentation: "grid", limit: 8 },
    { logicalKey: "collection:weekend-ready", name: "Weekend Ready", source: "manual", presentation: "carousel", limit: 8 },
    { logicalKey: "collection:offers-worth-opening", name: "Offers Worth Opening", source: "manual", presentation: "grid", limit: 12 },
  ],
  heroes: [
    { logicalKey: "hero:everyday-edit", title: "The Everyday Edit", copy: "Useful things, considered well.", destination: "collection:new-noteworthy" },
    { logicalKey: "hero:softer-home", title: "A softer home", copy: "Light, texture, and room to breathe.", destination: "category:home-living" },
    { logicalKey: "hero:carry-day", title: "Carry the day", copy: "Commute-ready bags without the bulk.", destination: "category:bags-carry" },
  ].map((hero) => ({
    ...hero,
    media: [
      { logicalKey: `${hero.logicalKey}:desktop`, width: 2400, height: 900, altText: `${hero.title} desktop campaign image`, intendedCrop: "cover" },
      { logicalKey: `${hero.logicalKey}:mobile`, width: 1080, height: 1350, altText: `${hero.title} mobile campaign image`, intendedCrop: "cover" },
    ],
  })),
});

