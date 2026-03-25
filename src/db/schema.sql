-- Mogul PostgreSQL schema
-- Requires: pgcrypto (for gen_random_uuid) or PostgreSQL 13+ (uuid_generate_v4 via extension)
-- Run once on a fresh database. Idempotent: uses IF NOT EXISTS throughout.

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- shops
-- One row per tenant (ski rental shop).
-- Each shop has its own WhatsApp number and Easyrent credentials.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS shops (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    TEXT        NOT NULL,
  whatsapp_number         TEXT        NOT NULL UNIQUE,   -- E.164, e.g. "+43123456789"
  whatsapp_phone_number_id TEXT       NOT NULL,           -- Meta phone number ID (from Graph API, not the E.164 number)
  whatsapp_token          TEXT        NOT NULL,           -- Meta Cloud API access token
  easyrent_host           TEXT        NOT NULL,           -- e.g. "shop.easyrent.at"
  easyrent_soap_url       TEXT        NOT NULL,           -- full WSDL/endpoint URL
  easyrent_rest_base_url  TEXT        NOT NULL,           -- e.g. "http://shop.easyrent.at/easyrest/rest"
  easyrent_accessid       TEXT        NOT NULL,           -- ScanCode credential from Easyrent Maintenance
  easyrent_branchid       INTEGER     NOT NULL,           -- er_branchid used in availability calls
  languages               TEXT[]      NOT NULL DEFAULT ARRAY['de','en'],
  active                  BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- conversations
-- One row per active customer conversation.
-- All collected state lives in the `data` jsonb column (ConversationData).
-- Conversations expire after 24 h of inactivity (sliding window TTL).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS conversations (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         UUID        NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  wa_phone        VARCHAR(32) NOT NULL,   -- customer's WhatsApp number (E.164)
  step            VARCHAR(64) NOT NULL DEFAULT 'welcome',
  language        VARCHAR(2)  NOT NULL DEFAULT 'de',
  data            JSONB       NOT NULL DEFAULT '{}',
  status          VARCHAR(32) NOT NULL DEFAULT 'active',
  -- status values: 'active' | 'completed' | 'expired' | 'abandoned'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

-- Fast lookup: find the active conversation for a customer on a given shop.
-- Used on every inbound WhatsApp message.
CREATE INDEX IF NOT EXISTS idx_conversations_phone_shop
  ON conversations (wa_phone, shop_id);

-- Used by the cleanup job to find and mark expired conversations.
CREATE INDEX IF NOT EXISTS idx_conversations_expires_at
  ON conversations (expires_at)
  WHERE status = 'active';

-- Used when fetching conversation history per shop (admin, Phase 3).
CREATE INDEX IF NOT EXISTS idx_conversations_shop_id
  ON conversations (shop_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- reservations
-- One row per completed reservation (Step 9).
-- Links back to the conversation that created it and stores Easyrent codes.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reservations (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                     UUID        NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  conversation_id             UUID        NOT NULL REFERENCES conversations(id) ON DELETE SET NULL,
  easyrent_customer_code      VARCHAR(64),
  easyrent_group_code         VARCHAR(64),
  easyrent_reservation_code   VARCHAR(64),
  status                      VARCHAR(32) NOT NULL DEFAULT 'pending',
  -- status values: 'pending' | 'confirmed' | 'failed' | 'cancelled'
  data                        JSONB       NOT NULL DEFAULT '{}',
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup by shop for reporting / admin (Phase 3).
CREATE INDEX IF NOT EXISTS idx_reservations_shop_id
  ON reservations (shop_id, created_at DESC);

-- Lookup by Easyrent reservation code (e.g. for verification in Step 9).
CREATE INDEX IF NOT EXISTS idx_reservations_easyrent_code
  ON reservations (easyrent_reservation_code)
  WHERE easyrent_reservation_code IS NOT NULL;

-- ---------------------------------------------------------------------------
-- processed_messages
-- Tracks WhatsApp message IDs that have already been processed.
-- Prevents duplicate processing when Meta retries webhook delivery.
-- Rows older than 48 h can be pruned by the cleanup job.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS processed_messages (
  message_id  TEXT        PRIMARY KEY,
  shop_id     UUID        NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Used by the cleanup job to prune old dedup records.
CREATE INDEX IF NOT EXISTS idx_processed_messages_received_at
  ON processed_messages (received_at);

-- ---------------------------------------------------------------------------
-- message_queue
-- Durable queue for Easyrent API calls.
-- Processed by the app-level queue runner with retry (3 attempts,
-- exponential backoff). Failed jobs remain in the table for inspection.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS message_queue (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         UUID        NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  type            VARCHAR(64) NOT NULL,   -- e.g. 'soap:insertcustomerv2', 'rest:insertupdatereservation'
  payload         JSONB       NOT NULL DEFAULT '{}',
  attempts        INTEGER     NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  status          VARCHAR(32) NOT NULL DEFAULT 'pending',
  -- status values: 'pending' | 'processing' | 'done' | 'failed'
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary queue worker query: next pending jobs, oldest first.
CREATE INDEX IF NOT EXISTS idx_message_queue_status_created
  ON message_queue (status, created_at ASC)
  WHERE status IN ('pending', 'processing');

-- Lookup all jobs for a shop (debugging, admin).
CREATE INDEX IF NOT EXISTS idx_message_queue_shop_id
  ON message_queue (shop_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Triggers: keep conversations.updated_at current automatically.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversations_updated_at ON conversations;
CREATE TRIGGER trg_conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Cleanup helper: mark expired conversations.
-- Call this from pg_cron or an app-level interval (e.g. every 15 minutes).
--
--   SELECT expire_stale_conversations();
--
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION expire_stale_conversations()
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  rows_updated INTEGER;
BEGIN
  UPDATE conversations
  SET    status = 'expired'
  WHERE  status = 'active'
    AND  expires_at < NOW();

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated;
END;
$$;
