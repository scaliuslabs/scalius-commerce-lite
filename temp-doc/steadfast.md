



Here is the cleaned and formatted Markdown documentation extracted from the HTML file you provided.

***

# Steadfast Courier Limited
## API Documentation V1

### Table of Contents
1. API Authentication Parameter
2. Placing an order
3. Bulk Order Create
4. Checking Delivery Status
5. Checking Current Balance
6. Creating Return Requests *(Numbered 5 in original docs)*
7. Single Return Request View
8. Get Return Requests
9. Get Payments (Recently Added)
10. Get Single Payment with Consignments (Recently Added)
11. Get Policestations (Recently Added)

---

## 1. API Authentication Parameter

Authentication parameters are required to be added at the header part of each request.

**Base Url:** `https://portal.packzy.com/api/v1`

| Name | Type | Description | Value |
| :--- | :--- | :--- | :--- |
| **Api-Key** | String | API Key provided by Steadfast Courier Ltd. | `***************` |
| **Secret-Key** | String | Secret Key provided by Steadfast Courier Ltd. | `***************` |
| **Content-Type** | String | Request Content Type | `application/json` |

---

## 2. Placing an order

* **Path:** `/create_order`
* **Method:** `POST`

**Input Parameters:**

| Name | Type | MOC | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `invoice` | string | required | Must be Unique and can be alpha-numeric including hyphens and underscores. | `12366`, `abc123`, `12abchd`, `Aa12-das4`, `a_sdfd-wq` |
| `recipient_name` | string | required | Within 100 characters. | `John Smith` |
| `recipient_phone` | string | required | Must be 11 Digits Phone number. | `01234567890` |
| `alternative_phone`* | string | optional | Must be 11 Digits Phone number. | |
| `recipient_email`* | string | optional | | |
| `recipient_address` | string | required | Recipient’s address within 250 characters. | `Fla# A1, House# 17/1, Road# 3/A, Dhanmondi, Dhaka-1209` |
| `cod_amount` | numeric | required | Cash on delivery amount in BDT including all charges. Can’t be less than 0. | `1060` |
| `note` | string | optional | Delivery instructions or other notes. | `Deliver within 3 PM` |
| `item_description`*| string | optional | Items name and other information. | |
| `total_lot`* | numeric | optional | Total Lot of items. | |
| `delivery_type`* | numeric | optional | `0` = for home delivery, `1` = for Point Delivery/Steadfast Hub Pick Up. | `0` or `1` |

*\* Parameters marked with an asterisk were highlighted as newly added.*

**Response:**

```json
{
    "status": 200,
    "message": "Consignment has been created successfully.",
    "consignment": {
        "consignment_id": 1424107,
        "invoice": "Aa12-das4",
        "tracking_code": "15BAEB8A",
        "recipient_name": "John Smith",
        "recipient_phone": "01234567890",
        "recipient_address": "Fla# A1,House# 17/1, Road# 3/A, Dhanmondi,Dhaka-1209",
        "cod_amount": 1060,
        "status": "in_review",
        "note": "Deliver within 3PM",
        "created_at": "2021-03-21T07:05:31.000000Z",
        "updated_at": "2021-03-21T07:05:31.000000Z"
    }
}
```

---

## 3. Bulk Order Create

* **Path:** `/create_order/bulk-order`
* **Method:** `POST`

**Input Parameters:**

| Name | Type | MOC | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `data` | JSON | required | Maximum 500 items are allowed. JSON encoded array. | *Given below* |

**Array Keys:**
`$item = ['invoice' => 'adbd123']`

**Example (PHP):**

```php
public function bulkCreate(){
    $orders = Order::with('address')->where('status',1)->take(500)->get();
    $data = array();

    foreach($orders as $order){
        $item =[
            'invoice' => $order->id,
            'recipient_name' => $order->address ? $order->address->name : 'N/A',
            'recipient_address' => $order->address ? $order->address->address : 'N/A',
            'recipient_phone' => $order->address ? $order->address->phone : '',
            'cod_amount' => $order->due_amount,
            'note' => $order->note,
        ];
    }

    $steadfast = new Steadfast();
    $result = $steadfast->bulkCreate(json_encode($data));
    return $result;
}

// Example code
public function bulkCreate($data){
    $api_key = '1m9mwrrwsjbrg0w';
    $secret_key = 'y196ftazvk9s3';

    $response = Http::withHeaders([
        'Api-Key' => $api_key,
        'Secret-Key' => $secret_key,
        'Content-Type' => 'application/json'
    ])->post($this->base_url.'/create_order/bulk-order', [
        'data' => $data,
    ]);
    
    return json_decode($response->getBody()->getContents());
}
```

**Success Result:**

```json[
    {
        "invoice": "230822-1",
        "recipient_name": "John Doe",
        "recipient_address": "House 44, Road 2/A, Dhanmondi, Dhaka 1209",
        "recipient_phone": "0171111111",
        "cod_amount": "0.00",
        "note": null,
        "consignment_id": 11543968,
        "tracking_code": "B025A038",
        "status": "success"
    },
    {
        "invoice": "230822-1",
        "recipient_name": "John Doe",
        "recipient_address": "House 44, Road 2/A, Dhanmondi, Dhaka 1209",
        "recipient_phone": "0171111111",
        "cod_amount": "0.00",
        "note": null,
        "consignment_id": 11543969,
        "tracking_code": "B025A1DC",
        "status": "success"
    }
]
```

**Error Result:**
If there is any error in data, you will get a response like:

```json
{
    "data":[
        {
            "invoice": "230822-1",
            "recipient_name": "John Doe",
            "recipient_address": "House 44, Road 2/A, Dhanmondi, Dhaka 1209",
            "recipient_phone": "0171111111",
            "cod_amount": "0.00",
            "note": null,
            "consignment_id": null,
            "tracking_code": null,
            "status": "error"
        }
    ]
}
```

---

## 4. Checking Delivery Status

You can check delivery status using three different endpoints.

**i) By Consignment ID**
* **Path:** `/status_by_cid/{id}`
* **Method:** `GET`

**ii) By Your Invoice ID**
* **Path:** `/status_by_invoice/{invoice}`
* **Method:** `GET`

**iii) By Tracking Code**
* **Path:** `/status_by_trackingcode/{trackingCode}`
* **Method:** `GET`

**Response:**

```json
{
    "status": 200,
    "delivery_status": "in_review"
}
```

**Delivery Statuses:**

| Name | Description |
| :--- | :--- |
| `pending` | Consignment is not delivered or cancelled yet. |
| `delivered_approval_pending` | Consignment is delivered but waiting for admin approval. |
| `partial_delivered_approval_pending` | Consignment is delivered partially and waiting for admin approval. |
| `cancelled_approval_pending` | Consignment is cancelled and waiting for admin approval. |
| `unknown_approval_pending` | Unknown Pending status. Need contact with the support team. |
| `delivered` | Consignment is delivered and balance added. |
| `partial_delivered` | Consignment is partially delivered and balance added. |
| `cancelled` | Consignment is cancelled and balance updated. |
| `hold` | Consignment is held. |
| `in_review` | Order is placed and waiting to be reviewed. |
| `unknown` | Unknown status. Need contact with the support team. |

---

## 5. Checking Current Balance

* **Path:** `/get_balance`
* **Method:** `GET`

**Response:**

```json
{
    "status": 200,
    "current_balance": 0
}
```

---

## 6. Creating Return Requests

* **Path:** `/create_return_request`
* **Method:** `POST`

**Parameters:**

| Name | Type | Description |
| :--- | :--- | :--- |
| `consignment_id` or `invoice` or `tracking_code` | Required (Numeric or string) | Consignment ID or user-defined invoice ID or tracking code of the requesting consignment. |
| `reason` | Optional (string) | Reason for the return request. |

**Status Values:**
`'pending'`, `'approved'`, `'processing'`, `'completed'`, `'cancelled'`

**Response:**

```json
{
    "id": 1,
    "user_id": 1,
    "consignment_id": 10000042,
    "reason": null,
    "status": "pending",
    "created_at": "2025-07-30T23:11:45.000000Z",
    "updated_at": "2025-07-30T23:11:45.000000Z"
}
```

---

## 7. Single Return Request View

* **Path:** `/get_return_request/{id}`
* **Method:** `GET`

---

## 8. Get Return Requests

* **Path:** `/get_return_requests`
* **Method:** `GET`

---

## 9. Get Payments (Recently Added)

* **Path:** `/payments`
* **Method:** `GET`

---

## 10. Get Single Payment with Consignments (Recently Added)

* **Path:** `/payments/{payment_id}`
* **Method:** `GET`

---

## 11. Get Policestations (Recently Added)

* **Path:** `/police_stations`
* **Method:** `GET`




Here is the cleaned and formatted Markdown documentation for the Steadfast Courier Webhook Integration. You can append this directly to the end of the Steadfast API documentation.

***

## 12. Webhook Integration

The Steadfast webhook sends `POST` requests to your configured endpoint with JSON payloads based on the notification type. 

### Configuration
To start receiving webhooks, you need to configure the following in your Steadfast user dashboard:
* **Callback URL:** The endpoint on your server where the `POST` requests will be sent.
* **Auth Token (Bearer):** An optional authentication token that Steadfast will pass in the header to securely verify the request.

### Webhook Headers
When a webhook is triggered, your endpoint will receive the following headers:

| Header Name | Value |
| :--- | :--- |
| `Content-Type` | `application/json` |
| `Authorization` | `Bearer {your_api_key}` *(Sent if an Auth Token was configured)* |

---

### Notification Types

#### 1. Delivery Status Update
**Description:** This webhook notifies your system about changes in the delivery status of a consignment.

**Example Payload:**
```json
{
    "notification_type": "delivery_status",
    "consignment_id": 12345,
    "invoice": "INV-67890",
    "cod_amount": 1500.00,
    "status": "Delivered",
    "delivery_charge": 100.00,
    "tracking_message": "Your package has been delivered successfully.",
    "updated_at": "2025-03-02 12:45:30"
}
```

**Field Details:**

| Field Name | Type | Description |
| :--- | :--- | :--- |
| `notification_type` | string | Fixed value: `"delivery_status"` |
| `consignment_id` | integer | Unique ID of the consignment |
| `invoice` | string | Invoice number associated with the consignment |
| `cod_amount` | float | Cash on delivery (COD) amount |
| `status` | string | Current delivery status. Possible values:<br>• `pending`<br>• `delivered`<br>• `partial_delivered`<br>• `cancelled`<br>• `unknown` |
| `delivery_charge` | float | Delivery charge applied |
| `tracking_message` | string | Status update message |
| `updated_at` | string (datetime) | Timestamp of the last update (YYYY-MM-DD HH:MM:SS) |

#### 2. Tracking Update
**Description:** This webhook sends tracking updates for a consignment.

**Example Payload:**
```json
{
    "notification_type": "tracking_update",
    "consignment_id": 12345,
    "invoice": "INV-67890",
    "tracking_message": "Package arrived at the sorting center.",
    "updated_at": "2025-03-02 13:15:00"
}
```

**Field Details:**

| Field Name | Type | Description |
| :--- | :--- | :--- |
| `notification_type` | string | Fixed value: `"tracking_update"` |
| `consignment_id` | integer | Unique ID of the consignment |
| `invoice` | string | Invoice number associated with the consignment |
| `tracking_message` | string | Update message related to the package tracking |
| `updated_at` | string (datetime) | Timestamp of the last update (YYYY-MM-DD HH:MM:SS) |

---

### Response Handling

Your server must respond with an HTTP `200 OK` status if the webhook is processed successfully. 

**Success Response (Expected by Steadfast):**
```json
{
    "status": "success",
    "message": "Webhook received successfully."
}
```

**Error Response (Example if your system rejects the webhook):**
```json
{
    "status": "error",
    "message": "Invalid consignment ID."
}
```