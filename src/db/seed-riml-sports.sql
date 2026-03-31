-- Seed Riml Sports shop.
-- Run once after migrating the schema:
--   psql "$DATABASE_URL" -f src/db/seed-riml-sports.sql
--
-- TODOs before going live:
--   - Replace easyrent_branchid (currently placeholder 1) with real value from GET /branches
--   - Replace whatsapp_* fields with real Meta credentials

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
  'Riml Sports',
  'TODO_whatsapp_number',
  'TODO_whatsapp_phone_number_id',
  'TODO_whatsapp_token',
  '83.218.162.16',
  'http://83.218.162.16:11122/wsa/wsa1/wsdl?targetURI=urn:wseasyrent',
  'http://83.218.162.16:11122/easyrest/rest',
  'bG2wLPacN#',
  1,
  ARRAY['de','en']
)
ON CONFLICT (whatsapp_number) DO NOTHING
RETURNING id, name;
