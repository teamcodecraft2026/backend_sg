Pink Transit — Backend API Contract (v1)

Base URL: https://welccusfyovxgpfplnlj.supabase.co/functions/v1

All requests require these headers:

Authorization: Bearer <anon_key OR user session token — see per-endpoint notes>
Content-Type: application/json

Status: Auth, Eligibility, Booking, and Scanning are built and tested end-to-end. Payments are mocked (always succeed instantly). OTP SMS is mocked (OTP code is returned directly in the API response, not sent via SMS). Admin endpoints not yet built.

1. Send OTP

POST /send-otp

Auth header: use the Supabase anon public key

Request body:

json
{ "phone": "9876543210" }

Success response (200):

json
{
"success": true,
"mock_sms": true,
"message": "OTP generated for 9876543210 (mocked — real SMS integration pending)",
"otp_code": "668745"
}

otp_code is only present because SMS is mocked. In production this field will be removed and the code will only exist server-side.

Error (400): missing phone

2. Verify OTP

POST /verify-otp

Auth header: use the Supabase anon public key

Request body:

json
{ "phone": "9876543210", "otp_code": "668745" }

Success response (200):

json
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

On first verify for a new phone number, a user is auto-created with role: "passenger".

Save token. Every endpoint below requires it as:

Authorization: Bearer <token>

Errors:

400 — OTP expired or not found
401 — Invalid OTP code 3. Check Pink Card Eligibility

POST /check-pink-card

Auth header: the user's session token (from verify-otp)

Request body:

json
{ "pan": "ABCDE1234F" }

Success response (200) — eligible example:

json
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

Not eligible — possible reason_code values:

reason_code Meaning
ELIGIBLE_INCOME_GENDER Eligible: female + income under ₹2,50,000
INELIGIBLE_GENDER Scheme is female-only
INELIGIBLE_INCOME_HIGH Female, but income exceeds ₹2,50,000
INELIGIBLE_NO_RECORD PAN not found in the income database

When not eligible, gender/annual_income/gap may be null (e.g. no-record case).

gap meaning: negative = income is below threshold (good, this much room to spare). Positive = income exceeds threshold by this much.

Errors:

400 — missing pan
401 — missing/invalid/expired token

This same response shape is stored server-side and read by the AI chatbot to explain rejections — do not expect this shape to change.

4. Book Ticket

POST /book-ticket

Auth header: the user's session token

Request body:

json
{ "trip_id": "e0a6b4ed-175d-4402-8c61-9ae01d521bc8" }

Success response (200):

json
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

Fare logic: if the user's most recent Pink Card check was eligible: true, fare_charged is 0. Otherwise, fare_charged equals the route's base_fare. A user must call check-pink-card at least once before booking to get the discount — there's no automatic re-check during booking.

qr_payload is just the ticket's UUID — render this string as a QR code on the frontend. The scanner looks up all other details server-side; nothing else needs to be encoded in the QR.

Errors:

400 — missing trip_id, or trip not open for booking
401 — missing/invalid/expired token
404 — trip not found 5. Scan Ticket (Conductor only)

POST /scan-ticket

Auth header: a conductor-role user's session token (role: "conductor" — regular passenger tokens are rejected)

Request body:

json
{ "ticket_id": "4825c025-6426-40a7-a31d-6a0001d0f632" }

ticket_id is exactly what's decoded from the ticket's QR code (the qr_payload value from booking).

Optional: pass trip_id too if you want to enforce the ticket matches the trip currently being boarded:

json
{ "ticket_id": "...", "trip_id": "..." }

Success response (200) — valid ticket:

json
{
"success": true,
"scan_result": "valid",
"valid": true,
"reason": "Boarding approved",
"ticket_id": "4825c025-6426-40a7-a31d-6a0001d0f632",
"fare_charged": 0
}

scan_result possible values:

scan_result valid Meaning
valid true Ticket accepted, marked as scanned, boarding approved
already_used false Ticket was already scanned once — reject
expired false Ticket status is expired or cancelled
invalid false Ticket not found, or doesn't match the given trip_id

Errors:

400 — missing ticket_id
401 — missing/invalid/expired token
403 — token is valid but role isn't conductor

A ticket can only ever be scanned successfully once. Design the conductor UI around this — show a clear success/fail state per scan, don't allow retry-looping on the same ticket.

## 6. Admin Stats

`GET /admin-stats?range=all`

**Auth header:** an **admin-role** user's session token

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

**Field notes:**

- `pink_card_discount_lost` = sum of `base_fare` for every route where a ticket was issued free (fare_charged = 0)
- `estimated_cost_per_trip` is a hardcoded flat rate (₹800), not based on real fuel/wage data — swap this out if real cost data becomes available
- `net_estimate` = total_revenue − estimated_cost (can be negative, that's expected with free Pink Card rides)

**Errors:**

- `401` — missing/invalid/expired token
- `403` — token valid but role isn't `admin`

## 7. Search Trips

`GET /search-trips?origin=Howrah&destination=Salt+Lake`

**Auth header:** none required — public endpoint

**Query params (both optional):** `origin`, `destination` — case-insensitive partial match

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

Only trips with `status: "scheduled"` are returned.

---

## 8. Ticket History

`GET /ticket-history`

**Auth header:** the **user's session token**

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

Sorted most recent first. `status` reflects the ticket's current state: `issued`, `scanned`, `expired`, or `cancelled`.

Not yet available (coming later)
Admin dashboard endpoints (revenue/cost/route stats) — Days 5–6
Real payment gateway — stays mocked for the demo per team decision
Real SMS delivery — stays mocked for the demo per team decision
Quick reference — auth header cheat sheet
Endpoint Auth header value
/send-otp anon key
/verify-otp anon key
/check-pink-card user session token
/book-ticket user session token
/scan-ticket conductor session token
| /admin-stats | admin session token |
| /search-trips | none (public) |
| /ticket-history | user session token |
