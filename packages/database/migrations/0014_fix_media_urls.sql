-- Fix bare R2 object keys stored without the CDN domain prefix.
-- This is a one-time migration to prepend https://cloud.wrygo.com/ to all
-- media URLs that were saved as bare keys (e.g. "abc123.jpg" instead of
-- "https://cloud.wrygo.com/abc123.jpg") due to R2_PUBLIC_URL not being set.

-- Fix media.url (media library files)
UPDATE media
SET url = 'https://cloud.wrygo.com/' || url
WHERE url NOT LIKE 'http%' AND url != '';

-- Fix product_images.url (product gallery images)
UPDATE product_images
SET url = 'https://cloud.wrygo.com/' || url
WHERE url NOT LIKE 'http%' AND url != '';

-- Fix categories.image_url (category images)
UPDATE categories
SET image_url = 'https://cloud.wrygo.com/' || image_url
WHERE image_url IS NOT NULL AND image_url NOT LIKE 'http%' AND image_url != '';
