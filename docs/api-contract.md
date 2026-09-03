````markdown
# Pink Transit — API Contract (v2)

**Base URL (Backend / Supabase Edge Functions):** `https://welccusfyovxgpfplnlj.supabase.co/functions/v1`
**Base URL (AI/ML service):** _See Section 10 — hosted separately, docs at `/docs` on that service._

**Status:** Auth, Eligibility, Booking, Scanning, Admin Stats, Search, and Ticket History are all built, tested, hardened, and live. Payments and SMS are intentionally mocked for the demo (see Section 9). AI/ML endpoints exist but their exact request/response shapes are pending confirmation from the AI/ML team.

> **Note to team:** If you're not sure which endpoint to call for something, or what an error means — it's in this file. Ask backend before assuming.

---

## How Auth Works (Read This First)

There are three kinds of "auth" used across these endpoints:

1. **Anon key:** A fixed public key, used only for `send-otp` and `verify-otp` (before a user has a session).
2. **User session token:** The JWT returned from `verify-otp`. Send it as `Authorization: Bearer <token>` on every endpoint that needs to know who's calling. Valid for 7 days.
3. **Role-restricted token:** Same session token, but the endpoint checks the `role` field inside it (`passenger`, `conductor`, `admin`). Wrong role returns a `403`.

**All requests need these headers:**

```http
Authorization: Bearer <anon_key OR session_token>
Content-Type: application/json
```
````

---

## Standard Error Format

Every error from every endpoint below follows this shape:

```json
{ "error": "human-readable message" }
```

**Common status codes:**

| Code    | Meaning                                                             |
| ------- | ------------------------------------------------------------------- |
| **400** | Bad request — missing field, or invalid format (bad phone/PAN/UUID) |
| **401** | Missing, invalid, or expired session token                          |
| **403** | Token is valid, but the role doesn't have access to this endpoint   |
| **404** | Resource not found (e.g., trip doesn't exist)                       |
| **429** | Too many attempts (OTP brute-force protection)                      |
| **500** | Unexpected server error — ask backend to check logs                 |

---

## 1. Send OTP

`POST /send-otp`
**Auth header:** Anon key
**Request body:**

```json
{ "phone": "9876543210" }
```

_Validation:_ Must be a 10-digit number starting with 6–9 (Indian mobile format). Anything else → 400. Requesting a new OTP invalidates any previous unused OTP for that phone number.

**Success response (200):**

```json
{
  "success": true,
  "mock_sms": true,
  "message": "OTP generated for 9876543210 (mocked — real SMS integration pending)",
  "otp_code": "668745"
}
```

_(Note: `otp_code` is only present because SMS is mocked. In production this field is removed.)_

---

## 2. Verify OTP

`POST /verify-otp`
**Auth header:** Anon key
**Request body:**

```json
{ "phone": "9876543210", "otp_code": "668745" }
```

_Brute-force protection:_ Max 5 wrong OTP guesses per code. The 6th wrong attempt returns 429.

**Success response (200):**

```json
{
  "success": true,
  "token": "eyJhbGciOi...(JWT, valid 7 days)",
  "user": {
    "id": "9bf24467-f022-43b9-a608-91e2136783ef",
    "phone": "9876543210",
    "name": null,
    "role": "passenger",
    "created_at": "2026-08-30T18:00:00Z"
  }
}
```

_(Note: Save the `token`. On first verify, a user is auto-created with role: `passenger`. Admin/Conductor roles are set manually in the DB for testing)._

---

## 3. Check Pink Card Eligibility

`POST /check-pink-card`
**Auth header:** User session token
**Request body:**

```json
{ "pan": "ABCDE1234F" }
```

_Validation:_ Must match PAN format (5 letters, 4 digits, 1 letter). Invalid format → 400.

**Success response (200):** _(This exact shape is locked; AI/ML chatbot depends on it)_

```json
{
  "success": true,
  "application_id": "a15fc07c-a3a7-40cd-a7d1-da2ba1a30a5e",
  "pan": "ABCDE1234F",
  "eligible": true,
  "gender": "F",
  "annual_income": 120000,
  "threshold": 250000,
  "gap": -130000,
  "reason_code": "ELIGIBLE_INCOME_GENDER",
  "reason_message": "Eligible: income is ₹1,30,000 below the threshold."
}
```

**`reason_code` Reference (Safe to pattern-match):**

| Code                     | Meaning                               |
| ------------------------ | ------------------------------------- |
| `ELIGIBLE_INCOME_GENDER` | Eligible: female + income ≤ ₹2,50,000 |
| `INELIGIBLE_GENDER`      | Scheme is female-only                 |
| `INELIGIBLE_INCOME_HIGH` | Female, but income exceeds ₹2,50,000  |
| `INELIGIBLE_NO_RECORD`   | PAN not found in the database         |

---

## 4. Book Ticket

`POST /book-ticket`
**Auth header:** User session token
**Request body:**

```json
{ "trip_id": "e0a6b4ed-175d-4402-8c61-9ae01d521bc8" }
```

_Validation:_ `trip_id` must be a valid UUID.

**Success response (200):**

```json
{
  "success": true,
  "ticket": {
    "id": "4825c025-6426-40a7-a31d-6a0001d0f632",
    "user_id": "9bf24467-f022-43b9-a608-91e2136783ef",
    "trip_id": "e0a6b4ed-175d-4402-8c61-9ae01d521bc8",
    "fare_charged": 0,
    "qr_payload": "4825c025-6426-40a7-a31d-6a0001d0f632",
    "status": "issued",
    "issued_at": "2026-08-30T20:24:53.624401+00:00",
    "scanned_at": null
  },
  "pink_card_applied": true,
  "payment_status": "success",
  "mock_payment": true
}
```

_Fare logic:_ If the user's most recent `check-pink-card` was `eligible: true`, fare is 0. Otherwise, base fare is charged.
_QR Payload:_ The `qr_payload` is just the ticket's UUID. Render this as a QR code on the frontend. The scanner looks up everything else server-side.

---

## 5. Scan Ticket (Conductor Only)

`POST /scan-ticket`
**Auth header:** Conductor session token
**Request body:**

```json
{
  "ticket_id": "4825c025-6426-40a7-a31d-6a0001d0f632",
  "trip_id": "optional-trip-uuid"
}
```

_Validation:_ `ticket_id` must be a valid UUID.

**Success response (200):**

```json
{
  "success": true,
  "scan_result": "valid",
  "valid": true,
  "reason": "Boarding approved",
  "ticket_id": "4825c025-6426-40a7-a31d-6a0001d0f632",
  "fare_charged": 0
}
```

**`scan_result` values:**

- `valid`: Ticket accepted, marked as scanned.
- `already_used`: Fraud prevention—ticket was already scanned once.
- `expired`: Ticket status is expired or cancelled.
- `invalid`: Ticket not found, or doesn't match the boarded `trip_id`.

---

## 6. Admin Stats

`GET /admin-stats?range=all`
**Auth header:** Admin session token
**Query param `range`:** `today` | `week` | `all` (defaults to `all` if omitted)

**Success response (200):**

```json
{
  "success": true,
  "range": "all",
  "total_revenue": 25,
  "pink_card_discount_lost": 30,
  "revenue_by_route": [
    {
      "route_name": "Route 45",
      "revenue": 0,
      "tickets_sold": 1,
      "free_tickets": 1
    },
    {
      "route_name": "Route 12",
      "revenue": 25,
      "tickets_sold": 1,
      "free_tickets": 0
    }
  ],
  "trip_count": 2,
  "estimated_cost_per_trip": 800,
  "estimated_cost": 1600,
  "net_estimate": -1575,
  "cost_note": "estimated_cost is a hardcoded flat rate per trip — no real fuel/wage data source yet"
}
```

---

## 7. Search Trips

`GET /search-trips?origin=Howrah&destination=Salt+Lake`
**Auth header:** None required (Public)
**Query params (optional):** `origin`, `destination` (Case-insensitive partial match)

**Success response (200):**

```json
{
  "success": true,
  "count": 1,
  "trips": [
    {
      "trip_id": "e0a6b4ed-175d-4402-8c61-9ae01d521bc8",
      "bus_number": "WB-01-1234",
      "departure_time": "2026-08-30T20:42:11.525043+00:00",
      "route_name": "Route 12",
      "origin": "Howrah",
      "destination": "Salt Lake",
      "base_fare": 25
    }
  ]
}
```

---

## 8. Ticket History

`GET /ticket-history`
**Auth header:** User session token

**Success response (200):**

```json
{
  "success": true,
  "count": 2,
  "tickets": [
    {
      "ticket_id": "4825c025-6426-40a7-a31d-6a0001d0f632",
      "route_name": "Route 45",
      "origin": "Esplanade",
      "destination": "Garia",
      "bus_number": "WB-02-5678",
      "departure_time": "2026-08-30T21:00:00+00:00",
      "fare_charged": 0,
      "status": "scanned",
      "issued_at": "2026-08-30T20:24:53.624401+00:00",
      "scanned_at": "2026-08-30T20:48:43.955+00:00"
    }
  ]
}
```

---

## 9. What's Mocked (and why)

| Feature                   | Status    | Detail                                              |
| ------------------------- | --------- | --------------------------------------------------- |
| **Pink Card Eligibility** | ✅ Real   | Gender + income logic, reason codes                 |
| **Pink Card Income Data** | ⚠️ Mocked | Hardcoded DB table instead of government PAN API    |
| **QR Generation/Scan**    | ✅ Real   | UUID-based QR, real validation and reuse prevention |
| **Payment Gateway**       | ⚠️ Mocked | Instantly succeeds, no Razorpay integration         |
| **OTP Delivery**          | ⚠️ Mocked | Returned in API response instead of SMS             |
| **OTP Verification**      | ✅ Real   | Fully real logic with brute-force rate limits       |
| **Admin Revenue**         | ✅ Real   | Calculated from actual ticket data                  |
| **Admin Cost Figures**    | ⚠️ Mocked | Flat ₹800/trip estimate; no live fuel data          |

---

## 10. AI/ML Service Endpoints

_(Hosted separately from the backend above — exact formats pending team confirmation)_

| Endpoint                    | Purpose                                        | Status  |
| --------------------------- | ---------------------------------------------- | ------- |
| `POST /chatbot`             | Explains Pink Card rejection in plain language | Pending |
| `POST /predict-demand`      | Route-wise passenger demand forecast           | Pending |
| `GET /fleet-recommendation` | Suggests bus allocation per route              | Pending |

> **Note for `/chatbot`:** It is built to consume the exact `check-pink-card` response shape from Section 3. If that shape ever changes, backend must notify the AI/ML team first.

---

## Quick Reference — Auth Header Cheat Sheet

| Endpoint                | Auth Required           |
| ----------------------- | ----------------------- |
| `POST /send-otp`        | Anon Key                |
| `POST /verify-otp`      | Anon Key                |
| `POST /check-pink-card` | User session token      |
| `POST /book-ticket`     | User session token      |
| `POST /scan-ticket`     | Conductor session token |
| `GET /admin-stats`      | Admin session token     |
| `GET /search-trips`     | None (Public)           |
| `GET /ticket-history`   | User session token      |
| `POST /chatbot`         | _See AI/ML Team Docs_   |

---

## Known Gaps (Out of Scope for Demo)

- Aadhaar OCR / face-match / Resident Certificate uploads.
- Multi-state income thresholds (currently fixed at ₹2,50,000 everywhere).
- Card renewal workflows and expiry alerts.

```

```
