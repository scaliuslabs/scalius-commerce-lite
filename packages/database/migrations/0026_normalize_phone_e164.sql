-- Normalize existing Bangladesh phone numbers to E.164 format
-- Local format 01XXXXXXXXX -> +8801XXXXXXXXX

UPDATE customers
SET phone = '+880' || SUBSTR(phone, 2)
WHERE phone LIKE '01%' AND LENGTH(phone) = 11;

UPDATE orders
SET customer_phone = '+880' || SUBSTR(customer_phone, 2)
WHERE customer_phone LIKE '01%' AND LENGTH(customer_phone) = 11;

UPDATE abandoned_checkouts
SET customer_phone = '+880' || SUBSTR(customer_phone, 2)
WHERE customer_phone LIKE '01%' AND LENGTH(customer_phone) = 11
AND customer_phone IS NOT NULL;

UPDATE customer_history
SET phone = '+880' || SUBSTR(phone, 2)
WHERE phone LIKE '01%' AND LENGTH(phone) = 11;
