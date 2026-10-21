// The store and writes the per-scope facet count tests share (0174, D1 and PostgreSQL).
import { facetScopeCountsSelect } from "../src/derived-projections";

export const scopeCountsSeed = `INSERT INTO categories (id,name,slug,status) VALUES ('c1','C1','c1','published'),('c2','C2','c2','published');
INSERT INTO brands (id,name,slug,status) VALUES ('brd_scale0001','B1','b1','published'),('brd_scale0002','B2','b2','published');
INSERT INTO products (id,name,slug,category_id,brand_id) VALUES ('p1','One','one','c1','brd_scale0001'),('p2','Two','two','c1',NULL),('p3','Three','three',NULL,'brd_scale0002');
INSERT INTO product_variants (id,product_id,sku,option_combination_key) VALUES ('v1','p1','V1','one'),('v2','p1','V2','two'),('v3','p2','V3','three'),('v4','p3','V4','four');
INSERT INTO product_buyer_state (product_id,is_public,category_id,brand_id,product_created_at,sku_id,from_minor,to_minor,base_minor)
VALUES ('p1',1,'c1','brd_scale0001',1,'v1',100,100,100),('p2',0,'c1',NULL,1,'v3',100,100,100),('p3',1,NULL,'brd_scale0002',1,'v4',100,100,100);
INSERT INTO product_facet_values (owner_id,product_id,variant_id,facet_kind,facet_key,value_key,value_label)
VALUES ('v1','p1','v1','option','option.color','red','Red'),('v2','p1','v2','option','option.color','red','Red'),
('v3','p2','v3','option','option.color','red','Red'),('p1','p1',NULL,'attribute','material','cotton','Cotton'),
('v4','p3','v4','option','option.color','blue','Blue');
INSERT INTO product_review_stats (product_id,review_count,rating_sum,count_4,count_5,rating_avg_centi,rating_rank_milli) VALUES ('p1',2,9,1,1,450,3800);`;

export const scopeCountsActual = "SELECT scope_kind, scope_id, facet_kind, facet_key, value_key, product_count FROM product_facet_scope_counts WHERE product_count > 0 ORDER BY 1,2,3,4,5";
export const scopeCountsOracle = `SELECT scope_kind, scope_id, facet_kind, facet_key, value_key, product_count FROM (${facetScopeCountsSelect}) AS expected ORDER BY 1,2,3,4,5`;
/** Value rows whose sample is not a public product of the scope with the value (none, ever). */
export const scopeCountsBadSamples = `SELECT c.scope_kind, c.scope_id, c.facet_key, c.value_key, c.sample_product_id FROM product_facet_scope_counts c
  WHERE c.product_count > 0 AND c.facet_kind IN ('attribute', 'option') AND NOT EXISTS (
    SELECT 1 FROM product_facet_values v JOIN product_buyer_state b ON b.product_id = v.product_id AND b.is_public = 1
    WHERE v.product_id = c.sample_product_id AND v.facet_kind = c.facet_kind AND v.facet_key = c.facet_key AND v.value_key = c.value_key
      AND ((c.scope_kind = 'category' AND b.category_id = c.scope_id) OR (c.scope_kind = 'brand' AND b.brand_id = c.scope_id)))`;

export const scopeCountsMutations = [
  "UPDATE product_buyer_state SET is_public=1 WHERE product_id='p2'",
  "UPDATE product_facet_values SET value_key='blue',value_label='Blue' WHERE product_id='p1' AND owner_id='v1'",
  "UPDATE product_facet_values SET value_key='blue',value_label='Blue' WHERE product_id='p1' AND owner_id='v2'",
  // A category and a brand move: the old scopes lose the product, the new ones gain it.
  "UPDATE product_buyer_state SET category_id='c2', brand_id='brd_scale0002' WHERE product_id='p1'",
  "UPDATE product_buyer_state SET brand_id=NULL WHERE product_id='p1'",
  // Ratings: a bucket change, a first rating, a removed one.
  "UPDATE product_review_stats SET rating_avg_centi=320 WHERE product_id='p1'",
  "INSERT INTO product_review_stats (product_id,review_count,rating_sum,count_5,rating_avg_centi,rating_rank_milli) VALUES ('p3',1,5,1,500,3300)",
  "UPDATE product_review_stats SET review_count=0,rating_sum=0,count_4=0,count_5=0,rating_avg_centi=NULL,rating_rank_milli=NULL WHERE product_id='p1'",
  "UPDATE product_review_stats SET review_count=1,rating_sum=4,count_4=1,rating_avg_centi=399,rating_rank_milli=3100 WHERE product_id='p1'",
  "DELETE FROM product_review_stats WHERE product_id='p3'",
  // Facet rows of a hidden product count nothing until it is public again.
  "UPDATE product_buyer_state SET is_public=0 WHERE product_id='p1'",
  `INSERT INTO product_facet_values (owner_id,product_id,variant_id,facet_kind,facet_key,value_key,value_label)
   VALUES ('p1','p1',NULL,'attribute','fit','slim','Slim')`,
  "UPDATE product_buyer_state SET is_public=1 WHERE product_id='p1'",
  "UPDATE product_facet_values SET facet_key='option.shade' WHERE owner_id='v1'",
  "DELETE FROM product_variants WHERE id='v2'",
  "DELETE FROM product_buyer_state WHERE product_id='p1'",
  `INSERT INTO product_buyer_state (product_id,is_public,category_id,brand_id,product_created_at,sku_id,from_minor,to_minor,base_minor)
   VALUES ('p1',1,'c1','brd_scale0001',1,'v1',100,100,100)`,
  "DELETE FROM products WHERE id='p2'",
  "DELETE FROM products WHERE id='p1'",
] as const;

