# Volt Gadgets: research of the source store

Source: applegadgetsbd.com (Apple Gadgets, Bangladesh), read on 2026-10-20 with
WebFetch (markdown conversion of the server HTML). WebFetch does not see CSS,
so colours, spacing and pixel positions below are from the markup order plus
the brand's known look; they are marked "unverified" where that matters and
must be checked in a browser before the replica is called exact.

Volt copies the layout, navigation, category structure, cards, product page,
offers, footer and icon placement. Only the name ("Volt Gadgets"), the logo and
the site icons change. Copied photos and product text live only in
`demo-pack/` (owner decision Oct 19, hidden demo only).

## Header

Desktop, top to bottom:

1. **Main bar** (white): logo at the start; a wide search field with a
   "Search..." placeholder and a search button in the middle; then text links
   with icons: Blog, Pre-order, Offers, Compare; then the cart icon with a
   count bubble; then the account (Sign in).
2. **Category bar** (below the main bar, full width): the nine top-level
   categories in this order: Apple Products, Phones, Desktop, Laptops,
   Tablets & Accessories, Gadgets & Accessories, Appliances, Lifestyle,
   Security & Networking. Hovering one opens its dropdown of subcategory
   links (the owner reports image tiles in the mega menu; the server HTML
   shows only text links, so the image column is a Volt setting).

Phones: logo, search, cart in one bar, and a fixed bottom navigation with
Home, Category, Offer and Sign In.

Floating: a WhatsApp "Live chat" button at the bottom end.

### Category tree (mega menu)

| Top | Children |
| --- | --- |
| Apple Products | iPhone, iPad, MacBook, Mac mini, Apple Adapter, AirPods, EarPods, Apple Watch, AirTag, iMac, Mac Studio, AirPods Max |
| Phones | iPhone, Samsung, Google, Motorola, Xiaomi, Honor, OnePlus, iqoo, realme, Nothing, Huawei, Oppo, vivo, Nokia |
| Desktop | Desktop Offer, Gaming PC, Brand PC, All-in-One PC, Mini PC, Computer Components |
| Laptops | Acer, Asus, Dell, HP, Lenovo, MSI, Samsung, Qbits, Gaming Laptop, Ultrabook, Business Class |
| Tablets & Accessories | iPad, Xiaomi Pad, Samsung Tab, Amazon Tab, HONOR Tab, Smart Pen, Hubs & Docks, Cover & Cases, Screen Protectors |
| Gadgets & Accessories | Audio, Cover & Protectors, Cables, Chargers, Power Bank, Smart Tag, Wireless Charger, Multiplugs, Car Accessories, Gaming, Smart TV Box, Projector, Drone, Tripods & Monopods, Gimbal |
| Appliances | Kitchen Appliances, Air Conditioner, TV, Clock, Refrigerator & Freezer, Washing Machine, Power Station, Solar Panel, Charger Fan, Water Purifier, Geyser, Room Heater, Iron, Vacuum Cleaner, Lighting, Smart Scale |
| Lifestyle | Smart Watch, Watch, Smart Band, Watch Accessories, Action Camera, Umbrella, Trimmer, Hair Dryer, Straightener, Bag |
| Security & Networking | Wi-Fi Router, Starlink, NAS, IP Camera, WiFi Camera, HD Camera, NVR, DVR, Security Camera Package, Security Camera Accessories, Access Control & Accessories |

## Home page, in order

1. **Hero**: a slider (6-7 wide slides: pre-order, 0% EMI, AC fest, smart
   deals, Samsung S26 Ultra, Mac mini, MacBook Air) at the start and two
   stacked banners at the end (Tab Carnival, AG Computers).
2. **Trust strip**: five icon facts: 36 Months EMI, Fastest Home Delivery,
   Exchange Facility, Best Price Deals, After-Sales Service.
3. **Featured Categories**: 16 small tiles (thumbnail over a label) in a
   dense grid, then a "See All Categories" button.
4. **AG Computers** (Volt: "Volt Computers"): product tabs (Special PC,
   Motherboard, CPU, Graphics Card, SSD, RAM, ...), title at the start and the
   tabs at the end of one row, a grid of cards under it.
5. **Apple Exclusive 2026**: a product row with an exchange-offer banner.
6. **Home Appliances**: product tabs (Hot Deals, Air Fryer, Induction
   Cooker, Mixer Grinder, Microwave Oven, TV, AC, Washing Machine, Power
   Station).
7. **Exclusive Deals**: a grid of 15 discounted products.
8. **Featured Products**: product tabs (Earbuds, Neckband, Headphone,
   Speaker, Smart Watch, Power Adapter, Power Bank, Cables, Hubs & Docks,
   Stylus Pen, WiFi Router).
9. **Top brands** and a long SEO text block (footer intro: Power Solutions,
   Accessories & Essentials, Smartphones/Tablets & Apple Ecosystem, Home
   Appliances & Lifestyle).

## Product card

White card with a light border: square photo; a discount pill "৳ 4,501 OFF"
(an amount, not a percentage) at the top start; the name in up to two lines;
the price in bold brand colour beside the struck-through regular price. On
listings the card adds a "Shop Now" button. No rating, no add-to-cart icon.

## Category page

Breadcrumb (Home > Laptop); the title "Laptop Price in Bangladesh" with
"Showing: (167 Items)"; a banner image above; a filter sidebar at the start
(Price Range min/max with Submit, Exclude Out of Stock, then attribute groups
such as Processor Brand, RAM, Storage, Screen Size, Brands); a "Sort By"
control above the grid; numbered pagination (Previous, 1, 2, 3 ... 10, Next).

## Product page

1. Breadcrumb (Home > mobile phone > samsung).
2. Two columns: the gallery (one photo per colour, thumbnails) at the start;
   at the end: brand logo link and "Add to Compare", the title, a row of
   chips (Cash Price ৳113,999, Regular Price ৳117,000, Status: In stock,
   Product Code, Brand), "৳ 3,001 OFF", "EMI Available: View Plans", the
   option pickers (Color: 6 values, Storage: 12/256GB, 12/512GB, 16/1TB),
   quantity, the buttons "Shop Now" and "Add To Cart", a WhatsApp inquiry
   link and "Delivery Timescale: 3-5 Days".
3. Tabs: Specification, Description, Warranty, Reviews.
4. Specification table: grouped label/value rows (Body, Platform, Network,
   Display, Memory, Main Camera, Selfie Camera, Battery, Connectivity, Other).
5. Description, "Key Highlights" bullets, FAQ, warranty link, reviews.
6. "Check Similar Product Price" list, "Recently Viewed", "Related Product".

## Cart and offers

- `/offer`: a grid of offer cards (banner image, title, link) such as Tab
  Carnival, Apple Exclusive 2026, 0% EMI on iPhone 18 Series.
- Cart: the store's own cart (Volt does not skin buyer-private pages; the
  platform keeps app markup off cart and checkout).

## Footer

Dark band. Columns: contact (logo, hotline 09678148148 style phone, email,
App Store and Google Play badges); outlets (three addresses and "See All
Outlet"); About Us (About Us, Corporate, Order Tracking, Blog, Press
Coverage, Careers, Complain/Advice, Contact Us, FAQs); Policy (Privacy, EMI
and Payment, Warranty, Exchange, Delivery, Pre-Order, Refund, Return).
Social icons: WhatsApp, Facebook, Instagram, LinkedIn, YouTube. A copyright
line at the bottom.

## Colours (unverified)

White page on a light grey (#f2f4f8) body, near-black text (#1d1d1f), the
orange brand accent (#f26522) for prices, pills and the active tab, a dark
footer (#0f1115). Rounded 8 px cards, system sans type.
