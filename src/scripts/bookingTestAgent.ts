/**
 * Mogul Booking Test Agent
 *
 * Drives full booking conversations through the state machine programmatically.
 * Validates every step transition, verifies the reservation lands in the DB,
 * and optionally hits the real Easyrent API.
 *
 * Usage:
 *   # Mock mode (no Easyrent calls):
 *   MOCK_EASYRENT=true npx tsx src/scripts/bookingTestAgent.ts
 *
 *   # Live mode (hits Easyrent test server):
 *   npx tsx src/scripts/bookingTestAgent.ts
 *
 *   # Run a specific scenario:
 *   npx tsx src/scripts/bookingTestAgent.ts --scenario adult-ski
 *
 *   # List available scenarios:
 *   npx tsx src/scripts/bookingTestAgent.ts --list
 *
 * Prerequisites:
 *   1. PostgreSQL running, schema migrated (npm run db:migrate)
 *   2. .env with DATABASE_URL + META_APP_SECRET + META_WEBHOOK_VERIFY_TOKEN
 *   3. A shop seeded (seed-test-shop.sql or seed-riml-sports.sql)
 */

import { pool } from '../db/pool';
import { processMessage } from '../conversation/stateMachine';
import { type BotReply, isButtonReply, isListReply, botReplyToText } from '../types/bot';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Step {
  /** What the simulated customer sends */
  input: string;
  /** Optional label for logs — describes what this step does */
  label?: string;
  /**
   * Optional assertion: substring the bot reply must contain.
   * If set and the reply doesn't contain it, the scenario fails.
   */
  expectContains?: string;
}

interface Scenario {
  name: string;
  description: string;
  language: 'en' | 'de';
  steps: Step[];
}

interface ScenarioResult {
  scenario: string;
  passed: boolean;
  steps: StepLog[];
  reservationCode?: string;
  error?: string;
  durationMs: number;
}

interface StepLog {
  index: number;
  label: string;
  input: string;
  replyPreview: string;
  passed: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Date helpers — generate future dates for bookings
// ---------------------------------------------------------------------------

function futureDate(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function buildScenarios(): Scenario[] {
  const dateFrom = futureDate(30);
  const dateTo = futureDate(35);

  return [
    {
      name: 'adult-ski-full',
      description: 'Adult skier: premium ski + economy boots + helmet with visor + insurance',
      language: 'en',
      steps: [
        { input: 'hi',          label: 'trigger welcome' },
        { input: '2',           label: 'select English' },
        { input: dateFrom,      label: 'check-in date' },
        { input: dateTo,        label: 'check-out date' },
        { input: 'John, Doe',   label: 'person name' },
        { input: '15.03.1990',  label: 'date of birth' },
        { input: '1',           label: 'gender: male' },
        { input: '1',           label: 'equipment: ski' },
        { input: '2',           label: 'skill: intermediate' },
        { input: '1',           label: 'need skis: yes' },
        { input: '3',           label: 'ski model: premium' },
        { input: '2',           label: 'own boots: no' },
        { input: '1',           label: 'boot type: premium' },
        { input: '1',           label: 'helmet: yes' },
        { input: '1',           label: 'helmet type: with visor' },
        { input: '180 75',      label: 'measurements' },
        { input: 'Hotel Edelweiss', label: 'hotel' },
        { input: '2',           label: 'add person: no' },
        { input: 'john@test.com', label: 'email' },
        { input: '-',           label: 'special requests: none' },
        { input: '1',           label: 'insurance: yes' },
        { input: '1',           label: 'confirm: yes', expectContains: 'MOCK' },
      ],
    },
    {
      name: 'adult-ski-minimal',
      description: 'Adult skier: no ski rental, no boots, no helmet, no insurance',
      language: 'en',
      steps: [
        { input: 'hi',          label: 'trigger welcome' },
        { input: '2',           label: 'select English' },
        { input: dateFrom,      label: 'check-in date' },
        { input: dateTo,        label: 'check-out date' },
        { input: 'Jane, Smith', label: 'person name' },
        { input: '22.07.1985',  label: 'date of birth' },
        { input: '2',           label: 'gender: female' },
        { input: '1',           label: 'equipment: ski' },
        { input: '1',           label: 'skill: beginner' },
        { input: '2',           label: 'need skis: no' },
        { input: '1',           label: 'own boots: yes' },
        { input: '2',           label: 'helmet: no' },
        { input: 'Hotel Alpine', label: 'hotel' },
        { input: '2',           label: 'add person: no' },
        { input: 'jane@test.com', label: 'email' },
        { input: 'none',        label: 'special requests: none' },
        { input: '2',           label: 'insurance: no' },
        { input: '1',           label: 'confirm: yes' },
      ],
    },
    {
      name: 'kid-ski',
      description: 'Child skier (age 10): kids ski + kids boots + helmet',
      language: 'de',
      steps: [
        { input: 'hallo',       label: 'trigger welcome' },
        { input: '1',           label: 'select Deutsch' },
        { input: dateFrom,      label: 'check-in date' },
        { input: dateTo,        label: 'check-out date' },
        { input: 'Max, Müller', label: 'person name' },
        { input: '10.06.2016',  label: 'DOB (kid, ~10 yrs)' },
        { input: '1',           label: 'gender: male' },
        { input: '1',           label: 'equipment: ski' },
        // Kids skip skill level, go straight to SKI_NEED
        { input: '1',           label: 'need skis: yes (auto kids_ski)' },
        { input: '2',           label: 'own boots: no (auto kids_boots)' },
        { input: '1',           label: 'helmet: yes' },
        { input: '2',           label: 'helmet type: without visor' },
        { input: '140 35',      label: 'measurements' },
        { input: 'Hotel Sonne', label: 'hotel' },
        { input: '2',           label: 'add person: no' },
        { input: 'parent@test.com', label: 'email' },
        { input: '-',           label: 'special requests: none' },
        { input: '1',           label: 'insurance: yes' },
        { input: '1',           label: 'confirm: yes' },
      ],
    },
    {
      name: 'adult-snowboard',
      description: 'Adult snowboarder: economy board + rental boots + no helmet',
      language: 'en',
      steps: [
        { input: 'hey',         label: 'trigger welcome' },
        { input: '2',           label: 'select English' },
        { input: dateFrom,      label: 'check-in date' },
        { input: dateTo,        label: 'check-out date' },
        { input: 'Alex, Turner', label: 'person name' },
        { input: '03.11.1995',  label: 'date of birth' },
        { input: '3',           label: 'gender: other' },
        { input: '2',           label: 'equipment: snowboard' },
        { input: '2',           label: 'snowboard model: economy' },
        { input: '2',           label: 'own boots: no (rental)' },
        { input: '2',           label: 'helmet: no' },
        { input: 'Chalet Bergblick', label: 'hotel' },
        { input: '2',           label: 'add person: no' },
        { input: 'alex@test.com', label: 'email' },
        { input: 'Late arrival after 18:00', label: 'special requests' },
        { input: '2',           label: 'insurance: no' },
        { input: '1',           label: 'confirm: yes' },
      ],
    },
    {
      name: 'family-group',
      description: '2-person group: adult ski + child ski, same hotel auto-applied',
      language: 'en',
      steps: [
        { input: 'hi',          label: 'trigger welcome' },
        { input: '2',           label: 'select English' },
        { input: dateFrom,      label: 'check-in date' },
        { input: dateTo,        label: 'check-out date' },
        // Person 1: adult
        { input: 'Maria, Garcia', label: 'P1 name' },
        { input: '12.04.1988',  label: 'P1 DOB (adult)' },
        { input: '2',           label: 'P1 gender: female' },
        { input: '1',           label: 'P1 equipment: ski' },
        { input: '3',           label: 'P1 skill: advanced' },
        { input: '1',           label: 'P1 need skis: yes' },
        { input: '1',           label: 'P1 ski model: factory test' },
        { input: '2',           label: 'P1 own boots: no' },
        { input: '2',           label: 'P1 boot type: economy' },
        { input: '2',           label: 'P1 helmet: no' },
        { input: '165 58',      label: 'P1 measurements' },
        { input: 'Hotel Alpenrose', label: 'P1 hotel' },
        { input: '1',           label: 'add person: yes' },
        // Person 2: child (hotel auto-filled, skips HOTEL step)
        { input: 'Sofia, Garcia', label: 'P2 name' },
        { input: '20.09.2017',  label: 'P2 DOB (kid, ~8 yrs)' },
        { input: '2',           label: 'P2 gender: female' },
        { input: '1',           label: 'P2 equipment: ski' },
        { input: '1',           label: 'P2 need skis: yes (auto kids_ski)' },
        { input: '2',           label: 'P2 own boots: no (auto kids_boots)' },
        { input: '1',           label: 'P2 helmet: yes' },
        { input: '2',           label: 'P2 helmet type: without visor' },
        { input: '130 28',      label: 'P2 measurements' },
        // Hotel is auto-applied from P1 → skips to ADD_PERSON
        { input: '2',           label: 'add person: no' },
        { input: 'maria@test.com', label: 'email' },
        { input: '-',           label: 'special requests: none' },
        { input: '1',           label: 'insurance: yes' },
        { input: '1',           label: 'confirm: yes' },
      ],
    },
    {
      name: 'xc-classic',
      description: 'Adult cross-country classic: XC ski + XC boots, no helmet',
      language: 'en',
      steps: [
        { input: 'hi',          label: 'trigger welcome' },
        { input: '2',           label: 'select English' },
        { input: dateFrom,      label: 'check-in date' },
        { input: dateTo,        label: 'check-out date' },
        { input: 'Lars, Eriksen', label: 'person name' },
        { input: '08.02.1978',  label: 'date of birth' },
        { input: '1',           label: 'gender: male' },
        { input: '3',           label: 'equipment: other' },
        { input: '2',           label: 'other: cross country' },
        { input: '1',           label: 'XC type: classic' },
        { input: '1',           label: 'XC boots: yes (rental)' },
        // XC goes straight to measurements (no helmet)
        { input: '185 82',      label: 'measurements' },
        { input: 'Pension Waldruh', label: 'hotel' },
        { input: '2',           label: 'add person: no' },
        { input: 'lars@test.com', label: 'email' },
        { input: '-',           label: 'special requests: none' },
        { input: '2',           label: 'insurance: no' },
        { input: '1',           label: 'confirm: yes' },
      ],
    },
    {
      name: 'touring-full',
      description: 'Adult touring: ski + boots + backpack + radar + helmet',
      language: 'en',
      steps: [
        { input: 'hi',          label: 'trigger welcome' },
        { input: '2',           label: 'select English' },
        { input: dateFrom,      label: 'check-in date' },
        { input: dateTo,        label: 'check-out date' },
        { input: 'Hans, Weber', label: 'person name' },
        { input: '25.11.1982',  label: 'date of birth' },
        { input: '1',           label: 'gender: male' },
        { input: '3',           label: 'equipment: other' },
        { input: '1',           label: 'other: touring' },
        { input: '1, 2, 3, 4', label: 'touring items: ski, boots, backpack, radar' },
        { input: '1',           label: 'helmet: yes' },
        { input: '1',           label: 'helmet type: with visor' },
        { input: '178 80',      label: 'measurements' },
        { input: 'Hotel Bergkristall', label: 'hotel' },
        { input: '2',           label: 'add person: no' },
        { input: 'hans@test.com', label: 'email' },
        { input: '-',           label: 'special requests: none' },
        { input: '1',           label: 'insurance: yes' },
        { input: '1',           label: 'confirm: yes' },
      ],
    },
    {
      name: 'misc-snowshoes',
      description: 'Adult snowshoes only: no helmet, no measurements',
      language: 'en',
      steps: [
        { input: 'hi',          label: 'trigger welcome' },
        { input: '2',           label: 'select English' },
        { input: dateFrom,      label: 'check-in date' },
        { input: dateTo,        label: 'check-out date' },
        { input: 'Emma, Fischer', label: 'person name' },
        { input: '14.06.1992',  label: 'date of birth' },
        { input: '2',           label: 'gender: female' },
        { input: '3',           label: 'equipment: other' },
        { input: '3',           label: 'other: misc' },
        { input: '1',           label: 'misc: snowshoes' },
        // Misc: no helmet, no measurements → straight to hotel
        { input: 'Gasthof Stern', label: 'hotel' },
        { input: '2',           label: 'add person: no' },
        { input: 'emma@test.com', label: 'email' },
        { input: '-',           label: 'special requests: none' },
        { input: '2',           label: 'insurance: no' },
        { input: '1',           label: 'confirm: yes' },
      ],
    },
    {
      name: 'cancel-booking',
      description: 'Full flow through to CONFIRM, then cancel — verifies abandonment path',
      language: 'en',
      steps: [
        { input: 'hi',          label: 'trigger welcome' },
        { input: '2',           label: 'select English' },
        { input: dateFrom,      label: 'check-in date' },
        { input: dateTo,        label: 'check-out date' },
        { input: 'Test, Cancel', label: 'person name' },
        { input: '01.01.2000',  label: 'date of birth' },
        { input: '1',           label: 'gender: male' },
        { input: '2',           label: 'equipment: snowboard' },
        { input: '1',           label: 'snowboard model: premium' },
        { input: '1',           label: 'own boots: yes' },
        { input: '2',           label: 'helmet: no' },
        { input: 'Test Hotel',  label: 'hotel' },
        { input: '2',           label: 'add person: no' },
        { input: 'cancel@test.com', label: 'email' },
        { input: '-',           label: 'special requests: none' },
        { input: '2',           label: 'insurance: no' },
        { input: '2',           label: 'confirm: NO (cancel)', expectContains: 'cancel' },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

const FAKE_PHONE_PREFIX = '+1000000';
let phoneCounter = 1;

function nextPhone(): string {
  return `${FAKE_PHONE_PREFIX}${String(phoneCounter++).padStart(4, '0')}`;
}

async function getTestShopId(): Promise<string> {
  const fromEnv = process.env.TEST_SHOP_ID;
  if (fromEnv) return fromEnv;

  const { rows } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM shops WHERE active = true ORDER BY created_at ASC LIMIT 1`,
  );

  if (!rows[0]) {
    console.error(
      '\n[agent] No active shop found.\n' +
      'Run: psql "$DATABASE_URL" -f src/db/seed-test-shop.sql\n',
    );
    process.exit(1);
  }

  return rows[0].id;
}

function replyText(reply: BotReply): string {
  return botReplyToText(reply);
}

function replyPreview(reply: BotReply): string {
  const text = replyText(reply);
  if (text.length <= 120) return text.replace(/\n/g, ' ↵ ');
  return text.slice(0, 117).replace(/\n/g, ' ↵ ') + '...';
}

async function expireConversation(shopId: string, phone: string): Promise<void> {
  await pool.query(
    `UPDATE conversations SET status = 'expired' WHERE wa_phone = $1 AND shop_id = $2 AND status = 'active'`,
    [phone, shopId],
  );
}

async function getReservation(shopId: string, phone: string): Promise<{ code: string; status: string } | null> {
  const { rows } = await pool.query<{ easyrent_reservation_code: string; status: string }>(
    `SELECT r.easyrent_reservation_code, r.status
     FROM reservations r
     JOIN conversations c ON c.id = r.conversation_id
     WHERE c.wa_phone = $1 AND c.shop_id = $2
     ORDER BY r.created_at DESC LIMIT 1`,
    [phone, shopId],
  );
  if (!rows[0]) return null;
  return { code: rows[0].easyrent_reservation_code, status: rows[0].status };
}

async function runScenario(scenario: Scenario, shopId: string): Promise<ScenarioResult> {
  const phone = nextPhone();
  const stepLogs: StepLog[] = [];
  const start = Date.now();

  // Clean slate
  await expireConversation(shopId, phone);

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i];
    const label = step.label ?? `step ${i}`;

    let reply: BotReply;
    try {
      reply = await processMessage(shopId, phone, step.input);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      stepLogs.push({ index: i, label, input: step.input, replyPreview: '', passed: false, error });
      return {
        scenario: scenario.name,
        passed: false,
        steps: stepLogs,
        error: `Step ${i} (${label}) threw: ${error}`,
        durationMs: Date.now() - start,
      };
    }

    const preview = replyPreview(reply);
    let passed = true;
    let error: string | undefined;

    if (step.expectContains) {
      const text = replyText(reply).toLowerCase();
      if (!text.includes(step.expectContains.toLowerCase())) {
        passed = false;
        error = `Expected reply to contain "${step.expectContains}"`;
      }
    }

    stepLogs.push({ index: i, label, input: step.input, replyPreview: preview, passed, error });

    if (!passed) {
      return {
        scenario: scenario.name,
        passed: false,
        steps: stepLogs,
        error: `Assertion failed at step ${i} (${label}): ${error}`,
        durationMs: Date.now() - start,
      };
    }
  }

  // Check reservation in DB (unless cancel scenario)
  let reservationCode: string | undefined;
  if (!scenario.name.includes('cancel')) {
    const reservation = await getReservation(shopId, phone);
    if (reservation) {
      reservationCode = reservation.code;
    }
  }

  return {
    scenario: scenario.name,
    passed: true,
    steps: stepLogs,
    reservationCode,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatResult(result: ScenarioResult, verbose: boolean): string {
  const icon = result.passed ? '✓' : '✗';
  const header = `${icon} ${result.scenario} (${result.durationMs}ms)`;

  if (!verbose && result.passed) {
    const extra = result.reservationCode ? ` → reservation: ${result.reservationCode}` : '';
    return `  ${header}${extra}`;
  }

  const lines = [header];
  for (const step of result.steps) {
    const stepIcon = step.passed ? '  ·' : '  ✗';
    lines.push(`${stepIcon} [${step.index}] ${step.label}: "${step.input}" → ${step.replyPreview}`);
    if (step.error) {
      lines.push(`      ERROR: ${step.error}`);
    }
  }
  if (result.reservationCode) {
    lines.push(`  → reservation: ${result.reservationCode}`);
  }
  if (result.error) {
    lines.push(`  FAILED: ${result.error}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const listMode = args.includes('--list');
  const verbose = args.includes('--verbose') || args.includes('-v');
  const scenarioFilter = args.find((_, i) => args[i - 1] === '--scenario');

  const allScenarios = buildScenarios();

  if (listMode) {
    console.log('\nAvailable scenarios:\n');
    for (const s of allScenarios) {
      console.log(`  ${s.name.padEnd(22)} ${s.description}`);
    }
    console.log(`\nRun one: npx tsx src/scripts/bookingTestAgent.ts --scenario ${allScenarios[0].name}`);
    console.log('Run all: npx tsx src/scripts/bookingTestAgent.ts\n');
    process.exit(0);
  }

  const scenarios = scenarioFilter
    ? allScenarios.filter(s => s.name === scenarioFilter)
    : allScenarios;

  if (scenarios.length === 0) {
    console.error(`\nUnknown scenario: "${scenarioFilter}"\nUse --list to see available scenarios.\n`);
    process.exit(1);
  }

  const shopId = await getTestShopId();
  const { rows: shopRows } = await pool.query<{ name: string }>(
    `SELECT name FROM shops WHERE id = $1`, [shopId],
  );
  const shopName = shopRows[0]?.name ?? shopId;

  const isMock = process.env.MOCK_EASYRENT === 'true';

  console.log('\n' + '═'.repeat(60));
  console.log('  Mogul Booking Test Agent');
  console.log('═'.repeat(60));
  console.log(`  Shop:       ${shopName} (${shopId})`);
  console.log(`  Easyrent:   ${isMock ? 'MOCK (no API calls)' : 'LIVE'}`);
  console.log(`  Scenarios:  ${scenarios.length}`);
  console.log('─'.repeat(60) + '\n');

  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    process.stdout.write(`  Running: ${scenario.name}...`);
    const result = await runScenario(scenario, shopId);
    results.push(result);

    // Clear the "Running:" line and print result
    process.stdout.write('\r' + ' '.repeat(60) + '\r');
    console.log(formatResult(result, verbose || !result.passed));
  }

  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log('\n' + '─'.repeat(60));
  console.log(`  Results: ${passed} passed, ${failed} failed, ${results.length} total`);

  if (failed > 0) {
    console.log('\n  Failed scenarios:');
    for (const r of results.filter(r => !r.passed)) {
      console.log(`    - ${r.scenario}: ${r.error}`);
    }
  }

  console.log('═'.repeat(60) + '\n');

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[agent] Fatal:', err);
  process.exit(1);
});
