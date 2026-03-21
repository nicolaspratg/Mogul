/**
 * Typed REST client for Easyrent easyrest/rest API.
 *
 * Each exported function wraps one REST endpoint with:
 *  - Typed inputs/outputs (from src/types/easyrent.ts)
 *  - Retry logic (3 attempts, exponential backoff)
 *  - Structured timing logs
 *  - EasyrentError on failure (never throws raw fetch/HTTP errors)
 *
 * Param naming exactly matches the API per-endpoint (accessId / access_id / accessid).
 */

import {
  EasyrentError,
  type RestReservableArticle,
  type RestGetAvailData,
  type RestGetAvailResult,
  type RestEquipmentType,
  type RestRentalGroup,
  type RestCalendarAvailability,
  type RestBranch,
  type RestCustomer,
  type RestCustomersParams,
  type RestRentalArticle,
  type RestRentalArticlesParams,
  type RestReservationBody,
  type RestReservationResponse,
  type RestBasketBody,
  type RestReservationLookup,
} from '../../types/easyrent';
import type { ShopEasyrentConfig } from './soapClient';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` up to `maxAttempts` times with exponential backoff.
 * Wraps the final error in EasyrentError.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  context: string,
  maxAttempts = 3,
  baseDelayMs = 500,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const start = Date.now();
    try {
      const result = await fn();
      console.info(
        `[rest] ${context} ok — ${Date.now() - start}ms (attempt ${attempt})`,
      );
      return result;
    } catch (err) {
      lastError = err;
      console.warn(
        `[rest] ${context} failed — ${Date.now() - start}ms (attempt ${attempt}/${maxAttempts}):`,
        err instanceof Error ? err.message : err,
      );
      if (attempt < maxAttempts) {
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  throw new EasyrentError(
    'REST_ERROR',
    `${context} failed after ${maxAttempts} attempts`,
    lastError,
  );
}

/**
 * Execute a fetch request and parse the JSON response.
 * Throws EasyrentError on non-2xx status or network failure.
 */
async function fetchJson<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.headers ?? {}),
      },
    });
  } catch (err) {
    throw new EasyrentError('NETWORK_ERROR', `Fetch failed for ${url}`, err);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new EasyrentError(
      response.status,
      `HTTP ${response.status} from ${url}: ${body}`,
    );
  }

  const json = (await response.json()) as T;
  return json;
}

/** Append query params to a base URL, omitting undefined/null values. */
function buildUrl(
  base: string,
  params: Record<string, string | number | boolean | undefined | null>,
): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Phase 1 endpoints
// ---------------------------------------------------------------------------

/**
 * GET /aliveserver — lightweight health/connectivity check.
 * Use at startup alongside testmethod to verify REST reachability.
 */
export async function restGetAliveServer(
  shopConfig: ShopEasyrentConfig,
): Promise<void> {
  return withRetry(async () => {
    const url = buildUrl(`${shopConfig.restBaseUrl}/aliveserver`, {
      accessId: shopConfig.accessId,
    });
    await fetchJson<unknown>(url);
  }, 'GET /aliveserver');
}

/**
 * GET /testaccess — connection test with configurable test type.
 */
export async function restTestAccess(
  shopConfig: ShopEasyrentConfig,
  testType?: string,
): Promise<unknown> {
  return withRetry(async () => {
    const url = buildUrl(`${shopConfig.restBaseUrl}/testaccess`, {
      accessId: shopConfig.accessId,
      testType,
    });
    return fetchJson<unknown>(url);
  }, 'GET /testaccess');
}

/**
 * GET /reservation/reservablearticles — list equipment types available for reservation.
 */
export async function restGetReservableArticles(
  shopConfig: ShopEasyrentConfig,
): Promise<RestReservableArticle[]> {
  return withRetry(async () => {
    const url = buildUrl(
      `${shopConfig.restBaseUrl}/reservation/reservablearticles`,
      { accessId: shopConfig.accessId },
    );
    return fetchJson<RestReservableArticle[]>(url);
  }, 'GET /reservation/reservablearticles');
}

/**
 * POST /reservation/getavailcount — check equipment availability for given date
 * ranges and rental groups.
 *
 * NOTE: This is called after the user selects equipment type (Step 4), not
 * Step 3, because er_rentalgroupid is required and only known after Step 4.
 * The spec maps this to Step 3 but without a rental group ID, a specific check
 * is not possible — see TODO in stateMachine.ts.
 */
export async function restGetAvailCount(
  shopConfig: ShopEasyrentConfig,
  getavailData: RestGetAvailData[],
): Promise<RestGetAvailResult[]> {
  return withRetry(async () => {
    const url = buildUrl(
      `${shopConfig.restBaseUrl}/reservation/getavailcount`,
      { accessId: shopConfig.accessId },
    );
    return fetchJson<RestGetAvailResult[]>(url, {
      method: 'POST',
      body: JSON.stringify(getavailData),
    });
  }, 'POST /reservation/getavailcount');
}

/**
 * POST /reservation/getavailcountdt — availability check variant.
 * Likely datetime-granular; confirm differences vs getavailcount during live testing.
 */
export async function restGetAvailCountDt(
  shopConfig: ShopEasyrentConfig,
  getavailData: RestGetAvailData[],
): Promise<RestGetAvailResult[]> {
  return withRetry(async () => {
    const url = buildUrl(
      `${shopConfig.restBaseUrl}/reservation/getavailcountdt`,
      { accessId: shopConfig.accessId },
    );
    return fetchJson<RestGetAvailResult[]>(url, {
      method: 'POST',
      body: JSON.stringify(getavailData),
    });
  }, 'POST /reservation/getavailcountdt');
}

/**
 * POST /reservation/insertupdatereservation — create or update a reservation.
 * This is the key Step 9 endpoint that returns the reservation code.
 *
 * TODO: The exact body structure for `reservationData` is NOT YET CONFIRMED.
 * It must be validated against a live Easyrent instance before this function
 * is used in production. The current body type (RestReservationBody) is a
 * typed placeholder based on the SOAP API and Easyrent data model.
 *
 * Also investigate the possible two-step basket flow:
 *   PUT /reservation/basket/{basketid}  →  confirm  →  reservation code
 * See restCreateBasket / restDeleteBasket stubs below.
 */
export async function restInsertUpdateReservation(
  shopConfig: ShopEasyrentConfig,
  reservationData: RestReservationBody,
): Promise<RestReservationResponse> {
  return withRetry(async () => {
    const url = buildUrl(
      `${shopConfig.restBaseUrl}/reservation/insertupdatereservation`,
      { accessId: shopConfig.accessId },
    );
    return fetchJson<RestReservationResponse>(url, {
      method: 'POST',
      body: JSON.stringify(reservationData),
    });
  }, 'POST /reservation/insertupdatereservation');
}

/**
 * GET /isatde/reservation — look up an existing reservation.
 * Used after Step 9 to verify the reservation was successfully created.
 */
export async function restGetIsatReservation(
  shopConfig: ShopEasyrentConfig,
  params: {
    reservationIdExternal?: string;
    branchId?: number;
    firstName?: string;
    lastName?: string;
  },
): Promise<RestReservationLookup> {
  return withRetry(async () => {
    const url = buildUrl(`${shopConfig.restBaseUrl}/isatde/reservation`, {
      accessId: shopConfig.accessId,
      ...params,
    });
    return fetchJson<RestReservationLookup>(url);
  }, 'GET /isatde/reservation');
}

/**
 * GET /calendar/getEquipmentTypes — list equipment types with IDs.
 */
export async function restGetEquipmentTypes(
  shopConfig: ShopEasyrentConfig,
): Promise<RestEquipmentType[]> {
  return withRetry(async () => {
    const url = buildUrl(`${shopConfig.restBaseUrl}/calendar/getEquipmentTypes`, {
      accessId: shopConfig.accessId,
    });
    return fetchJson<RestEquipmentType[]>(url);
  }, 'GET /calendar/getEquipmentTypes');
}

/**
 * GET /calendar/getRentalGroups — list rental groups with IDs.
 * Used in Step 4 to map ski/snowboard/both to er_rentalgroupid values.
 */
export async function restGetRentalGroups(
  shopConfig: ShopEasyrentConfig,
): Promise<RestRentalGroup[]> {
  return withRetry(async () => {
    const url = buildUrl(`${shopConfig.restBaseUrl}/calendar/getRentalGroups`, {
      accessId: shopConfig.accessId,
    });
    return fetchJson<RestRentalGroup[]>(url);
  }, 'GET /calendar/getRentalGroups');
}

/**
 * POST /calendar/getAvailability — calendar-style availability check.
 */
export async function restGetCalendarAvailability(
  shopConfig: ShopEasyrentConfig,
  requestBody: Record<string, unknown>,
): Promise<RestCalendarAvailability> {
  return withRetry(async () => {
    const url = buildUrl(`${shopConfig.restBaseUrl}/calendar/getAvailability`, {
      accessId: shopConfig.accessId,
    });
    return fetchJson<RestCalendarAvailability>(url, {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });
  }, 'POST /calendar/getAvailability');
}

/**
 * GET /customers — search customers (REST, paginated via top/skip).
 */
export async function restGetCustomers(
  shopConfig: ShopEasyrentConfig,
  params: Omit<RestCustomersParams, 'accessId'>,
): Promise<RestCustomer[]> {
  return withRetry(async () => {
    const url = buildUrl(`${shopConfig.restBaseUrl}/customers`, {
      accessId: shopConfig.accessId,
      ...params,
    });
    return fetchJson<RestCustomer[]>(url);
  }, 'GET /customers');
}

/**
 * GET /branches — list branches (needed for er_branchid in availability calls).
 */
export async function restGetBranches(
  shopConfig: ShopEasyrentConfig,
  params?: {
    branchId?: number;
    branchCode?: string;
    branchIdExternal?: string;
    top?: number;
    skip?: number;
  },
): Promise<RestBranch[]> {
  return withRetry(async () => {
    const url = buildUrl(`${shopConfig.restBaseUrl}/branches`, {
      accessId: shopConfig.accessId,
      ...params,
    });
    return fetchJson<RestBranch[]>(url);
  }, 'GET /branches');
}

/**
 * GET /rentalarticles — list rental articles (REST, paginated via top/skip).
 */
export async function restGetRentalArticles(
  shopConfig: ShopEasyrentConfig,
  params: Omit<RestRentalArticlesParams, 'accessId'>,
): Promise<RestRentalArticle[]> {
  return withRetry(async () => {
    const url = buildUrl(`${shopConfig.restBaseUrl}/rentalarticles`, {
      accessId: shopConfig.accessId,
      ...params,
    });
    return fetchJson<RestRentalArticle[]>(url);
  }, 'GET /rentalarticles');
}

// ---------------------------------------------------------------------------
// Basket stubs (possible two-step reservation flow — Phase 1 TODO)
// ---------------------------------------------------------------------------

/**
 * PUT /reservation/basket/{basketid} — create or update a reservation basket.
 *
 * TODO: It is not yet confirmed whether a basket → confirm → reservation flow
 * is required. Test against a live instance:
 *   1. Does insertupdatereservation work directly, or must a basket be created first?
 *   2. If basket flow is required, implement: create basket → add positions →
 *      confirm basket → receive reservation code.
 * Until confirmed, this function stubs the endpoint.
 */
export async function restCreateOrUpdateBasket(
  shopConfig: ShopEasyrentConfig,
  basketId: string,
  basket: RestBasketBody,
): Promise<unknown> {
  return withRetry(async () => {
    const url = buildUrl(
      `${shopConfig.restBaseUrl}/reservation/basket/${encodeURIComponent(basketId)}`,
      { accessId: shopConfig.accessId },
    );
    return fetchJson<unknown>(url, {
      method: 'PUT',
      body: JSON.stringify(basket),
    });
  }, `PUT /reservation/basket/${basketId}`);
}

/**
 * DELETE /reservation/basket/{basketid} — delete a reservation basket.
 *
 * TODO: Part of the potential two-step basket flow. See restCreateOrUpdateBasket.
 */
export async function restDeleteBasket(
  shopConfig: ShopEasyrentConfig,
  basketId: string,
): Promise<void> {
  return withRetry(async () => {
    const url = buildUrl(
      `${shopConfig.restBaseUrl}/reservation/basket/${encodeURIComponent(basketId)}`,
      { accessId: shopConfig.accessId },
    );
    await fetchJson<unknown>(url, { method: 'DELETE' });
  }, `DELETE /reservation/basket/${basketId}`);
}
