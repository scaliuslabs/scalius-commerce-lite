export const facetCountSeed = `INSERT INTO products (id,name,slug) VALUES ('p1','One','one'),('p2','Two','two');
INSERT INTO product_variants (id,product_id,sku,option_combination_key) VALUES ('v1','p1','V1','one'),('v2','p1','V2','two'),('v3','p2','V3','three'),('v4','p2','V4','four');
INSERT INTO product_buyer_state (product_id,is_public,product_created_at,sku_id,from_minor,to_minor,base_minor)
VALUES ('p1',0,1,'v1',100,100,100),('p2',1,1,'v3',100,100,100);
INSERT INTO product_facet_values (owner_id,product_id,variant_id,facet_kind,facet_key,value_key,value_label)
VALUES ('v1','p1','v1','option','option.color','red','Red'),('v2','p1','v2','option','option.color','red','Red'),
('v3','p2','v3','option','option.color','red','Red'),('p1','p1',NULL,'attribute','material','cotton','Cotton');`;

export const facetCountOracle = `SELECT f.facet_kind,f.facet_key,f.value_key,count(DISTINCT f.product_id) AS product_count
FROM product_facet_values f JOIN product_buyer_state b ON b.product_id=f.product_id
WHERE b.is_public=1 GROUP BY f.facet_kind,f.facet_key,f.value_key ORDER BY 1,2,3`;
export const facetCountActual = "SELECT * FROM product_facet_public_counts WHERE product_count>0 ORDER BY 1,2,3";

export const facetCountMutations = [
  "UPDATE product_buyer_state SET is_public=1 WHERE product_id='p1'",
  "UPDATE product_facet_values SET value_key='blue',value_label='Blue' WHERE product_id='p1' AND facet_kind='option'",
  `INSERT INTO product_facet_values (owner_id,product_id,variant_id,facet_kind,facet_key,value_key,value_label)
   VALUES ('v1','p1','v1','option','option.color','ignored','Ignored') ON CONFLICT(owner_id,facet_key) DO NOTHING`,
  `INSERT INTO product_facet_values (owner_id,product_id,variant_id,facet_kind,facet_key,value_key,value_label)
   VALUES ('v1','p1','v1','option','option.color','yellow','Yellow')
   ON CONFLICT(owner_id,facet_key) DO UPDATE SET value_key=excluded.value_key,value_label=excluded.value_label`,
  "UPDATE product_facet_values SET facet_key='option.shade' WHERE owner_id='v1'",
  // Move the product-grain attribute, then change metadata without changing its group.
  "UPDATE product_facet_values SET owner_id='p2',product_id='p2' WHERE owner_id='p1'",
  "UPDATE product_facet_values SET value_label='COTTON',sort_order=10,value_number=3 WHERE facet_kind='attribute'",
  "DELETE FROM product_variants WHERE id='v2'",
  "DELETE FROM product_buyer_state WHERE product_id='p1'",
  `INSERT INTO product_buyer_state (product_id,is_public,product_created_at,sku_id,from_minor,to_minor,base_minor)
   VALUES ('p1',1,1,'v1',100,100,100)`,
  `INSERT INTO product_buyer_state (product_id,is_public,product_created_at,sku_id,from_minor,to_minor,base_minor)
   VALUES ('p1',1,1,'v1',100,100,100) ON CONFLICT(product_id) DO NOTHING`,
  // The normal rebuild deletes obsolete facets before the buyer-state upsert.
  "DELETE FROM product_facet_values WHERE product_id='p1'",
  `INSERT INTO product_facet_values (owner_id,product_id,variant_id,facet_kind,facet_key,value_key,value_label)
   VALUES ('v1','p1','v1','option','option.color','red','Red')`,
  "UPDATE product_buyer_state SET is_public=0 WHERE product_id='p1'",
  "UPDATE product_buyer_state SET is_public=1 WHERE product_id='p1'",
  "DELETE FROM products WHERE id='p2'",
  "DELETE FROM products WHERE id='p1'",
] as const;
