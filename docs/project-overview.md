# Mogul — Project Overview

## What is Mogul?

Mogul is a **multi-tenant WhatsApp chatbot** that lets ski rental shop customers book equipment via WhatsApp. Each shop connects via its own WhatsApp Business number, and all reservations flow into the shop's **Easyrent** instance (the industry-standard PMS for ski rental shops in Austria/Italy).

The product is designed to be sold as a SaaS to ski rental shops. One backend serves all shops — each shop is a tenant identified by a UUID.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js (TypeScript) |
| Framework | Express |
| Database | PostgreSQL |
| WhatsApp API | Meta Cloud API (webhooks + Graph API) |
| Easyrent integration | SOAP (`wseasyrent`) + REST (`easyrest/rest`) |
| SOAP client | `node-soap` |
| Language | TypeScript (strict) |

---

## Project Structure

```
src/
├── index.ts                          — Express entry point, cleanup job
├── config.ts                         — Env var validation, frozen config object
├── types/easyrent.ts                 — All TypeScript types (SOAP, REST, ConversationData)
├── db/
│   ├── pool.ts                       — PostgreSQL connection pool
│   ├── schema.sql                    — Full DB schema (idempotent, IF NOT EXISTS)
│   └── seed-test-shop.sql            — Test shop seed data
├── webhook/
│   └── whatsapp.ts                   — Meta webhook router (GET verify + POST messages)
├── conversation/
│   └── stateMachine.ts               — Full conversation state machine
├── integrations/easyrent/
│   ├── soapClient.ts                 — Typed SOAP client with retry + backoff
│   └── restClient.ts                 — Typed REST client
├── i18n/
│   ├── index.ts                      — t() translation helper
│   ├── de.json                       — German strings
│   └── en.json                       — English strings
└── scripts/
    └── repl.ts                       — Local REPL for testing the flow without WhatsApp
```

---

## Database Schema

### `shops`
One row per tenant. Stores:
- WhatsApp credentials: `whatsapp_phone_number_id`, `whatsapp_token`
- Easyrent credentials: `easyrent_soap_url`, `easyrent_rest_base_url`, `easyrent_accessid`, `easyrent_branchid`
- Supported languages: `languages TEXT[]`

### `conversations`
One row per active customer conversation. All collected state lives in a `data JSONB` column (typed as `ConversationData`). Conversations expire after 24h of inactivity (sliding TTL, enforced by `expire_stale_conversations()` DB function called every 15 min).

Statuses: `active` | `completed` | `expired` | `abandoned`

### `reservations`
One row per completed booking. Stores Easyrent codes: `easyrent_customer_code`, `easyrent_group_code`, `easyrent_reservation_code`.

### `processed_messages`
Dedup table — stores WhatsApp message IDs to prevent double-processing on Meta retries. Pruned after 48h.

### `message_queue`
Durable queue for Easyrent API calls. 3 attempts with exponential backoff. Failed jobs stay in the table for inspection.

---

## Webhook Layer (`src/webhook/whatsapp.ts`)

- **GET `/webhook/:shopId`** — Meta verification challenge
- **POST `/webhook/:shopId`** — Incoming messages
  1. Respond HTTP 200 immediately (Meta requires <20s)
  2. Verify `X-Hub-Signature-256` (HMAC-SHA256)
  3. Deduplicate by message ID
  4. Handle reset commands (`reset` / `neustart` / `ricominciare`) — expires active conversation
  5. Call the state machine → get reply string
  6. Send reply via Meta Graph API (auto-splits at 4096 chars)

---

## Conversation State Machine (`src/conversation/stateMachine.ts`)

The state machine drives the full booking flow. Each incoming message is routed through `processMessage(shopId, waPhone, text)` which returns a reply string.

### Full Flow

**Step 1 — WELCOME**
Language selection: DE / EN / IT

**Step 2 — DATE_FROM**
Rental start date. Accepts `DD.MM.YYYY` or `YYYY-MM-DD`.

**Step 3 — DATE_TO**
Rental end date.

**Step 4 — BRANCH**
Customer picks a shop branch from a numbered list.

---

**Per-person loop** (repeats for each group member):

**Step 5 — PERSON_NAME**
Format: `Firstname, Lastname`

**Step 6 — PERSON_DOB**
Date of birth. Determines if the person is a **kid (≤14)** or **adult**. Kids skip the skill level question and get a simplified equipment path.

**Step 7 — EQUIPMENT_CATEGORY**
Options: Ski / Snowboard / Other

---

**Ski branch (adult):**
- `SKI_SKILL` — Skill level: beginner (1) / intermediate (2) / advanced (3)
- `SKI_BOOTS` — Does the customer have their own boots?
  - Yes → `SKI_BOOTS_TYPE` (bring own) or `SKI_SOLE` (sole length in mm)
  - No → boots are added to equipment
- `SKI_NEED` — Which ski tier? (economy / premium / diamant / factory test / basic)
- `SKI_MODEL` — Specific model preference (optional)
- `HELMET` → `HELMET_TYPE` (visor / no visor) if yes
- `MEASUREMENTS` — Height (cm) + weight (kg), required when skis are in equipment
- `HOTEL` — Hotel/accommodation name

**Ski branch (kid):**
- Skips `SKI_SKILL`
- One-touch: kids ski + kids boots added automatically
- Goes straight to `HELMET` → `MEASUREMENTS` → `HOTEL`

**Snowboard branch:**
- `SNOWBOARD_BOOTS` — Boot size
- `SNOWBOARD_MODEL` — Economy or premium
- `HELMET` → `HELMET_TYPE`
- `HOTEL`

**Other branch:**
- `OTHER_CATEGORY` — Touring / XC / Misc
  - **Touring** → `TOURING_ITEMS` (multi-select: ski, boots, backpack, radar, shovel, avalanche bag, probe) → `HELMET` → `MEASUREMENTS` → `HOTEL`
  - **XC** → `XC_TYPE` (classic / skating) → `XC_BOOTS` → `MEASUREMENTS` → `HOTEL`
  - **Misc** → `MISC_ITEM` (snowshoes / sleigh) → `HOTEL`

---

**Step 8 — ADD_PERSON**
Add another person? Yes → loop back to Step 5. No → continue.

**Step 9 — EMAIL**
Contact email for the reservation.

**Step 10 — SPECIAL_REQUESTS**
Free-text or skip.

**Step 11 — INSURANCE**
Damage insurance (Carefree Protection Package):
- Adults: €3.50/day
- Kids (≤14): €1.50/day
Presented with total cost for the group + rental period.

**Step 12 — CONFIRM**
Full summary shown: branch, dates, email, per-person equipment + measurements + skill + hotel, pricing, insurance. Customer confirms.

**Step 13 — DONE**
Reservation submitted to Easyrent via SOAP + REST. Conversation marked `completed`.

---

## Easyrent Integration

### SOAP client (`soapClient.ts`)
All methods wrap `node-soap` with typed inputs/outputs, 3-attempt retry, exponential backoff, and `EasyrentError` on failure. Client instances are cached by WSDL URL.

Methods implemented:
- `soapCustInsertOrUpdateV2` — upsert customer with full profile (height, weight, skill, sole length, hotel, DOB)
- `soapSetGroupCustomerV2` — link customers into a rental group
- `soapInsertCustomerV2` — simpler customer insert
- `soapGetCustomersV3` — search customers
- `soapGetAvailCount` — check equipment availability
- `soapGetRentalArticle` — query rental articles
- `soapBookSaleV2` — book a sale

### REST client (`restClient.ts`)
Typed fetch-based client for `easyrest/rest` endpoints.

Methods implemented:
- `restInsertUpdateReservation` — create/update a reservation

Endpoints available (types defined, not all wired to flow yet):
- `/branches` — list branches
- `/customers` — query customers
- `/rentalarticles` — query rental articles
- `/reservation/getavailcount` — availability check
- `/reservation/reservablearticles`
- `/calendar/getEquipmentTypes`, `/calendar/getRentalGroups`, `/calendar/getAvailability`
- `/isatde/reservation` — post-creation verification
- `/testaccess` — connectivity test

> **Important:** The exact REST reservation body structure (`RestReservationBody`) is not yet confirmed against a live Easyrent instance. A potential two-step basket flow (`PUT /reservation/basket/{basketid}` → confirm → reservation code) also needs to be validated.

---

## i18n

Translation helper `t(language, key, params?)` supports `de`, `en`, `it`. Strings are in `de.json` and `en.json`. Italian strings need to be added.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `META_APP_SECRET` | Yes | — | HMAC secret for webhook signature verification |
| `META_WEBHOOK_VERIFY_TOKEN` | Yes | — | Token for Meta webhook registration |
| `PORT` | No | 3000 | HTTP port |
| `NODE_ENV` | No | `development` | `development` / `production` / `test` |
| `CONVERSATION_TTL_HOURS` | No | 24 | Conversation expiry window |
| `CLEANUP_INTERVAL_MS` | No | 900000 (15m) | How often the cleanup job runs |

---

## What is NOT done yet

- **Italian (`it`) translations** — only DE and EN exist
- **Live Easyrent REST reservation body** — structure needs validation against a real instance
- **Basket flow** — may be required by Easyrent before creating a reservation
- **Branch list from Easyrent** — currently hardcoded as `EXAMPLE_BRANCHES`; should be fetched via REST `/branches`
- **Pricing from Easyrent** — currently `MOCK_PRICES`; should come from the live catalog
- **Admin dashboard** — Phase 3, not started
- **Production deployment** — no Docker / CI config yet
- **Tests** — no test suite yet
