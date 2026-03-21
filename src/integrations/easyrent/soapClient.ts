/**
 * Typed SOAP client for Easyrent wseasyrent service.
 *
 * Each exported function wraps one SOAP method with:
 *  - Typed inputs/outputs (from src/types/easyrent.ts)
 *  - Retry logic (3 attempts, exponential backoff)
 *  - Structured timing logs
 *  - EasyrentError on failure (never throws raw SOAP errors)
 *
 * SOAP clients are cached by WSDL URL so we don't re-create them on every call.
 */

import * as soap from 'node-soap';
import type { Client } from 'node-soap';
import {
  EasyrentError,
  type SoapTestMethodOutput,
  type SoapCustInsertOrUpdateV2Input,
  type SoapCustInsertOrUpdateV2Output,
  type SoapInsertCustomerV2Input,
  type SoapInsertCustomerV2Output,
  type SoapSetGroupCustomerV2Input,
  type SoapSetGroupCustomerV2Output,
  type SoapGetCustomersV3Input,
  type SoapGetCustomersV3Output,
  type SoapGetAvailCountInput,
  type SoapGetAvailCountOutput,
  type SoapGetRentalArticleInput,
  type SoapGetRentalArticleOutput,
  type SoapBookSaleV2Input,
  type SoapBookSaleV2Output,
} from '../../types/easyrent';

// ---------------------------------------------------------------------------
// Config type — derived from the shops DB row by callers
// ---------------------------------------------------------------------------

export interface ShopEasyrentConfig {
  soapUrl: string;
  restBaseUrl: string;
  accessId: string;
  branchId: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` up to `maxAttempts` times with exponential backoff between tries.
 * Logs timing and attempt count. Wraps final error in EasyrentError.
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
        `[soap] ${context} ok — ${Date.now() - start}ms (attempt ${attempt})`,
      );
      return result;
    } catch (err) {
      lastError = err;
      console.warn(
        `[soap] ${context} failed — ${Date.now() - start}ms (attempt ${attempt}/${maxAttempts}):`,
        err instanceof Error ? err.message : err,
      );
      if (attempt < maxAttempts) {
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  throw new EasyrentError(
    'SOAP_ERROR',
    `${context} failed after ${maxAttempts} attempts`,
    lastError,
  );
}

// ---------------------------------------------------------------------------
// SOAP client cache
// ---------------------------------------------------------------------------

const clientCache = new Map<string, Client>();

/**
 * Return a cached SOAP Client for the given WSDL URL, creating it if needed.
 * Errors during client creation are not retried — a bad WSDL URL is a
 * configuration problem, not a transient failure.
 */
async function getSoapClient(soapUrl: string): Promise<Client> {
  const cached = clientCache.get(soapUrl);
  if (cached) return cached;

  try {
    const client = await soap.createClientAsync(soapUrl);
    clientCache.set(soapUrl, client);
    return client;
  } catch (err) {
    throw new EasyrentError(
      'SOAP_CLIENT_INIT',
      `Failed to create SOAP client for ${soapUrl}`,
      err,
    );
  }
}

/**
 * Call a SOAP method by name and return only the first element of the
 * node-soap result tuple (the parsed response object).
 * Using explicit `unknown` cast avoids propagating `any` into call sites.
 */
async function callMethod<TResult>(
  client: Client,
  method: string,
  args: Record<string, unknown>,
): Promise<TResult> {
  const asyncMethod = (
    client as unknown as Record<
      string,
      (a: Record<string, unknown>) => Promise<[TResult]>
    >
  )[`${method}Async`];

  if (typeof asyncMethod !== 'function') {
    throw new EasyrentError(
      'SOAP_METHOD_NOT_FOUND',
      `SOAP method "${method}Async" not found on client`,
    );
  }

  const [result] = await asyncMethod.call(client, args);
  return result;
}

/**
 * Assert that a SOAP response has resultcode 0.
 * Throws EasyrentError for non-zero codes so callers get a typed error.
 */
function assertSuccess(
  context: string,
  resultcode: number,
  errormessage: string,
): void {
  if (resultcode !== 0) {
    throw new EasyrentError(
      resultcode,
      `${context}: ${errormessage || 'Unknown Easyrent error'}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Exported SOAP method wrappers
// ---------------------------------------------------------------------------

/**
 * testmethod — smoke-test connectivity to Easyrent.
 * Returns the response string from the service.
 */
export async function soapTestMethod(
  shopConfig: ShopEasyrentConfig,
): Promise<SoapTestMethodOutput> {
  return withRetry(async () => {
    const client = await getSoapClient(shopConfig.soapUrl);
    const result = await callMethod<SoapTestMethodOutput>(client, 'testmethod', {
      accessid: shopConfig.accessId,
    });
    return result;
  }, 'testmethod');
}

/**
 * custinsertorupdatev2 — upsert a customer with full profile data.
 * Used at Step 9 to create/update the primary customer in Easyrent.
 */
export async function soapCustInsertOrUpdateV2(
  shopConfig: ShopEasyrentConfig,
  input: Omit<SoapCustInsertOrUpdateV2Input, 'accessid'>,
): Promise<SoapCustInsertOrUpdateV2Output> {
  return withRetry(async () => {
    const client = await getSoapClient(shopConfig.soapUrl);
    const result = await callMethod<SoapCustInsertOrUpdateV2Output>(
      client,
      'custinsertorupdatev2',
      { accessid: shopConfig.accessId, customer: input.customer },
    );
    assertSuccess('custinsertorupdatev2', result.resultcode, result.errormessage);
    return result;
  }, 'custinsertorupdatev2');
}

/**
 * insertcustomerv2 — insert a customer using the simpler form.
 * Used at Step 9 for each additional group member.
 */
export async function soapInsertCustomerV2(
  shopConfig: ShopEasyrentConfig,
  input: Omit<SoapInsertCustomerV2Input, 'accessid'>,
): Promise<SoapInsertCustomerV2Output> {
  return withRetry(async () => {
    const client = await getSoapClient(shopConfig.soapUrl);
    const result = await callMethod<SoapInsertCustomerV2Output>(
      client,
      'insertcustomerv2',
      { accessid: shopConfig.accessId, customer: input.customer },
    );
    assertSuccess('insertcustomerv2', result.resultcode, result.errormessage);
    return result;
  }, 'insertcustomerv2');
}

/**
 * setgroupcustomerv2 — link multiple customer codes into a group.
 * Called after inserting all group members so they share a group code.
 */
export async function soapSetGroupCustomerV2(
  shopConfig: ShopEasyrentConfig,
  input: Omit<SoapSetGroupCustomerV2Input, 'accessid'>,
): Promise<SoapSetGroupCustomerV2Output> {
  return withRetry(async () => {
    const client = await getSoapClient(shopConfig.soapUrl);
    const result = await callMethod<SoapSetGroupCustomerV2Output>(
      client,
      'setgroupcustomerv2',
      { accessid: shopConfig.accessId, customer: input.customer },
    );
    assertSuccess('setgroupcustomerv2', result.resultcode, result.errormessage);
    return result;
  }, 'setgroupcustomerv2');
}

/**
 * getcustomersv3 — search for customers matching the given filters.
 */
export async function soapGetCustomersV3(
  shopConfig: ShopEasyrentConfig,
  input: Omit<SoapGetCustomersV3Input, 'accessid'>,
): Promise<SoapGetCustomersV3Output> {
  return withRetry(async () => {
    const client = await getSoapClient(shopConfig.soapUrl);
    const result = await callMethod<SoapGetCustomersV3Output>(
      client,
      'getcustomersv3',
      { accessid: shopConfig.accessId, ...input.filters },
    );
    assertSuccess('getcustomersv3', result.resultcode, result.errormessage);
    return result;
  }, 'getcustomersv3');
}

/**
 * getavailcount — check equipment availability for date ranges and rental groups.
 * NOTE: Availability is checked after the user selects equipment type (Step 4),
 * not Step 3, because er_rentalgroupid is required and only known after step 4.
 */
export async function soapGetAvailCount(
  shopConfig: ShopEasyrentConfig,
  input: Omit<SoapGetAvailCountInput, 'accessid'>,
): Promise<SoapGetAvailCountOutput> {
  return withRetry(async () => {
    const client = await getSoapClient(shopConfig.soapUrl);
    const result = await callMethod<SoapGetAvailCountOutput>(
      client,
      'getavailcount',
      { accessid: shopConfig.accessId, getavail: input.getavail },
    );
    assertSuccess('getavailcount', result.resultcode, result.errormessage);
    return result;
  }, 'getavailcount');
}

/**
 * getrentalarticle — query rental articles with filters.
 */
export async function soapGetRentalArticle(
  shopConfig: ShopEasyrentConfig,
  input: Omit<SoapGetRentalArticleInput, 'accessid'>,
): Promise<SoapGetRentalArticleOutput> {
  return withRetry(async () => {
    const client = await getSoapClient(shopConfig.soapUrl);
    const result = await callMethod<SoapGetRentalArticleOutput>(
      client,
      'getrentalarticle',
      { accessid: shopConfig.accessId, ...input.filters },
    );
    assertSuccess('getrentalarticle', result.resultcode, result.errormessage);
    return result;
  }, 'getrentalarticle');
}

/**
 * booksalev2 — book a sale for a customer.
 */
export async function soapBookSaleV2(
  shopConfig: ShopEasyrentConfig,
  input: Omit<SoapBookSaleV2Input, 'accessid'>,
): Promise<SoapBookSaleV2Output> {
  return withRetry(async () => {
    const client = await getSoapClient(shopConfig.soapUrl);
    const result = await callMethod<SoapBookSaleV2Output>(
      client,
      'booksalev2',
      {
        accessid: shopConfig.accessId,
        customercode: input.customercode,
        clientid: input.clientid,
        salesitem: input.salesitem,
      },
    );
    assertSuccess('booksalev2', result.resultcode, result.errormessage);
    return result;
  }, 'booksalev2');
}
