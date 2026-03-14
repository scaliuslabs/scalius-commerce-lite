


Here is the complete RedX OpenAPI documentation, carefully extracted and formatted into clean, readable Markdown.

***

# RedX OpenAPI Documentation

OpenAPI lets merchants connect to RedX through secure and reliable APIs for seamless parcel operations. With these APIs, you can easily create and manage parcels and pickup stores. It streamlines your logistics workflow and connects you directly to RedX for all your parcel management needs.

---

## Environments

### Sandbox
The sandbox environment is designed for testing and experimentation with API integrations. All transactions and operations performed here are simulated and do not impact real data. This environment is ideal for developers to validate their implementations before going live. Please use the sandbox URL and token to access this environment.

* **Base URL:** `sandbox.redx.com.bd/v1.0.0-beta`

### Production
The production environment is intended for live API operations that interact with real data. Ensure all integrations are thoroughly tested in the sandbox environment before transitioning to production. Please use the production URL and token to access this environment.

* **Base URL:** `openapi.redx.com.bd/v1.0.0-beta`

*(All API requests require the header `API-ACCESS-TOKEN: Bearer {{jwt_token}}`)*

---

## 1. Track Parcel

**Method:** `GET`
**Endpoint:** `/parcel/track/<:parcel_id>`

**Sample Request:**
```bash
curl --location '{{base_url}}/v1.0.0-beta/parcel/track/{{tracking_id}}' \
  --header 'API-ACCESS-TOKEN: Bearer {{jwt_token}}'
```

**Request Parameters:**

| Field Name | Field Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `tracking_id` | string | Yes | Unique identifier assigned to a parcel for tracking. |

**Sample Response:**
```json
{
  "tracking":[
    {
      "message_en": "Package is created successfully",
      "message_bn": "পার্সেলটি সফল ভাবে প্লেস করা হয়েছে",
      "time": "2020-02-04T21:19:41.000Z"
    },
    {
      "message_en": "Package is picked up",
      "message_bn": "পার্সেল পিকাপ সম্পন্ন হয়েছে ",
      "time": "2020-02-05T11:41:03.000Z"
    }
  ]
}
```

**Response Data:**

| Field Name | Field Type | Optional | Description |
| :--- | :--- | :--- | :--- |
| `tracking` | array | No | List of tracking updates for the parcel. |
| `message_en` | string | No | Tracking update message in English. |
| `message_bn` | string | No | Tracking update message in Bengali. |
| `time` | string (ISO 8601) | No | Timestamp of the tracking update. |

---

## 2. Get Parcel Details

**Method:** `GET`
**Endpoint:** `/parcel/info/<:tracking_id>`

**Sample Request:**
```bash
curl --location '{{base_url}}/v1.0.0-beta/parcel/info/{{tracking_id}}' \
  --header 'API-ACCESS-TOKEN: Bearer {{jwt_token}}'
```

**Request Parameters:**

| Field Name | Field Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `tracking_id` | string | Yes | Unique identifier assigned to a parcel for tracking. |

**Sample Response:**
```json
{
  "parcel": {
    "tracking_id": "21A427TU4BN3R",
    "customer_address": "Test Addtess",
    "delivery_area": "Mirpur DOHS",
    "delivery_area_id": 12,
    "charge": 60,
    "customer_name": "Test Customer",
    "customer_phone": "01987654321",
    "cash_collection_amount": 13293,
    "parcel_weight": 500,
    "merchant_invoice_id": "ACBD1234TEST",
    "status": "pickup-pending",
    "instruction": "",
    "created_at": "2021-04-27T08:29:14.000Z",
    "delivery_type": "regular",
    "value": "0",
    "pickup_location": {
      "id": 1,
      "name": "Malibag",
      "address": "Malibagh",
      "area_name": "Malibag",
      "area_id": 1
    }
  }
}
```

**Response Data:**

| Field Name | Field Type | Optional | Description |
| :--- | :--- | :--- | :--- |
| `parcel` | object | No | Parcel details. |
| `parcel.tracking_id` | string | No | Unique tracking ID of the parcel. |
| `parcel.customer_address` | string | No | Delivery address of the customer. |
| `parcel.delivery_area` | string | No | Name of the delivery area. |
| `parcel.delivery_area_id` | number | No | Unique ID of the delivery area. |
| `parcel.charge` | number | No | Delivery charge for the parcel. |
| `parcel.customer_name` | string | No | Name of the customer receiving the parcel. |
| `parcel.customer_phone` | string | No | Phone number of the customer. |
| `parcel.cash_collection_amount` | number | No | Amount to be collected from the customer. |
| `parcel.parcel_weight` | number | No | Weight of the parcel in grams. |
| `parcel.merchant_invoice_id`| string | No | Invoice ID provided by the merchant. |
| `parcel.status` | string | No | Current status of the parcel. |
| `parcel.instruction` | string | Yes | Additional delivery instructions (if any). |
| `parcel.created_at` | string (ISO 8601)| No | Timestamp when the parcel was created. |
| `parcel.delivery_type` | string | No | Type of delivery (e.g., regular, express). |
| `parcel.value` | string | No | Declared value of the parcel. |
| `parcel.pickup_location` | object | No | Details of the pickup location. |
| `parcel.pickup_location.id` | number | No | Unique ID of the pickup location. |
| `parcel.pickup_location.name` | string | No | Name of the pickup location. |
| `parcel.pickup_location.address`| string | No | Address of the pickup location. |
| `parcel.pickup_location.area_name`| string | No | Name of the area where the pickup location is situated. |
| `parcel.pickup_location.area_id`| number | No | Unique ID of the pickup location area. |

---

## 3. Create Parcel

**Method:** `POST`
**Endpoint:** `/parcel`

**Sample Request:**
```bash
curl --location '{{base_url}}/v1.0.0-beta/parcel' \
  --header 'API-ACCESS-TOKEN: Bearer {{jwt_token}}' \
  --header 'Content-Type: application/json' \
  --data '{
      "customer_name": "{{customer_name}}",
      "customer_phone": "{{customer_phone}}",
      "delivery_area": "{{delivery_area}}",
      "delivery_area_id": {{delivery_area_id}},
      "customer_address": "{{customer_address}}",
      "merchant_invoice_id": "{{merchant_invoice_id}}",
      "cash_collection_amount": "{{cash_collection_amount}}",
      "parcel_weight": {{parcel_weight}},
      "instruction": "{{instruction}}",
      "value": {{value}},
      "is_closed_box": "{{is_closed_box}}",
      "pickup_store_id": {{pickup_store_id}},
      "parcel_details_json":[
          {
              "name": "{{name}}",
              "category": "{{category}}",
              "value": {{value}}
          },
          {
              "name": "{{name}}",
              "category": "{{category}}",
              "value": {{value}}
          }
      ]
  }'
```

**Request Parameters:**

| Field Name | Field Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `customer_name` | string | Yes | Full name of the customer receiving the parcel. |
| `customer_phone` | string | Yes | Contact phone number of the customer. |
| `delivery_area` | string | Yes | Name of the delivery area where the parcel will be sent. |
| `delivery_area_id` | integer | Yes | Unique identifier of the delivery area. |
| `customer_address` | string | Yes | Complete address of the customer for parcel delivery. |
| `cash_collection_amount` | string | Yes | Amount to be collected from the customer upon delivery. |
| `parcel_weight` | string | Yes | Weight of the parcel in appropriate units (e.g., kg, g). |
| `merchant_invoice_id` | string | No | Invoice ID generated by the merchant for reference. |
| `instruction` | string | No | Special instructions for the delivery (if any). |
| `type` | string | No | Defines the parcel type, mainly used for reverse shipments. |
| `value` | string | Yes | Declared value of the parcel for compensation calculation. |
| `parcel_details_json` | object | No | JSON object containing additional parcel details. |
| `pickup_store_id` | string | No | Identifier of the pickup store where the parcel is collected from. |

**Parcel Details Object (`parcel_details_json`):**

| Field Name | Field Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `name` | string | Yes | Name of the item inside the parcel. |
| `category` | string | Yes | Category of the item (e.g., electronics, clothing, etc.). |
| `value` | integer | Yes | Declared value of the individual item. |

**Sample Response:**
```json
{
  "tracking_id": "20A312THJDJ8"
}
```

**Response Data:**

| Field Name | Field Type | Optional | Description |
| :--- | :--- | :--- | :--- |
| `tracking_id` | string | No | Unique tracking ID of the parcel. |

---

## 4. Update Parcel

**Method:** `PATCH`
**Endpoint:** `/parcels`

**Sample Request:**
```bash
curl --location --request PATCH '{{base_url}}/v1.0.0-beta/parcels' \
  --header 'API-ACCESS-TOKEN: Bearer {{jwt_token}}' \
  --header 'Content-Type: application/json' \
  --data '{
      "entity_type": "parcel-tracking-id",
      "entity_id": "{{tracking_id}}",
      "update_details":{
          "property_name": "status",
          "new_value": "cancelled",
          "reason": "Your Cancellation Reason"
      }
  }'
```

**Request Parameters:**

| Field Name | Field Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `entity_type` | string | Yes | Type of entity being updated, e.g., 'parcel-tracking-id'. |
| `entity_id` | string | Yes | Unique identifier of the parcel to be updated. |
| `update_details`| object | Yes | Object containing details of the update to be applied. |

**Update Details Object:**

| Field Name | Field Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `property_name` | string | Yes | Name of the parcel property to be updated (e.g., status, delivery_address). |
| `new_value` | string | Yes | New value to be assigned to the specified property. |
| `reason` | string | No | Optional reason for the update, useful for logging changes. |

**Sample Response:**
```json
{
  "success": true,
  "message": "Request Accepted"
}
```

**Response Data:**

| Field Name | Field Type | Optional | Description |
| :--- | :--- | :--- | :--- |
| `success` | boolean | No | Indicates whether the request was successful. |
| `message` | string | No | Descriptive message about the request status. |

---

## 5. Get Areas

**Method:** `GET`
**Endpoint:** `/areas`

**Sample Request:**
```bash
curl --location '{{base_url}}/v1.0.0-beta/areas' \
  --header 'API-ACCESS-TOKEN: Bearer {{jwt_token}}'
```

**Sample Response:**
```json
{
  "areas":[
    {
      "id": 1,
      "name": "Mohammadpur(Dhaka)",
      "post_code": 1207,
      "division_name": "Dhaka",
      "zone_id": 1
    },
    {
      "id": 2,
      "name": "Dhanmondi",
      "post_code": 1209,
      "division_name": "Dhaka",
      "zone_id": 1
    },
    {
      "id": 3,
      "name": "Gulshan",
      "post_code": 1212,
      "division_name": "Dhaka",
      "zone_id": 1
    }
  ]
}
```

**Response Data:**

| Field Name | Field Type | Optional | Description |
| :--- | :--- | :--- | :--- |
| `areas` | array | No | List of areas available for delivery. |
| `id` | number | No | Unique identifier of the area. |
| `name` | string | No | Name of the area. |
| `post_code` | number | No | Postal code of the area. |
| `division_name` | string | No | Name of the division where the area is located. |
| `zone_id` | number | No | Zone identifier for the area. |

---

## 6. Get Areas Against One Postal Code

**Method:** `GET`
**Endpoint:** `/areas?post_code=<:postal_code>`

**Sample Request:**
```bash
curl --location '{{base_url}}/v1.0.0-beta/areas?post_code={{post_code}}' \
  --header 'API-ACCESS-TOKEN: Bearer {{jwt_token}}'
```

**Request Parameters:**

| Field Name | Field Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `post_code` | integer | Yes | The postal code for which areas need to be retrieved. |

**Sample Response:**
```json
{
  "areas":[
    {
      "id": 13,
      "name": "Kochukhet",
      "post_code": 1206,
      "division_name": "Dhaka",
      "zone_id": 1
    },
    {
      "id": 20,
      "name": "Ibrahimpur",
      "post_code": 1206,
      "division_name": "Dhaka",
      "zone_id": 1
    }
  ]
}
```

**Response Data:** *(Matches "Get Areas" Response Data)*

---

## 7. Get Areas Against One District Name

**Method:** `GET`
**Endpoint:** `/areas?district_name=<:district_name>`

**Sample Request:**
```bash
curl --location '{{base_url}}/v1.0.0-beta/areas?district_name={{district_name}}' \
  --header 'API-ACCESS-TOKEN: Bearer {{jwt_token}}'
```

**Request Parameters:**

| Field Name | Field Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `district_name` | string | Yes | The name of the district for which areas need to be retrieved. |

**Sample Response:**
```json
{
  "areas":[
    {
      "id": 13,
      "name": "Kochukhet",
      "post_code": 1206,
      "division_name": "Dhaka",
      "zone_id": 1
    },
    {
      "id": 20,
      "name": "Ibrahimpur",
      "post_code": 1206,
      "division_name": "Dhaka",
      "zone_id": 1
    },
    {
      "id": 23,
      "name": "Kafrul",
      "post_code": 1206,
      "division_name": "Dhaka",
      "zone_id": 1
    }
  ]
}
```

**Response Data:** *(Matches "Get Areas" Response Data)*

---

## 8. Create Pickup Store

**Method:** `POST`
**Endpoint:** `/pickup/store`

**Sample Request:**
```bash
curl --location '{{base_url}}/v1.0.0-beta/pickup/store' \
  --header 'API-ACCESS-TOKEN: Bearer {{jwt_token}}' \
  --data '{
      "name": "{{name}}",
      "phone": "{{phone}}",
      "address": "{{address}}",
      "area_id": {{area_id}}
  }'
```

**Request Parameters:**

| Field Name | Field Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `name` | string | Yes | The name of the pickup store. |
| `phone` | string | Yes | The contact phone number for the pickup store. |
| `address` | string | Yes | The physical address of the pickup store. |
| `area_id` | integer | Yes | The unique identifier of the area where the pickup store is located. |

**Sample Response:**
```json
{
  "id": 1,
  "name": "Test Pickup Store",
  "address": "Test Address",
  "area_name": "Mohammadpur(Dhaka)",
  "area_id": 1,
  "phone": "8801898000999"
}
```

**Response Data:**

| Field Name | Field Type | Optional | Description |
| :--- | :--- | :--- | :--- |
| `id` | number | No | Unique identifier of the pickup store. |
| `name` | string | No | Name of the pickup store. |
| `address` | string | No | Address of the pickup store. |
| `area_name` | string | No | Name of the area where the pickup store is located. |
| `area_id` | number | No | Unique identifier of the area. |
| `phone` | string | No | Contact phone number of the pickup store. |

---

## 9. Get Pickup Stores

**Method:** `GET`
**Endpoint:** `/pickup/stores`

**Sample Request:**
```bash
curl --location '{{base_url}}/v1.0.0-beta/pickup/stores' \
  --header 'API-ACCESS-TOKEN: Bearer {{jwt_token}}' \
  --data ''
```

**Sample Response:**
```json
{
  "pickup_stores":[
    {
      "id": 1,
      "name": "Store 1",
      "address": "123 Main St",
      "area_name": "Dhaka",
      "area_id": 1,
      "phone": "01900000000",
      "created_at": "2021-09-13T10:39:15.000Z"
    },
    {
      "id": 2,
      "name": "Store 2",
      "address": "456 Main St",
      "area_name": "Dhaka",
      "area_id": 1,
      "phone": "01900000001",
      "created_at": "2021-09-14T10:39:15.000Z"
    }
  ]
}
```

**Response Data:**

| Field Name | Field Type | Optional | Description |
| :--- | :--- | :--- | :--- |
| `pickup_stores` | array | No | List of available pickup stores. |
| `id` | number | No | Unique identifier of the pickup store. |
| `name` | string | No | Name of the pickup store. |
| `address` | string | No | Address of the pickup store. |
| `area_name` | string | No | Name of the area where the pickup store is located. |
| `area_id` | number | No | Unique identifier of the area. |
| `phone` | string | No | Contact phone number of the pickup store. |
| `created_at` | string | No | Timestamp indicating when the pickup store was created. |

---

## 10. Pickup Store Details

**Method:** `GET`
**Endpoint:** `/pickup/store/info/<:pickup_store_id>`

**Sample Request:**
```bash
curl --location '{{base_url}}/v1.0.0-beta/pickup/store/info/{{pickup_store_id}}' \
  --header 'API-ACCESS-TOKEN: Bearer {{jwt_token}}' \
  --data ''
```

**Request Parameters:**

| Field Name | Field Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `pickup_store_id` | integer | Yes | The unique identifier of the pickup store whose details need to be retrieved. |

**Sample Response:**
```json
{
  "pickup_store": {
    "id": 1,
    "name": "Test Pickup Store",
    "address": "Test Address",
    "area_name": "Mohammadpur(Dhaka)",
    "area_id": 1,
    "phone": "8801898000999",
    "created_at": "2021-09-13T10:39:15.000Z"
  }
}
```

**Response Data:**

| Field Name | Field Type | Optional | Description |
| :--- | :--- | :--- | :--- |
| `pickup_store` | object | No | Details of the pickup store. |
| `pickup_store.id` | number | No | Unique identifier of the pickup store. |
| `pickup_store.name` | string | No | Name of the pickup store. |
| `pickup_store.address` | string | No | Address of the pickup store. |
| `pickup_store.area_name` | string | No | Name of the area where the pickup store is located. |
| `pickup_store.area_id` | number | No | Unique identifier of the area. |
| `pickup_store.phone` | string | No | Contact phone number of the pickup store. |
| `pickup_store.created_at`| string | No | Timestamp indicating when the pickup store was created. |

---

## 11. Calculate Parcel Charge

**Method:** `GET`
**Endpoint:** `/charge/charge_calculator`

**Sample Request:**
```bash
curl --location '{{base_url}}/v1.0.0-beta/charge/charge_calculator?delivery_area_id={{delivery_area_id}}&pickup_area_id={{pickup_area_id}}&cash_collection_amount={{cash_collection_amount}}&weight={{weight}}' \
  --header 'API-ACCESS-TOKEN: Bearer {{jwt_token}}'
```

**Request Parameters:**

| Field Name | Field Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `delivery_area_id` | number | Yes | The unique identifier of the area where the parcel will be delivered. |
| `pickup_area_id` | number | Yes | The unique identifier of the area where the parcel will be picked up. |
| `cash_collection_amount` | number | Yes | The total cash amount to be collected upon delivery. |
| `weight` | number | Yes | The weight of the parcel in grams. |

**Sample Response:**
```json
{
  "deliveryCharge": 60,
  "codCharge": 0
}
```

**Response Data:**

| Field Name | Field Type | Optional | Description |
| :--- | :--- | :--- | :--- |
| `deliveryCharge` | number | No | The cost of delivery for the parcel. |
| `codCharge` | number | No | The cash-on-delivery (COD) charge. |




Here is the complete and formatted Markdown documentation for the **RedX Webhook Integration**. You can easily append this to the end of your RedX OpenAPI documentation!

***

## 12. Webhook Integration

Configure your webhook URL to receive real-time updates about events directly from our system. Ensure the URL is publicly accessible and can securely handle incoming `POST` requests. Merchants should handle these status updates accordingly to keep their systems synchronized with the latest parcel status.

### Callback URL Structure
Merchants are required to provide a Callback URL in the RedX dashboard where RedX will send parcel status updates. The Callback URL must adhere to the following specifications:

* **Method:** `POST`
* **Credentials:** Any required credentials (like tokens or API keys) should be included in the query parameters of the URL.
* **Example URL:** `https://example.com/callback?token=<your_token>`

---

### Sample Request Format
When a parcel status changes, RedX will send a `POST` request to your provided Callback URL with a JSON payload.

* **Content-Type:** `application/json`

**Sample Payload:**
```json
{
    "tracking_number": "<REDX_TRACKING_ID>",
    "timestamp": "<TIMESTAMP>",
    "status": "<STATUS>",
    "message_en": "<MESSAGE_EN>",
    "message_bn": "<MESSAGE_BN>",
    "invoice_number": "<INVOICE_NUMBER>"
}
```

---

### Status Updates and Meanings

The `status` field in the request payload will indicate the current status of the parcel. Below are the possible status values along with their exact meanings:

| MAPPED_STATUS | Meaning |
| :--- | :--- |
| `ready-for-delivery` | Parcel received from merchants |
| `delivery-in-progress`| Parcels have been dispatched to rider |
| `delivered` | Parcels delivered by rider |
| `agent-hold` | Parcels are on hold to agent |
| `agent-returning` | Parcel return-in-progress |
| `returned` | Parcels returned |
| `agent-area-change` | Area change requested & in progress |