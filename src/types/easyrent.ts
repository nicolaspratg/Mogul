/**
 * Mogul — Easyrent type definitions
 *
 * Covers:
 *  - SOAP API (wseasyrent) method inputs/outputs
 *  - REST API (easyrest/rest) endpoint request/response shapes
 *  - Shared error types
 *  - ConversationData (the jsonb shape stored in conversations.data)
 *
 * Param casing reflects exact API requirements per endpoint:
 *   - Most REST endpoints: accessId (camelCase)
 *   - /techarticledata:    access_id (snake_case)
 *   - /getarticlesrented:  accessid (lowercase)
 */

// ---------------------------------------------------------------------------
// Shared / generic
// ---------------------------------------------------------------------------

/** Typed wrapper returned by every SOAP method call. */
export interface SoapResponse<T> {
  resultcode: number; // 0 = success
  errormessage: string;
  result: T;
}

/** Structured error thrown by both SOAP and REST clients. */
export class EasyrentError extends Error {
  constructor(
    public readonly code: number | string,
    message: string,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'EasyrentError';
  }
}

// ---------------------------------------------------------------------------
// SOAP — shared sub-types
// ---------------------------------------------------------------------------

export interface SoapCustomerResult {
  er_custid: number;
  er_custcode: string;
  er_groupcode: string;
  custextid: string;
  custextidorigin: string;
}

export interface SoapCustomer {
  er_custid?: number;
  er_custcode?: string;
  er_groupcode?: string;
  custcard?: string;
  custextid?: string;
  custextidorigin?: string;
  mainperson?: boolean;
  firstname: string;
  lastname: string;
  address1?: string;
  address2?: string;
  zip?: string;
  city?: string;
  countryisoa2?: string;
  countryname?: string;
  er_regioncode?: string;
  er_genderid?: number;
  er_titleid?: number;
  dateofbirth?: Date;
  telephone?: string;
  mobile?: string;
  fax?: string;
  email?: string;
  hotelname?: string;
  remark?: string;
  int_isoweightrangeid?: number;
  weightkg?: number;
  weightlbs?: number;
  int_isoheightrangeid?: number;
  heightcm?: number;
  heightinch?: number;
  /**
   * Skill level as Easyrent integer ID.
   * Expected mapping (confirm against live instance):
   *   1 = beginner, 2 = intermediate, 3 = advanced
   */
  int_isoskiertypeid?: number;
  bootsize?: string;
  solemm?: number;
  boardstance?: string;
  languagecode?: string;
  rentalduration?: number;
  marketingpermission?: string;
  isregularcustomer?: string;
  isonlinecheckin?: string;
}

export interface SoapInsertCustomerInput {
  groupcode?: string;
  isleader?: boolean;
  custcodeext?: string;
  custcodeexttype?: string;
  firstname: string;
  lastname: string;
  address1?: string;
  zipcode?: string;
  city?: string;
  statecode?: string;
  countrycode?: string;
  dateofbirth?: Date;
  telephone?: string;
  mobilephone?: string;
  email?: string;
  ismale?: boolean;
  isfemale?: boolean;
  accommodation?: string;
  remark?: string;
}

export interface SoapGetAvailInput {
  er_rentalgroupid: number;
  property1?: string;
  er_modelid?: number;
  datefrom: Date;
  dateto: Date;
  er_branchid: number;
  er_depotlocationid?: number;
}

export interface SoapGetAvailResult {
  er_rentalgroupid: number;
  datefrom: Date;
  dateto: Date;
  er_branchid: number;
  availcount: number;
}

export interface SoapGetCustomerFilters {
  er_custcode?: string;
  er_groupcode?: string;
  custcard?: string;
  custextid?: string;
  custextidorigin?: string;
  firstname?: string;
  lastname?: string;
  zip?: string;
  city?: string;
  dateofbirth?: Date;
  telephone?: string;
  mobile?: string;
  email?: string;
  created_after?: Date;
  changed_after?: Date;
  activity_after?: Date;
  maxrows?: number;
}

export interface SoapCustomerRecord {
  er_custid: number;
  er_custcode: string;
  er_groupcode: string;
  custcard: string;
  custextid: string;
  firstname: string;
  lastname: string;
  address1: string;
  zip: string;
  city: string;
  countryisoa2: string;
  er_genderid: number;
  dateofbirth: Date;
  telephone: string;
  mobile: string;
  email: string;
  hotelname: string;
  remark: string;
  created_at: Date;
  changed_at: Date;
}

export interface SoapRentalArticle {
  // Easyrent does not publish a fixed schema for rental article fields.
  // Extend this interface after live testing confirms the field list.
  [key: string]: unknown;
}

export interface SoapGetRentalArticleFilters {
  filter_rentalgroupname?: string;
  filter_property1?: string;
  filter_isrented?: string;
  filter_statusname?: string;
  maxrows?: number;
  [key: string]: unknown; // additional undocumented filters
}

export interface SoapSalesItem {
  articledescription: string;
  quantity: number;
  itemprice: number;
  salesamount: number;
  taxrate: number;
  transactionid: string;
  cancelation: boolean;
  repurchase: boolean;
}

export interface SoapGroupCustomerLink {
  customercode: string;
  groupcode: string;
}

// ---------------------------------------------------------------------------
// SOAP — method signatures (input → output)
// ---------------------------------------------------------------------------

/** testmethod — connectivity test */
export interface SoapTestMethodInput {
  accessid: string;
}
export interface SoapTestMethodOutput {
  response: string;
}

/** custinsertorupdatev2 — upsert a customer with full profile */
export interface SoapCustInsertOrUpdateV2Input {
  accessid: string;
  customer: SoapCustomer;
}
export interface SoapCustInsertOrUpdateV2Output {
  resultcode: number;
  errormessage: string;
  customerresult: SoapCustomerResult;
}

/** insertcustomerv2 — insert a new customer (simpler form) */
export interface SoapInsertCustomerV2Input {
  accessid: string;
  customer: SoapInsertCustomerInput;
}
export interface SoapInsertCustomerV2Output {
  resultcode: number;
  errormessage: string;
  customercode: string;
  groupcode: string;
}

/** setgroupcustomerv2 — link customers into a group */
export interface SoapSetGroupCustomerV2Input {
  accessid: string;
  customer: SoapGroupCustomerLink[];
}
export interface SoapSetGroupCustomerV2Output {
  resultcode: number;
  errormessage: string;
}

/** getcustomersv3 — search customers with filters */
export interface SoapGetCustomersV3Input {
  accessid: string;
  filters: SoapGetCustomerFilters;
}
export interface SoapGetCustomersV3Output {
  resultcode: number;
  errormessage: string;
  matchcount: number;
  customer: SoapCustomerRecord[];
}

/** getavailcount — check equipment availability */
export interface SoapGetAvailCountInput {
  accessid: string;
  getavail: SoapGetAvailInput[];
}
export interface SoapGetAvailCountOutput {
  resultcode: number;
  errormessage: string;
  getavailresult: SoapGetAvailResult[];
}

/** getrentalarticle — query rental articles */
export interface SoapGetRentalArticleInput {
  accessid: string;
  filters: SoapGetRentalArticleFilters;
}
export interface SoapGetRentalArticleOutput {
  resultcode: number;
  errormessage: string;
  rentalarticle: SoapRentalArticle[];
}

/** booksalev2 — book a sale */
export interface SoapBookSaleV2Input {
  accessid: string;
  customercode: string;
  clientid: string;
  salesitem: SoapSalesItem[];
}
export interface SoapBookSaleV2Output {
  resultcode: number;
  errormessage: string;
}

// ---------------------------------------------------------------------------
// REST — shared sub-types
// ---------------------------------------------------------------------------

/**
 * Body shape for availability check endpoints.
 * Used by POST /reservation/getavailcount and /reservation/getavailcountdt.
 * Mirrors the SOAP getavailcount input array.
 */
export interface RestGetAvailData {
  er_rentalgroupid: number;
  property1?: string;
  er_modelid?: number;
  datefrom: string; // ISO 8601 date string
  dateto: string;
  er_branchid: number;
  er_depotlocationid?: number;
}

export interface RestGetAvailResult {
  er_rentalgroupid: number;
  datefrom: string;
  dateto: string;
  er_branchid: number;
  availcount: number;
}

/** Equipment type entry from GET /reservation/reservablearticles */
export interface RestReservableArticle {
  // Exact fields to be confirmed by live testing.
  er_rentalgroupid?: number;
  name?: string;
  [key: string]: unknown;
}

/** Branch entry from GET /branches */
export interface RestBranch {
  branchId?: number;
  branchCode?: string;
  branchIdExternal?: string;
  name?: string;
  [key: string]: unknown;
}

/** Equipment type from GET /calendar/getEquipmentTypes */
export interface RestEquipmentType {
  id?: number;
  name?: string;
  [key: string]: unknown;
}

/** Rental group from GET /calendar/getRentalGroups */
export interface RestRentalGroup {
  er_rentalgroupid?: number;
  name?: string;
  equipmentTypeId?: number;
  [key: string]: unknown;
}

/** Calendar availability response from POST /calendar/getAvailability */
export interface RestCalendarAvailability {
  [key: string]: unknown; // structure to be confirmed by live testing
}

/** Customer record from GET /customers */
export interface RestCustomer {
  customerId?: number;
  customerCode?: string;
  customerIdExternal?: string;
  groupCustomerId?: number;
  groupCustomerCode?: string;
  firstName?: string;
  lastName?: string;
  postalCode?: string;
  dateOfBirth?: string;
  [key: string]: unknown;
}

/** Rental article from GET /rentalarticles */
export interface RestRentalArticle {
  rentalArticleId?: number;
  rentalArticleCode?: string;
  rentalGroupId?: number;
  rentalGroupName?: string;
  modelId?: number;
  modelName?: string;
  modelYear?: number;
  brand?: string;
  rentalArticleStatusId?: number;
  isSold?: boolean;
  isMultiRent?: boolean;
  property1?: string;
  property2?: string;
  property3?: string;
  property4?: string;
  property5?: string;
  assignedBranchId?: number;
  locationBranchId?: number;
  [key: string]: unknown;
}

/**
 * Reservation lookup result from GET /isatde/reservation.
 * Used for post-creation verification in Step 9.
 */
export interface RestReservationLookup {
  reservationIdExternal?: string;
  branchId?: number;
  firstName?: string;
  lastName?: string;
  [key: string]: unknown;
}

/**
 * Body for POST /reservation/insertupdatereservation.
 *
 * TODO: The exact structure must be confirmed by testing against a live
 * Easyrent instance. Based on the SOAP API and Easyrent data model, the body
 * likely contains customerCode, groupCode, branchId, dateFrom, dateTo, and a
 * positions array (rentalGroupId + equipmentTypeId per person).
 *
 * Also investigate whether a two-step basket flow is required:
 *   PUT /reservation/basket/{basketid}  →  confirm  →  reservation code
 * If so, this type will need to be split into basket and confirmation shapes.
 */
export interface RestReservationBody {
  customerCode?: string;
  groupCode?: string;
  branchId?: number;
  dateFrom?: string; // ISO 8601
  dateTo?: string;
  positions?: Array<{
    rentalGroupId: number;
    equipmentTypeId?: number;
    quantity?: number;
    customerCode?: string;
  }>;
  [key: string]: unknown; // placeholder until structure is confirmed
}

/** Response from POST /reservation/insertupdatereservation */
export interface RestReservationResponse {
  reservationCode?: string;
  reservationId?: number;
  [key: string]: unknown; // placeholder until structure is confirmed
}

/**
 * Body for PUT /reservation/basket/{basketid}.
 *
 * TODO: Basket endpoint structure is unconfirmed. There may be a two-step
 * reservation flow: create basket → confirm → reservation. Test against live
 * instance before implementing the basket path.
 */
export interface RestBasketBody {
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// REST — query param interfaces
// (document query params as typed objects; callers build URLSearchParams)
// ---------------------------------------------------------------------------

/** Query params for GET /branches */
export interface RestBranchesParams {
  accessId: string;
  branchId?: number;
  branchCode?: string;
  branchIdExternal?: string;
  top?: number;
  skip?: number;
}

/** Query params for GET /customers */
export interface RestCustomersParams {
  accessId: string;
  firstName?: string;
  lastName?: string;
  customerCode?: string;
  customerId?: number;
  customerIdExternal?: string;
  groupCustomerId?: number;
  groupCustomerCode?: string;
  groupCustomerIdExternal?: string;
  postalCode?: string;
  dateOfBirth?: string;
  changedAfter?: string;
  top?: number;
  skip?: number;
}

/** Query params for GET /rentalarticles */
export interface RestRentalArticlesParams {
  accessId: string;
  rentalGroupId?: number;
  rentalGroupName?: string;
  rentalArticleId?: number;
  rentalArticleCode?: string;
  modelId?: number;
  modelName?: string;
  modelYear?: number;
  brand?: string;
  rentalArticleStatusId?: number;
  isSold?: boolean;
  isMultiRent?: boolean;
  property1?: string;
  property2?: string;
  property3?: string;
  property4?: string;
  property5?: string;
  assignedBranchId?: number;
  locationBranchId?: number;
  top?: number;
  skip?: number;
}

/**
 * Query params for GET /getarticlesrented.
 * Note: uses lowercase `accessid` (not camelCase).
 */
export interface RestGetArticlesRentedParams {
  accessid: string; // lowercase — intentional, matches API
  reservationbarcode: string;
}

/**
 * Query params for GET /techarticledata.
 * Note: uses snake_case `access_id`.
 */
export interface RestTechArticleDataParams {
  access_id: string; // snake_case — intentional, matches API
  easyrent_barcode?: string;
}

/** Query params for GET /isatde/reservation */
export interface RestIsatReservationParams {
  accessId: string;
  reservationIdExternal?: string;
  branchId?: number;
  firstName?: string;
  lastName?: string;
}

/** Query params for GET /testaccess */
export interface RestTestAccessParams {
  accessId: string;
  testType?: string;
}

// ---------------------------------------------------------------------------
// ConversationData — jsonb shape stored in conversations.data
// ---------------------------------------------------------------------------

export type Language = 'de' | 'en' | 'it';
export type SkillLevel = 'beginner' | 'intermediate' | 'advanced';

/** All rentable equipment items in the winter catalog. */
export type EquipmentItem =
  // Alpine skis
  | 'ski_factory_test'
  | 'ski_diamant'
  | 'ski_premium'
  | 'ski_economy'
  | 'ski_basic'
  // Ski boots
  | 'ski_boots_premium'
  | 'ski_boots_economy'
  // Snowboard
  | 'snowboard_premium'
  | 'snowboard_economy'
  | 'snowboard_boots'
  // Cross country
  | 'xc_classic'
  | 'xc_classic_boots'
  | 'xc_skating'
  | 'xc_skating_boots'
  // Touring
  | 'touring_ski'
  | 'touring_boots'
  | 'touring_backpack'
  | 'touring_radar'
  | 'touring_shovel'
  | 'touring_avalanche_bag'
  | 'touring_probe'
  // Other
  | 'helmet_visor'
  | 'helmet_no_visor'
  | 'snowshoes'
  | 'sleigh'
  // Kids
  | 'kids_ski'
  | 'kids_boots';

export interface GroupMember {
  firstname: string;
  lastname: string;
  dob: string;             // ISO date "YYYY-MM-DD"
  equipment: EquipmentItem[];
  heightcm?: number;
  weightkg?: number;
  skillLevel?: SkillLevel;
  solemm?: number;         // own-boot sole length in mm (if customer has their own boots)
  hotel?: string;
}

/**
 * Shape of the `data` jsonb column in the `conversations` table.
 * Populated progressively as the user advances through the flow.
 */
export interface ConversationData {
  language: Language;
  datefrom?: string; // ISO date, e.g. "2025-02-10"
  dateto?: string;
  branchId?: number;     // selected pick-up branch ID
  members?: GroupMember[];
  email?: string;        // primary booker's email
  specialRequests?: string;
  insurance?: boolean;   // Carefree Protection Package
  easyrentCustomerCode?: string;
  easyrentGroupCode?: string;
}
