export const buyerCountSeed = `INSERT INTO products (id,name,slug) VALUES
('p1','One','one'),('p2','Two','two'),('p3','Three','three'),('p4','Four','four');
INSERT INTO product_variants (id,product_id,sku,option_combination_key) VALUES
('v1','p1','V1','one'),('v2','p2','V2','two'),('v3','p3','V3','three'),('v4','p4','V4','four');
INSERT INTO product_buyer_state (product_id,is_public,brand_id,category_id,product_created_at,sku_id,from_minor,to_minor,base_minor)
VALUES ('p1',0,'b1','c1',1,'v1',100,100,100),('p2',1,'b1','c1',1,'v2',100,100,100),
('p3',1,NULL,NULL,1,'v3',100,100,100);`;

// Raw IDs deliberately have no definition rows: public resolution belongs to the reader.
export const buyerCountOracle = `SELECT 'brand' AS dimension,brand_id AS value_id,count(*) AS product_count
FROM product_buyer_state WHERE is_public=1 AND brand_id IS NOT NULL GROUP BY brand_id
UNION ALL SELECT 'category',category_id,count(*) FROM product_buyer_state
WHERE is_public=1 AND category_id IS NOT NULL GROUP BY category_id ORDER BY 1,2`;
export const buyerCountActual = "SELECT * FROM product_buyer_public_counts WHERE product_count>0 ORDER BY 1,2";

export const buyerCountMutations = [
  "UPDATE product_buyer_state SET is_public=1 WHERE product_id='p1'",
  "UPDATE product_buyer_state SET brand_id='b2' WHERE product_id='p1'",
  "UPDATE product_buyer_state SET category_id='c2' WHERE product_id='p1'",
  "UPDATE product_buyer_state SET brand_id='b3',category_id='c3' WHERE product_id='p1'",
  "UPDATE product_buyer_state SET brand_id=NULL,category_id=NULL WHERE product_id='p1'",
  "UPDATE product_buyer_state SET brand_id='b1',category_id='c1' WHERE product_id IN ('p1','p3')",
  `INSERT INTO product_buyer_state (product_id,is_public,brand_id,category_id,product_created_at,sku_id,from_minor,to_minor,base_minor)
   VALUES ('p1',1,'ignored','ignored',1,'v1',100,100,100) ON CONFLICT(product_id) DO NOTHING`,
  `INSERT INTO product_buyer_state (product_id,is_public,brand_id,category_id,product_created_at,sku_id,from_minor,to_minor,base_minor)
   VALUES ('p1',1,'b2','c2',1,'v1',100,100,100)
   ON CONFLICT(product_id) DO UPDATE SET brand_id=excluded.brand_id,category_id=excluded.category_id`,
  "UPDATE product_buyer_state SET is_public=0 WHERE product_id IN ('p1','p2')",
  "UPDATE product_buyer_state SET is_public=1 WHERE product_id IN ('p1','p2')",
  "UPDATE product_buyer_state SET product_id='p4',sku_id='v4' WHERE product_id='p3'",
  "DELETE FROM product_buyer_state WHERE product_id='p1'",
  "DELETE FROM products WHERE id='p2'",
  "DELETE FROM products",
] as const;
