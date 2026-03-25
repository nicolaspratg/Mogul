/**
 * Twilio WhatsApp sandbox adapter.
 *
 * DISPOSABLE — delete this file and remove the /webhook-twilio mount from
 * index.ts once a production Meta app is approved and whatsapp.ts is live.
 *
 * Routes:
 *   POST /webhook-twilio/:shopId  — Incoming messages from Twilio sandbox
 *
 * Auth:
 *   Validates AccountSid in the form body matches TWILIO_ACCOUNT_SID in .env.
 *
 * Payload differences vs Meta Cloud API (whatsapp.ts):
 *   - Form-encoded body (application/x-www-form-urlencoded) instead of JSON
 *   - Fields: From (whatsapp:+xxx), Body, MessageSid, AccountSid
 *   - Send endpoint: Twilio REST API with Basic auth (AccountSid:AuthToken)
 */

import { Router, type Request, type Response } from 'express';
import { pool } from '../db/pool';
import { processMessage } from '../conversation/stateMachine';
import { config } from '../config';

export const twilioRouter = Router();

const MAX_WA_MESSAGE_LENGTH = 4096;

// ---------------------------------------------------------------------------
// Reset command (mirrors whatsapp.ts)
// ---------------------------------------------------------------------------

const RESET_KEYWORDS = new Set(['reset', 'neustart', 'ricominciare']);

function isResetCommand(text: string): boolean {
  return RESET_KEYWORDS.has(text.trim().toLowerCase());
}

async function resetConversation(shopId: string, waPhone: string): Promise<void> {
  await pool.query(
    `UPDATE conversations
     SET status = 'expired', updated_at = NOW()
     WHERE wa_phone = $1 AND shop_id = $2 AND status = 'active'`,
    [waPhone, shopId],
  );
}

// ---------------------------------------------------------------------------
// Message deduplication (mirrors whatsapp.ts)
// ---------------------------------------------------------------------------

async function isAlreadyProcessed(messageId: string): Promise<boolean> {
  const { rows } = await pool.query<{ message_id: string }>(
    `SELECT message_id FROM processed_messages WHERE message_id = $1`,
    [messageId],
  );
  return rows.length > 0;
}

async function markProcessed(messageId: string, shopId: string): Promise<void> {
  await pool.query(
    `INSERT INTO processed_messages (message_id, shop_id)
     VALUES ($1, $2)
     ON CONFLICT (message_id) DO NOTHING`,
    [messageId, shopId],
  );
}

// ---------------------------------------------------------------------------
// Send via Twilio REST API
// ---------------------------------------------------------------------------

function splitMessage(text: string): string[] {
  if (text.length <= MAX_WA_MESSAGE_LENGTH) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_WA_MESSAGE_LENGTH) {
    const chunk = remaining.slice(0, MAX_WA_MESSAGE_LENGTH);
    const lastNewline = chunk.lastIndexOf('\n');
    const cutAt = lastNewline > 0 ? lastNewline : MAX_WA_MESSAGE_LENGTH;
    parts.push(remaining.slice(0, cutAt).trimEnd());
    remaining = remaining.slice(cutAt).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

async function sendTwilioMessage(to: string, body: string): Promise<void> {
  const { twilioAccountSid, twilioAuthToken, twilioWhatsappFrom } = config;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Messages.json`;

  const params = new URLSearchParams({
    From: twilioWhatsappFrom!,
    To: `whatsapp:${to}`,
    Body: body,
  });

  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString('base64')}`,
      },
      body: params.toString(),
    });
  } catch (err) {
    console.error('[twilio] Network error sending message:', err);
    return;
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    console.error(`[twilio] API error ${response.status} sending to ${to}:`, errBody);
  }
}

async function sendReply(to: string, text: string): Promise<void> {
  const parts = splitMessage(text);
  for (const part of parts) {
    await sendTwilioMessage(to, part);
  }
}

// ---------------------------------------------------------------------------
// Incoming message handler
// ---------------------------------------------------------------------------

twilioRouter.post('/:shopId', async (req: Request, res: Response) => {
  const { shopId } = req.params;

  // 1. Acknowledge immediately
  res.status(200).send('');

  // 2. Validate credentials are configured
  if (!config.twilioAccountSid || !config.twilioAuthToken || !config.twilioWhatsappFrom) {
    console.warn('[twilio] Twilio env vars not set — ignoring incoming message');
    return;
  }

  // 3. Verify AccountSid matches
  const accountSid = req.body.AccountSid as string | undefined;
if (accountSid !== config.twilioAccountSid) {
    console.warn('[twilio] AccountSid mismatch for shop:', shopId);
    return;
  }

  // 4. Parse fields
  const rawFrom = req.body.From as string | undefined;   // "whatsapp:+1234567890"
  const incomingText = req.body.Body as string | undefined;
  const messageSid = req.body.MessageSid as string | undefined;

  if (!rawFrom || !incomingText || !messageSid) {
    console.warn('[twilio] Missing required fields in payload');
    return;
  }

  // Strip "whatsapp:" prefix for storage
  const waPhone = rawFrom.startsWith('whatsapp:') ? rawFrom.slice('whatsapp:'.length) : rawFrom;

  console.info(`[twilio] Message from ${waPhone} → shop ${shopId}: "${incomingText}"`);

  // 5. Deduplicate
  let alreadySeen: boolean;
  try {
    alreadySeen = await isAlreadyProcessed(messageSid);
  } catch (err) {
    console.error('[twilio] Error checking dedup:', messageSid, err);
    alreadySeen = false;
  }

  if (alreadySeen) {
    console.info(`[twilio] Duplicate message ${messageSid} — skipping`);
    return;
  }

  try {
    await markProcessed(messageSid, shopId);
  } catch (err) {
    console.warn('[twilio] Failed to mark message as processed:', messageSid, err);
  }

  // 6. Handle reset command
  if (isResetCommand(incomingText)) {
    try {
      await resetConversation(shopId, waPhone);
    } catch (err) {
      console.error('[twilio] Error resetting conversation:', err);
    }
  }

  // 7. Run the state machine
  let reply: string;
  try {
    reply = await processMessage(shopId, waPhone, isResetCommand(incomingText) ? '1' : incomingText);
  } catch (err) {
    console.error('[twilio] Unhandled state machine error:', err);
    reply = 'Sorry, something went wrong. Please try again.';
  }

  // 8. Send reply
  await sendReply(waPhone, reply);
});
