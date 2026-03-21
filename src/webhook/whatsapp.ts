/**
 * WhatsApp Cloud API webhook router.
 *
 * Routes:
 *   GET  /webhook/:shopId  — Meta verification challenge (webhook registration)
 *   POST /webhook/:shopId  — Incoming messages
 *
 * Security:
 *   - POST requests are verified via X-Hub-Signature-256 (HMAC-SHA256 of the raw body).
 *   - GET verification uses hub.verify_token matched against META_WEBHOOK_VERIFY_TOKEN.
 *
 * Reliability:
 *   - Always returns HTTP 200 to Meta, even on processing errors.
 *     Meta will retry delivery if it receives a non-200, causing duplicate processing.
 *   - Easyrent errors never surface to the HTTP layer — they produce user-friendly
 *     error messages sent back over WhatsApp.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { config } from '../config';
import { processMessage } from '../conversation/stateMachine';

export const whatsappRouter = Router();

// ---------------------------------------------------------------------------
// Meta verification challenge (GET)
// ---------------------------------------------------------------------------

whatsappRouter.get('/:shopId', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.metaWebhookVerifyToken) {
    console.info('[webhook] Meta verification challenge accepted for shop:', req.params.shopId);
    res.status(200).send(String(challenge));
    return;
  }

  console.warn('[webhook] Meta verification challenge failed — token mismatch');
  res.status(403).json({ error: 'Forbidden' });
});

// ---------------------------------------------------------------------------
// Signature verification helper
// ---------------------------------------------------------------------------

/**
 * Verify the X-Hub-Signature-256 header against the raw request body.
 * Uses constant-time comparison to prevent timing attacks.
 */
function verifySignature(rawBody: Buffer, signatureHeader: string): boolean {
  if (!signatureHeader.startsWith('sha256=')) return false;

  const receivedHex = signatureHeader.slice('sha256='.length);
  const expectedHex = createHmac('sha256', config.metaAppSecret)
    .update(rawBody)
    .digest('hex');

  try {
    return timingSafeEqual(
      Buffer.from(receivedHex, 'hex'),
      Buffer.from(expectedHex, 'hex'),
    );
  } catch {
    // Buffer lengths differ — signatures don't match
    return false;
  }
}

// ---------------------------------------------------------------------------
// Meta message types
// ---------------------------------------------------------------------------

interface MetaTextMessage {
  from: string;       // sender's WhatsApp number
  id: string;         // message ID
  timestamp: string;
  type: 'text';
  text: { body: string };
}

interface MetaWebhookEntry {
  id: string;
  changes: Array<{
    value: {
      messaging_product: 'whatsapp';
      metadata: {
        display_phone_number: string;
        phone_number_id: string;
      };
      contacts?: Array<{ profile: { name: string }; wa_id: string }>;
      messages?: MetaTextMessage[];
    };
    field: string;
  }>;
}

interface MetaWebhookPayload {
  object: string;
  entry: MetaWebhookEntry[];
}

// ---------------------------------------------------------------------------
// Send a WhatsApp message via Meta Cloud API
// ---------------------------------------------------------------------------

/**
 * Send a text message back to a WhatsApp user.
 *
 * @param phoneNumberId  Meta phone number ID of the receiving shop (from shops.whatsapp_phone_number_id)
 * @param token          Meta Cloud API access token for this shop
 * @param to             Recipient phone number (E.164)
 * @param text           Message body
 */
async function sendWhatsAppMessage(
  phoneNumberId: string,
  token: string,
  to: string,
  text: string,
): Promise<void> {
  const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(phoneNumberId)}/messages`;

  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  };

  let response: Response;
  try {
    // Using global fetch (Node 18+)
    response = await (fetch as typeof globalThis.fetch)(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('[webhook] Network error sending WhatsApp message:', err);
    return;
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    console.error(
      `[webhook] Meta API error ${response.status} sending to ${to}:`,
      errBody,
    );
  }
}

// ---------------------------------------------------------------------------
// Fetch shop WhatsApp credentials from DB (phone_number_id + token)
// ---------------------------------------------------------------------------

import { pool } from '../db/pool';

interface ShopWhatsappCreds {
  whatsapp_phone_number_id: string;
  whatsapp_token: string;
}

async function loadShopCreds(shopId: string): Promise<ShopWhatsappCreds | null> {
  const { rows } = await pool.query<ShopWhatsappCreds>(
    `SELECT whatsapp_phone_number_id, whatsapp_token
     FROM shops WHERE id = $1 AND active = true`,
    [shopId],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Incoming message handler (POST)
// ---------------------------------------------------------------------------

// express.raw() is applied in index.ts for this router.
// By the time this handler runs, req.body is a Buffer.
whatsappRouter.post('/:shopId', async (req: Request, res: Response) => {
  const { shopId } = req.params;

  // 1. Acknowledge immediately — Meta expects 200 within ~20 s
  res.status(200).json({ status: 'ok' });

  // 2. Verify signature
  const rawBody = req.body as Buffer;
  const sigHeader = req.headers['x-hub-signature-256'];

  if (typeof sigHeader !== 'string' || !verifySignature(rawBody, sigHeader)) {
    console.warn('[webhook] Invalid or missing X-Hub-Signature-256 for shop:', shopId);
    return; // Already responded 200 — do not process
  }

  // 3. Parse body
  let payload: MetaWebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as MetaWebhookPayload;
  } catch {
    console.warn('[webhook] Failed to parse JSON body for shop:', shopId);
    return;
  }

  // Meta sometimes sends non-message notifications (e.g. status updates)
  if (payload.object !== 'whatsapp_business_account') return;

  // 4. Load shop WhatsApp credentials
  let shopCreds: ShopWhatsappCreds | null;
  try {
    shopCreds = await loadShopCreds(shopId);
  } catch (err) {
    console.error('[webhook] DB error loading shop creds:', err);
    return;
  }

  if (!shopCreds) {
    console.warn('[webhook] Shop not found or inactive:', shopId);
    return;
  }

  // 5. Process each message in the payload
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;

      const messages = change.value.messages ?? [];

      for (const message of messages) {
        if (message.type !== 'text') {
          // Non-text messages (images, audio, etc.) — ignore for now
          console.info(
            `[webhook] Ignoring non-text message type "${message.type}" from ${message.from}`,
          );
          continue;
        }

        const waPhone = message.from;
        const incomingText = message.text.body;

        console.info(
          `[webhook] Message from ${waPhone} → shop ${shopId}: "${incomingText}"`,
        );

        // 6. Run the state machine
        let reply: string;
        try {
          reply = await processMessage(shopId, waPhone, incomingText);
        } catch (err) {
          console.error('[webhook] Unhandled state machine error:', err);
          reply = 'An unexpected error occurred. Please try again.';
        }

        // 7. Send reply
        await sendWhatsAppMessage(
          shopCreds.whatsapp_phone_number_id,
          shopCreds.whatsapp_token,
          waPhone,
          reply,
        );
      }
    }
  }
});
