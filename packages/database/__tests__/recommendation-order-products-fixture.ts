export const recommendationProjectionSeed = `INSERT INTO products(id,name,slug) VALUES ('p1','One','one'),('p2','Two','two'),('p3','Three','three');
INSERT INTO orders(id,customer_name,customer_phone,customer_email,shipping_address,city,zone,status,created_at,deleted_at) VALUES
 ('a','Buyer','+8801700000001','ignored@example.com','Road','City','Zone','confirmed',100,NULL),
 ('b','Buyer','',' Buyer@Example.com ','Road','City','Zone','pending',200,NULL),
 ('c','Buyer','',NULL,'Road','City','Zone','completed',300,NULL),
 ('d','Buyer','','   ','Road','City','Zone','delivered',400,NULL),
 ('e','Buyer','NO_PHONE','someone@example.com','Road','City','Zone','cancelled',500,NULL),
 ('f','Buyer','+8801700000002',NULL,'Road','City','Zone','confirmed',600,1);
INSERT INTO order_items(id,order_id,product_id,quantity,created_at) VALUES
 ('a1','a','p1',1,1),('a2','a','p1',2,2),('a3','a','p2',1,3),('b1','b','p1',1,4),
 ('c1','c','p2',1,5),('d1','d','p1',1,6),('e1','e','p1',1,7),('f1','f','p1',1,8);`;

export const recommendationProjectionOracle = `SELECT DISTINCT o.id AS order_id,i.product_id,o.created_at,
 coalesce(nullif(o.customer_phone,''),lower(trim(o.customer_email))) AS buyer
 FROM orders o JOIN order_items i ON i.order_id=o.id
 WHERE o.deleted_at IS NULL AND o.status IN ('pending','processing','confirmed','shipped','delivered','completed') ORDER BY 1,2`;
export const recommendationProjectionActual = "SELECT * FROM recommendation_order_products ORDER BY order_id,product_id";

export const recommendationProjectionMutations = [
  "DELETE FROM order_items WHERE id='a1'",
  `INSERT INTO order_items(id,order_id,product_id,quantity) VALUES ('a2','a','p3',1) ON CONFLICT(id) DO NOTHING`,
  `INSERT INTO order_items(id,order_id,product_id,quantity) VALUES ('a2','a','p3',1) ON CONFLICT(id) DO UPDATE SET product_id=excluded.product_id`,
  "UPDATE order_items SET order_id='b',product_id='p2' WHERE id='a3'",
  "UPDATE orders SET customer_email=' CHANGED@EXAMPLE.COM ',created_at=201 WHERE id='b'",
  "UPDATE orders SET customer_phone='NO_PHONE' WHERE id='b'",
  "UPDATE orders SET customer_phone='' WHERE id='b'",
  "UPDATE orders SET status='processing' WHERE id='a'",
  "UPDATE orders SET status='shipped' WHERE id='a'",
  "UPDATE orders SET status='cancelled' WHERE id='a'",
  "UPDATE orders SET status='incomplete' WHERE id='a'",
  "UPDATE orders SET status='refunded' WHERE id='a'",
  "UPDATE orders SET status='returned' WHERE id='a'",
  "UPDATE orders SET status='delivered' WHERE id='a'",
  "UPDATE orders SET deleted_at=1 WHERE id='a'",
  "UPDATE orders SET deleted_at=NULL,status='completed' WHERE id='a'",
  "UPDATE orders SET status='confirmed' WHERE id='e'",
  "UPDATE orders SET deleted_at=NULL WHERE id='f'",
  "DELETE FROM order_items WHERE order_id='b'",
  "DELETE FROM orders WHERE id='a'",
] as const;
