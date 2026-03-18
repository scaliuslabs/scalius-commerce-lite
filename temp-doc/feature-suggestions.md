# Feature Suggestions

Features listed from a merchant's and customer's perspective — what they'd actually ask for.

---

## Must Have

### 1. Order Confirmation Email+SMS

When a customer places an order, they should receive an email with their order number, items, total, and shipping address. Right now customers get nothing until the order is shipped.

### 2. Admin Push Notification on New Order

The admin should get a push notification on their phone/browser when a new order comes in. The code for this exists but is disconnected — it needs to be wired up.

### 3. Fix Currency to Use Store Settings Everywhere

When a merchant sets their currency to USD or EUR in admin settings, everything should just work — payment gateways, order records, storefront display. Right now the database defaults to BDT in several places regardless of what the merchant configures.

### 4. Configurable Country Code for Phone Numbers

Phone validation and formatting is locked to Bangladesh (+880). A merchant in another country should be able to set their default country code in admin settings, and phone inputs, validation, placeholders, and OTP delivery should all follow.

### 5. Tax on Orders

A merchant should be able to go to Settings, enable tax, set a rate (e.g., 15% VAT), give it a label, and choose whether prices are tax-inclusive or tax-exclusive. The tax amount should appear in the cart, checkout, order confirmation, admin order view, and invoices.

### 6. Invoice Generation

From the admin order view page, a merchant should be able to click "View Invoice" and see a clean, printable invoice with their business name, logo, address, tax ID, order items, tax breakdown, and totals. They should be able to print it or download it as PDF. The admin settings should have a section for business/invoice details (company name, address, logo, tax ID, footer text). Invoice numbers should auto-increment.

### 7. Order Tracking on Customer Account Page

When a customer views their order history, they should see the tracking ID, courier name, and a link to track their shipment. This data already exists in the shipment records — it just needs to show up on the customer-facing account page.

### 8. Product Page Structured Data (JSON-LD)

Product pages should output JSON-LD schema.org Product markup so Google can show rich snippets (price, availability, product name, image) in search results.

### 9. Open Graph Tags for Social Sharing

When someone shares a product or page link on Facebook, WhatsApp, or Twitter, it should show the product image, title, price, and description — not a blank card. Layout.astro needs og:title, og:description, og:image, and og:url meta tags.

### 10. Canonical URLs

Every page should have a `<link rel="canonical">` tag pointing to its clean URL. This prevents duplicate content issues from query parameters, pagination, and tracking params.

### 11. CSV Export for Orders

From the order list page, a merchant should be able to select orders (or export all with current filters) and download a CSV with order ID, date, customer name, phone, address, items, total, payment status, fulfillment status, and tracking ID.

### 12. CSV Export for Products

From the product list page, export a CSV with product name, slug, price, stock, category, variants, SKU, barcode, and status.

### 13. CSV Export for Customers

From the customer list page, export a CSV with name, phone, email, total orders, total spent, and registration date.

### 14. Bulk Order Status Change

Select multiple orders from the order list and change their status in one action — e.g., mark 50 orders as "Processing" or "Confirmed" at once.

### 15. CSV Product Import

Upload a CSV to create or update products in bulk. Support columns for name, price, category, description, variants, stock, SKU, barcode, images (URLs). Show a preview with validation errors before importing. Handle create vs update by matching on SKU or product ID.

---

## Good to Have

### 16. Bulk Product Activate/Deactivate

Select multiple products and activate or deactivate them in one action.

### 17. Bulk Product Price Update

Select multiple products and apply a price change — increase by percentage, decrease by fixed amount, or set a specific price.

### 18. Payment Confirmed Email to Customer

When payment is confirmed (Stripe webhook, SSLCommerz IPN), send the customer an email confirming their payment was received.

### 19. Order Cancelled/Refunded Email to Customer

When an order is cancelled or refunded, the customer should receive an email explaining what happened and any refund details.

### 20. Business Information Settings

Admin settings should have a section for store/business information: business name, legal name, address, phone, email, tax registration number. This data feeds into invoices, email footers, and structured data.

### 21. Breadcrumb Structured Data (JSON-LD)

Add BreadcrumbList JSON-LD schema to product and category pages. The breadcrumb HTML already exists — it just needs the schema markup alongside it.

### 22. Reorder Button on Customer Account

On the customer's past orders, add a "Reorder" button that adds all items from that order back into the cart.

### 23. Bulk Invoice Download

From the order list, select multiple orders and download all their invoices as a single PDF or ZIP file.

### 24. Customer Return Request Form

On the customer account page, allow customers to request a return on a delivered order — select items, pick a reason, and submit. The admin sees the request and can approve/reject it.

### 25. SMS OTP Provider Integration

The OTP transport abstraction exists but SMS delivery has no actual provider. Integrate at least one SMS gateway (e.g., Twilio, BulkSMSBD, or similar) so merchants using phone-based auth can actually send OTP via SMS.

### 26. Google Shopping Product Feed

A product feed in Google Merchant Center format (similar to the existing Facebook feed) so merchants can run Google Shopping ads.

### 27. Discount Stacking

Allow customers to use a product discount code and a shipping discount code together on the same order. The combine flags already exist in the schema — they just need to be enforced in the validation logic.

### 28. Automatic Discounts (No Code Required)

Allow merchants to create discounts that apply automatically when conditions are met (e.g., 10% off orders over 5000 BDT) without the customer needing to enter a code.

### 29. Category Hierarchy

Support parent/child categories so merchants can organize products into nested categories (e.g., Clothing > Men > T-Shirts). The storefront navigation already supports nested menus.

### 30. Organization JSON-LD Schema

Add Organization structured data to the storefront layout using business information from admin settings — store name, logo, contact info, social profiles.

### 31. Bulk Product Category Assignment

Select multiple products and assign or change their category in one action.

### 32. Email Template Customization

Let merchants customize the content and look of transactional emails (order confirmation, shipped, delivered, cancelled, refund) from admin settings — at minimum, logo, header color, and footer text.

### 33. Shipment Status History

Show the full timeline of shipment status changes on the admin order view — not just the current status, but when it was picked up, in transit, out for delivery, etc.

### 34. Multiple Saved Addresses on Customer Account

Let customers save multiple delivery addresses and pick from them during checkout instead of typing every time.

### 35. Wishlist / Save for Later

Let customers save products to a wishlist from the product page. Show saved items on the account page with an "Add to Cart" button.

### 36. Low Stock Email Alerts to Admin

When a product variant's stock drops below its low stock threshold, send an email to the admin. The low stock alert table already exists — it just needs an email trigger.

### 37. Product Reviews and Ratings

Let customers leave reviews and star ratings on products they've purchased. Show average rating on product cards and the full review list on product pages. Admin can moderate reviews before they go live.

### 38. Dynamic Collection Rules Engine

The collection schema supports "dynamic" type with a JSON config field, but there's no UI to define rules. Add a rule builder in admin where merchants can create collections like "All products over 1000 BDT" or "All products in category X with stock > 0".

### 39. Abandoned Cart Recovery Email

The abandoned checkout table already tracks incomplete orders with customer info. Add a scheduled job that sends a recovery email to customers who started checkout but didn't complete it within a configurable time window.

### 40. Newsletter Signup

Add an email capture form to the storefront footer. Store subscribers in a new table. Integrate with email marketing services (Mailchimp, Brevo) via webhook or API so merchants can run campaigns.
