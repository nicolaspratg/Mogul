/**
 * Mogul conversation REPL — local testing without WhatsApp or Easyrent.
 *
 * Usage:
 *   npx tsx src/scripts/repl.ts
 *
 * Prerequisites:
 *   1. PostgreSQL running locally
 *   2. .env file present (DATABASE_URL + dummy Meta values)
 *   3. Schema migrated: npm run db:migrate
 *   4. Test shop seeded: psql "$DATABASE_URL" -f src/db/seed-test-shop.sql
 *   5. MOCK_EASYRENT=true in .env (skips real Easyrent API at confirmation)
 *
 * The REPL simulates a single customer conversation from start to finish.
 * Type Ctrl+C to quit at any time.
 */

import * as readline from 'readline';
import { pool } from '../db/pool';
import { processMessage } from '../conversation/stateMachine';

const FAKE_PHONE = '+10000000001';

async function getTestShopId(): Promise<string> {
  const fromEnv = process.env.TEST_SHOP_ID;
  if (fromEnv) return fromEnv;

  const { rows } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM shops WHERE active = true ORDER BY created_at ASC LIMIT 1`,
  );

  if (!rows[0]) {
    console.error(
      '\n[repl] No active shop found.\n' +
      'Run: psql "$DATABASE_URL" -f src/db/seed-test-shop.sql\n',
    );
    process.exit(1);
  }

  console.log(`[repl] Using shop: "${rows[0].name}" (${rows[0].id})`);
  return rows[0].id;
}

async function resetConversation(shopId: string): Promise<void> {
  await pool.query(
    `UPDATE conversations
     SET status = 'expired', updated_at = NOW()
     WHERE wa_phone = $1 AND shop_id = $2 AND status = 'active'`,
    [FAKE_PHONE, shopId],
  );
}

async function main(): Promise<void> {
  process.on('SIGINT', async () => {
    console.log('\n[repl] Bye.');
    await pool.end();
    process.exit(0);
  });

  const shopId = await getTestShopId();

  // Wipe any leftover conversation from a previous run
  await resetConversation(shopId);

  console.log('\n' + '─'.repeat(60));
  console.log('  Mogul REPL  — type your messages, Ctrl+C to quit');
  console.log('─'.repeat(60));
  console.log('\n  Start with:  1 (Deutsch)  or  2 (English)\n');

  const rl = readline.createInterface({ input: process.stdin });

  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;

    let reply: string;
    try {
      reply = await processMessage(shopId, FAKE_PHONE, text);
    } catch (err) {
      console.error('[repl] processMessage threw:', err);
      continue;
    }

    console.log('\nBot:\n' + reply + '\n');
  }

  await pool.end();
}

main().catch((err) => {
  console.error('[repl] Fatal:', err);
  process.exit(1);
});
