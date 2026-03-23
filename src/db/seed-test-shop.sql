-- Seed a test shop for local REPL testing.
-- Run once after migrating the schema:
--   psql "$DATABASE_URL" -f src/db/seed-test-shop.sql

INSERT INTO shops (
  name,
  whatsapp_number,
  whatsapp_phone_number_id,
  whatsapp_token,
  easyrent_host,
  easyrent_soap_url,
  easyrent_rest_base_url,
  easyrent_accessid,
  easyrent_branchid,
  languages
) VALUES (
  'Test Ski Shop',
  '+43000000000',
  'mock_phone_number_id',
  'mock_whatsapp_token',
  'localhost',
  'http://localhost/soap',
  'http://localhost/easyrest/rest',
  'mock_access_id',
  1,
  ARRAY['de','en']
)
ON CONFLICT (whatsapp_number) DO NOTHING
RETURNING id, name;
