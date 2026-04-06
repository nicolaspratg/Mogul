# Mogul

**WhatsApp chatbot SaaS for ski rental shops — book equipment via chat, no app required.**

Mogul is a multi-tenant backend that connects ski rental shops to their customers over WhatsApp. A customer sends a message, works through a guided conversation, and a reservation lands directly in the shop's Easyrent management system — no account creation, no app download, no friction.

---

## The Problem

Ski rental shops run on Easyrent, an industry-standard PMS (property management system). Customers still book by walking in or calling. Mogul adds a WhatsApp channel without replacing the existing workflow: reservations appear in Easyrent exactly as if staff had entered them.

---

## How It Works

```
Customer (WhatsApp)
      │
      ▼
Meta Cloud API  ──webhook──►  Mogul Backend  ──SOAP/REST──►  Easyrent PMS
                                    │
                                    ▼
                              PostgreSQL
                         (state, queue, dedup)
```

1. Customer sends a WhatsApp message to the shop's number
2. Mogul picks up the webhook, loads or creates a conversation from the database
3. A state machine drives the customer through the booking flow (language → dates → branch → per-person equipment → email → insurance → confirm)
4. On confirmation, Mogul calls the Easyrent SOAP/REST API to create the customer profile and reservation
5. The shop sees the booking in their existing system — nothing changes on their end

---

## Features

**Booking flow (12 steps)**
- Language selection: German, English, Italian
- Rental period (check-in / check-out dates)
- Branch selection
- Per-person loop: name, date of birth, equipment category + full spec
- Email collection
- Free-text special requests
- Insurance (tiered pricing, calculated in-flight)
- Full summary + confirmation before submission

**Equipment supported**
| Category | Options |
|---|---|
| Ski | Skill level, boot rental, model tier, helmet, measurements |
| Snowboard | Boot rental, model, helmet |
| Cross-country | Classic or skating, boot rental, measurements |
| Touring | Ski, boots, backpack, avalanche safety gear (multi-select) |
| Miscellaneous | Snowshoes, sleigh |

Kids ≤14 years automatically get a simplified flow (no skill questions).

**Multi-tenant architecture**
- Each shop is a row in `shops` with its own WhatsApp credentials and Easyrent credentials
- A single backend serves all tenants — no per-shop deployment

**Reliability**
- SOAP/REST clients: 3 retries with exponential backoff
- Message deduplication: prevents double-processing on Meta webhook retries
- Durable message queue: failed Easyrent calls stay in the DB for inspection and retry
- Conversation TTL: 24-hour sliding window, auto-expired by a background cleanup job
- HMAC-SHA256 signature verification on every incoming webhook (constant-time comparison)

---

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20+ |
| Language | TypeScript (strict) |
| Framework | Express 4 |
| Database | PostgreSQL 13+ |
| WhatsApp | Meta Cloud API (webhooks + Graph API) |
| Easyrent | SOAP (`node-soap`) + REST |
| i18n | Custom translation layer with variable interpolation |

---

## Project Structure

```
src/
├── index.ts                    # Server entry point + cleanup scheduler
├── config.ts                   # Environment validation + frozen config object
├── types/easyrent.ts           # Shared types: SOAP/REST payloads + ConversationData
├── db/
│   ├── pool.ts                 # PostgreSQL connection pool
│   ├── schema.sql              # Idempotent schema (5 tables, triggers, functions)
│   ├── seed-test-shop.sql      # Local dev fixture
│   └── seed-riml-sports.sql    # Pilot shop fixture
├── webhook/
│   ├── whatsapp.ts             # Meta Cloud API router (verify + message handler)
│   └── twilio.ts               # Twilio sandbox adapter (dev/testing)
├── conversation/
│   └── stateMachine.ts         # Full booking state machine (~1,500 lines)
├── integrations/easyrent/
│   ├── soapClient.ts           # Typed SOAP client with retry logic
│   └── restClient.ts           # Typed REST client with retry logic
├── i18n/
│   ├── index.ts                # t(language, key, vars) helper
│   ├── de.json                 # German strings
│   └── en.json                 # English strings
└── scripts/
    └── repl.ts                 # Local REPL for testing conversations without WhatsApp
```

**Database tables**

| Table | Purpose |
|---|---|
| `shops` | One row per tenant — WhatsApp and Easyrent credentials |
| `conversations` | Active and completed conversations (JSONB state) |
| `reservations` | Completed bookings linked to Easyrent codes |
| `processed_messages` | Dedup log for WhatsApp message IDs (pruned after 48h) |
| `message_queue` | Durable queue for async Easyrent API calls |

---

## Status

**Phase 1 — Complete**
- Full booking flow with all equipment categories
- Easyrent SOAP client (customer insert, reservation creation, availability)
- Easyrent REST client (branches, articles, calendar, reservations)
- Multi-tenant PostgreSQL schema
- German and English translations
- Local REPL for end-to-end testing

**Phase 2 — In progress**
- Pilot deployment with Riml Sports (Ötztal, Austria)
- Live Easyrent API connection (pending shop IT configuration)
- Italian translations
- Branch and pricing data from live Easyrent catalog

**Phase 3 — Planned**
- Admin dashboard (reservation history, conversation analytics)
- Shop management UI (onboarding, credential management)
- Docker + CI/CD pipeline
- Test suite

---

## Pilot

First commercial tenant: **Riml Sports**, a ski rental shop in the Ötztal valley, Austria. Reservations flow into their existing Easyrent installation — no change to their internal workflow.

---

## About

Built by [Nicolas de Prat Gay](https://github.com/nicolasdepratgay) — product and engineering, from zero to deployment.

Mogul is an independent project. Not affiliated with Easyrent or Meta.
