/**
 * AlpChat conversation state machine.
 *
 * processMessage(shopId, waPhone, incomingText) → string (reply to send)
 *
 * Architecture:
 *  - All state lives in PostgreSQL (conversations.data jsonb). Nothing in memory.
 *  - Each call loads the active conversation from DB (or creates one).
 *  - Checks expires_at — if expired, resets the conversation.
 *  - Routes to the handler for the current step.
 *  - Validates input; re-prompts on invalid input without step transition.
 *  - Updates step + data + expires_at (sliding window TTL) atomically.
 *  - Calls Easyrent APIs at the correct steps (availability after Step 4,
 *    reservation creation at Step 9).
 */

import { pool } from '../db/pool';
import { config } from '../config';
import { t } from '../i18n';
import {
  EasyrentError,
  type Language,
  type EquipmentType,
  type SkillLevel,
  type GroupMember,
  type ConversationData,
} from '../types/easyrent';
import type { ShopEasyrentConfig } from '../integrations/easyrent/soapClient';
import {
  soapCustInsertOrUpdateV2,
  soapInsertCustomerV2,
  soapSetGroupCustomerV2,
} from '../integrations/easyrent/soapClient';
import {
  restGetRentalGroups,
  restGetAvailCount,
  restInsertUpdateReservation,
} from '../integrations/easyrent/restClient';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All conversation steps, stored verbatim in conversations.step. */
export enum ConversationStep {
  WELCOME = 'welcome',
  NAME_FIRST = 'name_first',
  NAME_LAST = 'name_last',
  DATE_FROM = 'date_from',
  DATE_TO = 'date_to',
  EQUIPMENT = 'equipment',
  SKILL = 'skill',
  PHYSICAL_HEIGHT = 'physical_height',
  PHYSICAL_WEIGHT = 'physical_weight',
  PHYSICAL_BOOT = 'physical_boot',
  PHYSICAL_SOLE = 'physical_sole',
  GROUP_SIZE = 'group_size',
  GROUP_MEMBER = 'group_member',
  CONFIRM = 'confirm',
  DONE = 'done',
}

/**
 * Fields tracked per individual group member during collection.
 * Stored in data.currentMemberField.
 */
type MemberField =
  | 'first_name'
  | 'last_name'
  | 'height'
  | 'weight'
  | 'boot'
  | 'sole'
  | 'skill';

const MEMBER_FIELD_ORDER: MemberField[] = [
  'first_name',
  'last_name',
  'height',
  'weight',
  'boot',
  'sole',
  'skill',
];

/**
 * Extends ConversationData with internal tracking fields stored in the jsonb.
 * These are operational and only meaningful to the state machine.
 */
interface InternalData extends ConversationData {
  currentMemberIndex?: number;
  currentMemberField?: MemberField;
  rentalGroupIds?: number[];
}

interface StepResult {
  nextStep: ConversationStep;
  updatedData: InternalData;
  reply: string;
}

// ---------------------------------------------------------------------------
// DB row shapes
// ---------------------------------------------------------------------------

interface ShopRow {
  id: string;
  name: string;
  easyrent_soap_url: string;
  easyrent_rest_base_url: string;
  easyrent_accessid: string;
  easyrent_branchid: number;
  languages: Language[];
}

interface ConversationRow {
  id: string;
  shop_id: string;
  wa_phone: string;
  step: string;
  language: Language;
  data: InternalData;
  status: string;
  expires_at: Date;
}

// ---------------------------------------------------------------------------
// Input parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a date string in DD.MM.YYYY or YYYY-MM-DD format.
 * Returns an ISO date string (YYYY-MM-DD) or null on failure.
 */
function parseDate(input: string): string | null {
  const trimmed = input.trim();

  // DD.MM.YYYY
  const dmyMatch = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(trimmed);
  if (dmyMatch) {
    const [, d, m, y] = dmyMatch;
    const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    const date = new Date(iso);
    if (!isNaN(date.getTime())) return iso;
  }

  // YYYY-MM-DD
  const isoMatch = /^\d{4}-\d{2}-\d{2}$/.exec(trimmed);
  if (isoMatch) {
    const date = new Date(trimmed);
    if (!isNaN(date.getTime())) return trimmed;
  }

  return null;
}

function isoToDisplay(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function parsePositiveFloat(input: string): number | null {
  const n = parseFloat(input.replace(',', '.'));
  return isNaN(n) || n <= 0 ? null : n;
}

function parsePositiveInt(input: string): number | null {
  const n = parseInt(input.trim(), 10);
  return isNaN(n) || n <= 0 ? null : n;
}

function normalizeYesNo(input: string, language: Language): 'yes' | 'no' | null {
  const lower = input.trim().toLowerCase();
  const yesTokens: Record<Language, string[]> = {
    de: ['ja', 'j', 'yes', 'y', 'ok', 'bestätigen', 'confirm'],
    en: ['yes', 'y', 'ja', 'ok', 'confirm'],
    it: ['si', 'sì', 's', 'yes', 'y', 'ok'],
  };
  const noTokens: Record<Language, string[]> = {
    de: ['nein', 'n', 'no', 'abbrechen', 'cancel'],
    en: ['no', 'n', 'nein', 'cancel', 'abbrechen'],
    it: ['no', 'n', 'cancel'],
  };
  if (yesTokens[language].includes(lower)) return 'yes';
  if (noTokens[language].includes(lower)) return 'no';
  return null;
}

function skillFromInput(input: string): SkillLevel | null {
  const map: Record<string, SkillLevel> = {
    '1': 'beginner',
    '2': 'intermediate',
    '3': 'advanced',
    beginner: 'beginner',
    intermediate: 'intermediate',
    advanced: 'advanced',
    anfänger: 'beginner',
    fortgeschritten: 'intermediate',
    experte: 'advanced',
  };
  return map[input.trim().toLowerCase()] ?? null;
}

function equipmentFromInput(input: string): EquipmentType | null {
  const map: Record<string, EquipmentType> = {
    '1': 'ski',
    '2': 'snowboard',
    '3': 'both',
    ski: 'ski',
    snowboard: 'snowboard',
    both: 'both',
    beides: 'both',
  };
  return map[input.trim().toLowerCase()] ?? null;
}

function skillLabel(skill: SkillLevel, language: Language): string {
  const keyMap: Record<SkillLevel, string> = {
    beginner: 'skill_beginner',
    intermediate: 'skill_intermediate',
    advanced: 'skill_advanced',
  };
  return t(language, keyMap[skill]);
}

function equipmentLabel(eq: EquipmentType, language: Language): string {
  const keyMap: Record<EquipmentType, string> = {
    ski: 'equipment_ski',
    snowboard: 'equipment_snowboard',
    both: 'equipment_both',
  };
  return t(language, keyMap[eq]);
}

/**
 * Map skill level string to Easyrent int_isoskiertypeid.
 * TODO: Confirm these IDs against a live Easyrent instance.
 * Expected: 1=beginner, 2=intermediate, 3=advanced.
 */
function skillToEasyrentId(skill: SkillLevel): number {
  const map: Record<SkillLevel, number> = {
    beginner: 1,
    intermediate: 2,
    advanced: 3,
  };
  return map[skill];
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(data: InternalData, language: Language): string {
  const lines: string[] = [t(language, 'summary_header'), ''];

  lines.push(
    t(language, 'summary_main_person', {
      firstname: data.firstname ?? '',
      lastname: data.lastname ?? '',
    }),
  );

  lines.push(
    t(language, 'summary_dates', {
      datefrom: data.datefrom ? isoToDisplay(data.datefrom) : '',
      dateto: data.dateto ? isoToDisplay(data.dateto) : '',
    }),
  );

  if (data.equipmentType) {
    lines.push(
      t(language, 'summary_equipment', {
        equipment: equipmentLabel(data.equipmentType, language),
      }),
    );
  }

  if (data.skillLevel) {
    lines.push(
      t(language, 'summary_skill', { skill: skillLabel(data.skillLevel, language) }),
    );
  }

  lines.push(
    t(language, 'summary_physical', {
      height: data.heightcm ?? '',
      weight: data.weightkg ?? '',
      boot: data.bootsize ?? '',
      sole: data.solemm ?? '',
    }),
  );

  const members = data.groupMembers ?? [];
  if (members.length > 0) {
    lines.push('');
    lines.push(t(language, 'summary_group_header', { count: members.length }));
    members.forEach((m, i) => {
      lines.push(
        t(language, 'summary_group_member', {
          index: i + 2,
          firstname: m.firstname,
          lastname: m.lastname,
          height: m.heightcm,
          weight: m.weightkg,
          boot: m.bootsize,
          sole: m.solemm,
          skill: skillLabel(m.skillLevel, language),
        }),
      );
    });
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Step handlers
// ---------------------------------------------------------------------------

function handleWelcome(shopName: string, language: Language): StepResult {
  return {
    nextStep: ConversationStep.NAME_FIRST,
    updatedData: { language },
    reply: t(language, 'welcome', { shopName }) + '\n\n' + t(language, 'name_first_prompt'),
  };
}

/**
 * The welcome message asks for language selection.
 * This handler processes the language reply before the first real step.
 * NOTE: We keep step=welcome until language is chosen, then jump to name_first.
 */
function handleLanguageSelection(
  input: string,
  shopName: string,
): StepResult | null {
  const choice = input.trim();
  let language: Language;

  if (choice === '1' || choice.toLowerCase() === 'de' || choice.toLowerCase() === 'deutsch') {
    language = 'de';
  } else if (choice === '2' || choice.toLowerCase() === 'en' || choice.toLowerCase() === 'english') {
    language = 'en';
  } else if (choice === '3' || choice.toLowerCase() === 'it' || choice.toLowerCase() === 'italiano') {
    // Phase 3: Italian not yet available — fall back to English with notice
    return {
      nextStep: ConversationStep.WELCOME,
      updatedData: { language: 'en' },
      reply: t('en', 'language_it_unavailable'),
    };
  } else {
    return null; // invalid — re-prompt
  }

  return {
    nextStep: ConversationStep.NAME_FIRST,
    updatedData: { language },
    reply: t(language, 'name_first_prompt'),
  };
}

function handleNameFirst(data: InternalData, input: string): StepResult | null {
  const name = input.trim();
  if (name.length < 1) return null;
  return {
    nextStep: ConversationStep.NAME_LAST,
    updatedData: { ...data, firstname: name },
    reply: t(data.language, 'name_last_prompt'),
  };
}

function handleNameLast(data: InternalData, input: string): StepResult | null {
  const name = input.trim();
  if (name.length < 1) return null;
  return {
    nextStep: ConversationStep.DATE_FROM,
    updatedData: { ...data, lastname: name },
    reply: t(data.language, 'date_from_prompt'),
  };
}

function handleDateFrom(data: InternalData, input: string): StepResult | 'past' | 'invalid' {
  const iso = parseDate(input);
  if (!iso) return 'invalid';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (new Date(iso) < today) return 'past';

  return {
    nextStep: ConversationStep.DATE_TO,
    updatedData: { ...data, datefrom: iso },
    reply: t(data.language, 'date_to_prompt'),
  };
}

function handleDateTo(
  data: InternalData,
  input: string,
): StepResult | 'invalid' | 'past' | 'order' {
  const iso = parseDate(input);
  if (!iso) return 'invalid';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (new Date(iso) < today) return 'past';

  if (data.datefrom && new Date(iso) <= new Date(data.datefrom)) return 'order';

  return {
    nextStep: ConversationStep.EQUIPMENT,
    updatedData: { ...data, dateto: iso },
    reply: t(data.language, 'equipment_prompt'),
  };
}

function handleEquipment(data: InternalData, input: string): StepResult | null {
  const eq = equipmentFromInput(input);
  if (!eq) return null;
  return {
    nextStep: ConversationStep.SKILL,
    updatedData: { ...data, equipmentType: eq },
    reply: t(data.language, 'skill_prompt'),
  };
}

function handleSkill(data: InternalData, input: string): StepResult | null {
  const skill = skillFromInput(input);
  if (!skill) return null;
  return {
    nextStep: ConversationStep.PHYSICAL_HEIGHT,
    updatedData: { ...data, skillLevel: skill },
    reply: t(data.language, 'physical_height_prompt'),
  };
}

function handlePhysicalHeight(data: InternalData, input: string): StepResult | 'invalid' {
  const n = parsePositiveFloat(input);
  if (!n || n < 100 || n > 230) return 'invalid';
  return {
    nextStep: ConversationStep.PHYSICAL_WEIGHT,
    updatedData: { ...data, heightcm: Math.round(n) },
    reply: t(data.language, 'physical_weight_prompt'),
  };
}

function handlePhysicalWeight(data: InternalData, input: string): StepResult | 'invalid' {
  const n = parsePositiveFloat(input);
  if (!n || n < 20 || n > 200) return 'invalid';
  return {
    nextStep: ConversationStep.PHYSICAL_BOOT,
    updatedData: { ...data, weightkg: Math.round(n) },
    reply: t(data.language, 'physical_boot_prompt'),
  };
}

function handlePhysicalBoot(data: InternalData, input: string): StepResult | 'invalid' {
  const trimmed = input.trim();
  // Accept formats like "42", "42.5", "EU 42", etc.
  if (!trimmed || trimmed.length < 1) return 'invalid';
  // Extract numeric portion for basic sanity check
  const numericMatch = /(\d+(?:[.,]\d+)?)/.exec(trimmed);
  if (!numericMatch) return 'invalid';
  const size = parseFloat(numericMatch[1].replace(',', '.'));
  if (size < 20 || size > 60) return 'invalid';

  return {
    nextStep: ConversationStep.PHYSICAL_SOLE,
    updatedData: { ...data, bootsize: trimmed },
    reply: t(data.language, 'physical_sole_prompt'),
  };
}

function handlePhysicalSole(data: InternalData, input: string): StepResult | 'invalid' {
  const n = parsePositiveFloat(input);
  if (!n || n < 180 || n > 380) return 'invalid';
  return {
    nextStep: ConversationStep.GROUP_SIZE,
    updatedData: { ...data, solemm: Math.round(n) },
    reply: t(data.language, 'group_size_prompt'),
  };
}

function handleGroupSize(data: InternalData, input: string): StepResult | 'invalid' {
  const n = parsePositiveInt(input);
  if (!n || n < 1 || n > 20) return 'invalid';

  if (n === 1) {
    // Solo booking — skip group member collection
    const summary = buildSummary({ ...data, groupSize: 1 }, data.language);
    return {
      nextStep: ConversationStep.CONFIRM,
      updatedData: { ...data, groupSize: 1, groupMembers: [] },
      reply: `${summary}\n\n${t(data.language, 'confirm_prompt')}`,
    };
  }

  // Group booking — start collecting additional members
  return {
    nextStep: ConversationStep.GROUP_MEMBER,
    updatedData: {
      ...data,
      groupSize: n,
      groupMembers: [],
      currentMemberIndex: 0,
      currentMemberField: 'first_name',
    },
    reply:
      t(data.language, 'group_member_intro', { index: 2, total: n }) +
      '\n' +
      t(data.language, 'group_member_first_name_prompt'),
  };
}

function handleGroupMember(
  data: InternalData,
  input: string,
): StepResult | 'invalid' {
  const memberIndex = data.currentMemberIndex ?? 0;
  const memberField = data.currentMemberField ?? 'first_name';
  const groupSize = data.groupSize ?? 1;
  const language = data.language;

  // Clone the members array and ensure the current slot exists
  const groupMembers: GroupMember[] = [...(data.groupMembers ?? [])];
  if (!groupMembers[memberIndex]) {
    groupMembers[memberIndex] = {
      firstname: '',
      lastname: '',
      heightcm: 0,
      weightkg: 0,
      bootsize: '',
      solemm: 0,
      skillLevel: 'beginner',
    };
  }
  const member = { ...groupMembers[memberIndex] };

  // Validate and set the current field
  switch (memberField) {
    case 'first_name': {
      const name = input.trim();
      if (!name) return 'invalid';
      member.firstname = name;
      break;
    }
    case 'last_name': {
      const name = input.trim();
      if (!name) return 'invalid';
      member.lastname = name;
      break;
    }
    case 'height': {
      const n = parsePositiveFloat(input);
      if (!n || n < 100 || n > 230) return 'invalid';
      member.heightcm = Math.round(n);
      break;
    }
    case 'weight': {
      const n = parsePositiveFloat(input);
      if (!n || n < 20 || n > 200) return 'invalid';
      member.weightkg = Math.round(n);
      break;
    }
    case 'boot': {
      const trimmed = input.trim();
      const numericMatch = /(\d+(?:[.,]\d+)?)/.exec(trimmed);
      if (!numericMatch) return 'invalid';
      const size = parseFloat(numericMatch[1].replace(',', '.'));
      if (size < 20 || size > 60) return 'invalid';
      member.bootsize = trimmed;
      break;
    }
    case 'sole': {
      const n = parsePositiveFloat(input);
      if (!n || n < 180 || n > 380) return 'invalid';
      member.solemm = Math.round(n);
      break;
    }
    case 'skill': {
      const skill = skillFromInput(input);
      if (!skill) return 'invalid';
      member.skillLevel = skill;
      break;
    }
  }

  groupMembers[memberIndex] = member;

  // Advance to next field in the sequence
  const fieldIdx = MEMBER_FIELD_ORDER.indexOf(memberField);
  const nextField = MEMBER_FIELD_ORDER[fieldIdx + 1];

  if (nextField) {
    const promptKey = `group_member_${nextField}_prompt` as const;
    return {
      nextStep: ConversationStep.GROUP_MEMBER,
      updatedData: {
        ...data,
        groupMembers,
        currentMemberField: nextField,
      },
      reply: t(language, promptKey),
    };
  }

  // Last field of this member — advance to next member or confirm
  const nextMemberIndex = memberIndex + 1;
  const additionalMembersNeeded = groupSize - 1; // primary person is member 1

  if (nextMemberIndex < additionalMembersNeeded) {
    const displayIndex = nextMemberIndex + 2; // display as person N (1-based, person 1 = primary)
    return {
      nextStep: ConversationStep.GROUP_MEMBER,
      updatedData: {
        ...data,
        groupMembers,
        currentMemberIndex: nextMemberIndex,
        currentMemberField: 'first_name',
      },
      reply:
        t(language, 'group_member_intro', {
          index: displayIndex,
          total: groupSize,
        }) +
        '\n' +
        t(language, 'group_member_first_name_prompt'),
    };
  }

  // All group members collected — show summary for confirmation
  const finalData: InternalData = {
    ...data,
    groupMembers,
    currentMemberIndex: undefined,
    currentMemberField: undefined,
  };
  const summary = buildSummary(finalData, language);
  return {
    nextStep: ConversationStep.CONFIRM,
    updatedData: finalData,
    reply: `${summary}\n\n${t(language, 'confirm_prompt')}`,
  };
}

// ---------------------------------------------------------------------------
// Easyrent API calls (Step 9)
// ---------------------------------------------------------------------------

/**
 * Create the primary customer + all group members in Easyrent, then submit
 * the reservation. Returns the reservation code string.
 */
async function createEasyrentReservation(
  data: InternalData,
  shopConfig: ShopEasyrentConfig,
): Promise<string> {
  const skillId = data.skillLevel ? skillToEasyrentId(data.skillLevel) : undefined;

  // 1. Create / update primary customer
  const primaryResult = await soapCustInsertOrUpdateV2(shopConfig, {
    customer: {
      firstname: data.firstname ?? '',
      lastname: data.lastname ?? '',
      heightcm: data.heightcm,
      weightkg: data.weightkg,
      bootsize: data.bootsize,
      solemm: data.solemm,
      int_isoskiertypeid: skillId,
      languagecode: data.language,
    },
  });

  const primaryCode = primaryResult.customerresult.er_custcode;
  const groupCode = primaryResult.customerresult.er_groupcode;

  // 2. Insert additional group members (if any)
  const members = data.groupMembers ?? [];
  const memberCodes: string[] = [primaryCode];

  for (const member of members) {
    const memberResult = await soapInsertCustomerV2(shopConfig, {
      customer: {
        firstname: member.firstname,
        lastname: member.lastname,
        groupcode: groupCode,
      },
    });
    memberCodes.push(memberResult.customercode);
  }

  // 3. Link all members to the group (if group booking)
  if (members.length > 0) {
    await soapSetGroupCustomerV2(shopConfig, {
      customer: memberCodes.map((code) => ({
        customercode: code,
        groupcode: groupCode,
      })),
    });
  }

  // 4. Create the reservation
  // TODO: reservationData body structure is unconfirmed — must be validated
  // against a live Easyrent instance before going to production.
  // The body below is a best-effort placeholder based on the SOAP model.
  // rentalGroupIds are resolved in handleEquipmentWithAvailability().
  const reservationData = {
    customerCode: primaryCode,
    groupCode: members.length > 0 ? groupCode : undefined,
    branchId: shopConfig.branchId,
    dateFrom: data.datefrom,
    dateTo: data.dateto,
    positions: (data.rentalGroupIds ?? []).flatMap((rentalGroupId) =>
      [primaryCode, ...memberCodes.slice(1)].map((code) => ({
        rentalGroupId,
        customerCode: code,
        quantity: 1,
      })),
    ),
  };

  const reservationResult = await restInsertUpdateReservation(
    shopConfig,
    reservationData,
  );

  const code =
    reservationResult.reservationCode ??
    String(reservationResult.reservationId ?? 'N/A');

  return code;
}

// ---------------------------------------------------------------------------
// Availability check + rental group resolution (called during Step EQUIPMENT)
// ---------------------------------------------------------------------------

/**
 * Fetch rental groups from Easyrent and attempt to resolve the selected
 * equipment type to one or more er_rentalgroupid values.
 *
 * TODO: The name-matching logic below is a heuristic. Confirm the actual
 * rental group names in Easyrent and adjust the keywords accordingly.
 * Per-shop overrides (stored in shop config) would be cleaner long-term.
 */
async function resolveRentalGroupIds(
  equipmentType: EquipmentType,
  shopConfig: ShopEasyrentConfig,
): Promise<number[]> {
  let groups;
  try {
    groups = await restGetRentalGroups(shopConfig);
  } catch {
    // Non-fatal: if we can't fetch groups, skip availability check
    return [];
  }

  const keywords: Record<EquipmentType, string[]> = {
    ski: ['ski'],
    snowboard: ['snowboard', 'board'],
    both: ['ski', 'snowboard', 'board'],
  };
  const kw = keywords[equipmentType];

  const matched = groups
    .filter((g) => {
      const name = (g.name ?? '').toLowerCase();
      return kw.some((k) => name.includes(k));
    })
    .map((g) => g.er_rentalgroupid)
    .filter((id): id is number => typeof id === 'number');

  return matched;
}

/**
 * Check availability for the collected dates + equipment type.
 * Returns 'available', 'none', or 'error'.
 */
async function checkAvailability(
  data: InternalData,
  shopConfig: ShopEasyrentConfig,
): Promise<'available' | 'none' | 'error'> {
  const rentalGroupIds = data.rentalGroupIds ?? [];
  if (!rentalGroupIds.length || !data.datefrom || !data.dateto) {
    return 'error';
  }

  try {
    const results = await restGetAvailCount(
      shopConfig,
      rentalGroupIds.map((id) => ({
        er_rentalgroupid: id,
        datefrom: data.datefrom!,
        dateto: data.dateto!,
        er_branchid: shopConfig.branchId,
      })),
    );

    const hasAvailability = results.some((r) => r.availcount > 0);
    return hasAvailability ? 'available' : 'none';
  } catch {
    return 'error';
  }
}

// ---------------------------------------------------------------------------
// Main state processor
// ---------------------------------------------------------------------------

/**
 * Load a shop row by ID. Returns null if not found or inactive.
 */
async function loadShop(shopId: string): Promise<ShopRow | null> {
  const { rows } = await pool.query<ShopRow>(
    `SELECT id, name, easyrent_soap_url, easyrent_rest_base_url,
            easyrent_accessid, easyrent_branchid, languages
     FROM shops WHERE id = $1 AND active = true`,
    [shopId],
  );
  return rows[0] ?? null;
}

/**
 * Load the most recent active conversation for this phone + shop pair.
 * Returns null if none exists.
 */
async function loadConversation(
  shopId: string,
  waPhone: string,
): Promise<ConversationRow | null> {
  const { rows } = await pool.query<ConversationRow>(
    `SELECT id, shop_id, wa_phone, step, language, data, status, expires_at
     FROM conversations
     WHERE wa_phone = $1 AND shop_id = $2 AND status = 'active'
     ORDER BY created_at DESC
     LIMIT 1`,
    [waPhone, shopId],
  );
  return rows[0] ?? null;
}

/**
 * Create a new conversation row.
 */
async function createConversation(
  shopId: string,
  waPhone: string,
  ttlHours: number,
): Promise<ConversationRow> {
  const { rows } = await pool.query<ConversationRow>(
    `INSERT INTO conversations (shop_id, wa_phone, step, language, data, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' hours')::interval)
     RETURNING id, shop_id, wa_phone, step, language, data, status, expires_at`,
    [shopId, waPhone, ConversationStep.WELCOME, 'de', '{}', ttlHours],
  );
  return rows[0];
}

/**
 * Persist step, data, and extend expires_at for the sliding TTL window.
 */
async function saveConversation(
  conversationId: string,
  step: ConversationStep,
  data: InternalData,
  language: Language,
  ttlHours: number,
): Promise<void> {
  await pool.query(
    `UPDATE conversations
     SET step = $1, data = $2, language = $3,
         expires_at = NOW() + ($4 || ' hours')::interval,
         updated_at = NOW()
     WHERE id = $5`,
    [step, JSON.stringify(data), language, ttlHours, conversationId],
  );
}

/**
 * Mark a conversation as expired.
 */
async function expireConversation(conversationId: string): Promise<void> {
  await pool.query(
    `UPDATE conversations SET status = 'expired', updated_at = NOW() WHERE id = $1`,
    [conversationId],
  );
}

/**
 * Mark a conversation as completed and save the final data.
 */
async function completeConversation(
  conversationId: string,
  data: InternalData,
): Promise<void> {
  await pool.query(
    `UPDATE conversations SET status = 'completed', step = $1, data = $2, updated_at = NOW()
     WHERE id = $3`,
    [ConversationStep.DONE, JSON.stringify(data), conversationId],
  );
}

/**
 * Persist a completed reservation to the reservations table.
 */
async function saveReservation(
  shopId: string,
  conversationId: string,
  customerCode: string,
  groupCode: string,
  reservationCode: string,
  data: InternalData,
): Promise<void> {
  await pool.query(
    `INSERT INTO reservations
       (shop_id, conversation_id, easyrent_customer_code, easyrent_group_code,
        easyrent_reservation_code, status, data)
     VALUES ($1, $2, $3, $4, $5, 'confirmed', $6)`,
    [
      shopId,
      conversationId,
      customerCode,
      groupCode,
      reservationCode,
      JSON.stringify(data),
    ],
  );
}

// ---------------------------------------------------------------------------
// Exported entry point
// ---------------------------------------------------------------------------

/**
 * Process one inbound WhatsApp message and return the reply string.
 *
 * This is the single public interface of the state machine.
 * It is called by the webhook handler for every inbound message.
 *
 * Never throws — any unhandled error results in a user-friendly error reply.
 */
export async function processMessage(
  shopId: string,
  waPhone: string,
  incomingText: string,
): Promise<string> {
  // 1. Load shop config
  let shop: ShopRow | null;
  try {
    shop = await loadShop(shopId);
  } catch (err) {
    console.error('[stateMachine] DB error loading shop:', err);
    return t('en', 'error_generic');
  }

  if (!shop) {
    console.warn('[stateMachine] Shop not found or inactive:', shopId);
    return t('en', 'error_generic');
  }

  const shopConfig: ShopEasyrentConfig = {
    soapUrl: shop.easyrent_soap_url,
    restBaseUrl: shop.easyrent_rest_base_url,
    accessId: shop.easyrent_accessid,
    branchId: shop.easyrent_branchid,
  };

  // 2. Load or create conversation
  let conversation: ConversationRow | null;
  try {
    conversation = await loadConversation(shopId, waPhone);
  } catch (err) {
    console.error('[stateMachine] DB error loading conversation:', err);
    return t('en', 'error_generic');
  }

  const ttl = config.conversationTtlHours;

  if (!conversation) {
    try {
      conversation = await createConversation(shopId, waPhone, ttl);
    } catch (err) {
      console.error('[stateMachine] DB error creating conversation:', err);
      return t('en', 'error_generic');
    }
  }

  const language: Language = conversation.language ?? 'de';

  // 3. Check expiry — reset if expired
  if (new Date(conversation.expires_at) < new Date()) {
    try {
      await expireConversation(conversation.id);
      conversation = await createConversation(shopId, waPhone, ttl);
    } catch (err) {
      console.error('[stateMachine] DB error resetting expired conversation:', err);
      return t(language, 'error_generic');
    }
    return t(language, 'session_expired', { shopName: shop.name });
  }

  const currentStep = conversation.step as ConversationStep;
  const data: InternalData = conversation.data ?? {};

  // 4. Route to step handler
  try {
    return await routeStep(
      currentStep,
      data,
      incomingText,
      language,
      shop,
      shopConfig,
      conversation.id,
      ttl,
    );
  } catch (err) {
    console.error('[stateMachine] Unhandled error in step handler:', err);
    return t(language, 'error_generic');
  }
}

/**
 * Route the incoming message to the correct handler for `currentStep`.
 * Handles step transitions, DB saves, and Easyrent API calls.
 */
async function routeStep(
  currentStep: ConversationStep,
  data: InternalData,
  input: string,
  language: Language,
  shop: ShopRow,
  shopConfig: ShopEasyrentConfig,
  conversationId: string,
  ttl: number,
): Promise<string> {
  let result: StepResult | null = null;

  switch (currentStep) {
    case ConversationStep.WELCOME: {
      const langResult = handleLanguageSelection(input, shop.name);
      if (!langResult) {
        return t(language, 'language_invalid');
      }
      result = langResult;
      break;
    }

    case ConversationStep.NAME_FIRST: {
      result = handleNameFirst(data, input);
      if (!result) return t(language, 'name_invalid');
      break;
    }

    case ConversationStep.NAME_LAST: {
      result = handleNameLast(data, input);
      if (!result) return t(language, 'name_invalid');
      break;
    }

    case ConversationStep.DATE_FROM: {
      const r = handleDateFrom(data, input);
      if (r === 'invalid') return t(language, 'date_invalid');
      if (r === 'past') return t(language, 'date_past');
      result = r;
      break;
    }

    case ConversationStep.DATE_TO: {
      const r = handleDateTo(data, input);
      if (r === 'invalid') return t(language, 'date_invalid');
      if (r === 'past') return t(language, 'date_past');
      if (r === 'order') return t(language, 'date_order');
      result = r;
      break;
    }

    case ConversationStep.EQUIPMENT: {
      const baseResult = handleEquipment(data, input);
      if (!baseResult) return t(language, 'equipment_invalid');

      // Resolve rental group IDs + check availability
      const updatedData = baseResult.updatedData;
      if (updatedData.equipmentType) {
        const rentalGroupIds = await resolveRentalGroupIds(
          updatedData.equipmentType,
          shopConfig,
        );
        updatedData.rentalGroupIds = rentalGroupIds;

        if (rentalGroupIds.length > 0) {
          const availability = await checkAvailability(updatedData, shopConfig);
          if (availability === 'none') {
            return t(language, 'availability_none');
          }
          if (availability === 'error') {
            // Non-fatal — warn but continue
            console.warn('[stateMachine] Availability check failed, proceeding anyway');
          }
        }
      }

      result = baseResult;
      break;
    }

    case ConversationStep.SKILL: {
      result = handleSkill(data, input);
      if (!result) return t(language, 'skill_invalid');
      break;
    }

    case ConversationStep.PHYSICAL_HEIGHT: {
      const r = handlePhysicalHeight(data, input);
      if (r === 'invalid') return t(language, 'physical_height_invalid');
      result = r;
      break;
    }

    case ConversationStep.PHYSICAL_WEIGHT: {
      const r = handlePhysicalWeight(data, input);
      if (r === 'invalid') return t(language, 'physical_weight_invalid');
      result = r;
      break;
    }

    case ConversationStep.PHYSICAL_BOOT: {
      const r = handlePhysicalBoot(data, input);
      if (r === 'invalid') return t(language, 'physical_number_invalid');
      result = r;
      break;
    }

    case ConversationStep.PHYSICAL_SOLE: {
      const r = handlePhysicalSole(data, input);
      if (r === 'invalid') return t(language, 'physical_sole_invalid');
      result = r;
      break;
    }

    case ConversationStep.GROUP_SIZE: {
      const r = handleGroupSize(data, input);
      if (r === 'invalid') return t(language, 'group_size_invalid');
      result = r;
      break;
    }

    case ConversationStep.GROUP_MEMBER: {
      const r = handleGroupMember(data, input);
      if (r === 'invalid') return t(language, 'physical_number_invalid');
      result = r;
      break;
    }

    case ConversationStep.CONFIRM: {
      const answer = normalizeYesNo(input, language);
      if (!answer) return t(language, 'confirm_invalid');

      if (answer === 'no') {
        await pool.query(
          `UPDATE conversations SET status = 'abandoned', updated_at = NOW() WHERE id = $1`,
          [conversationId],
        );
        return t(language, 'confirm_cancelled');
      }

      // User confirmed — create reservation in Easyrent
      let reservationCode: string;
      try {
        reservationCode = await createEasyrentReservation(data, shopConfig);
      } catch (err) {
        console.error('[stateMachine] Easyrent reservation error:', err);
        if (err instanceof EasyrentError) {
          console.error('[stateMachine] EasyrentError code:', err.code);
        }
        return t(language, 'reservation_error');
      }

      // Persist reservation + complete conversation
      await saveReservation(
        shop.id,
        conversationId,
        data.easyrentCustomerCode ?? '',
        data.easyrentGroupCode ?? '',
        reservationCode,
        data,
      );
      await completeConversation(conversationId, data);

      return t(language, 'reservation_success', { code: reservationCode });
    }

    case ConversationStep.DONE: {
      // Conversation is complete — start fresh
      return t(language, 'welcome', { shopName: shop.name });
    }

    default: {
      console.warn('[stateMachine] Unknown step:', currentStep);
      return t(language, 'error_generic');
    }
  }

  // 5. Persist new state (only reached for non-terminal transitions)
  const newLanguage = result.updatedData.language ?? language;
  await saveConversation(
    conversationId,
    result.nextStep,
    result.updatedData,
    newLanguage,
    ttl,
  );

  return result.reply;
}

// ---------------------------------------------------------------------------
// Cleanup job
// ---------------------------------------------------------------------------

/**
 * Mark stale active conversations as expired.
 * Call on a periodic interval (configured via CLEANUP_INTERVAL_MS).
 * Returns the count of rows updated.
 */
export async function runCleanup(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT expire_stale_conversations() AS count`,
  );
  const count = parseInt(rows[0]?.count ?? '0', 10);
  if (count > 0) {
    console.info(`[cleanup] Marked ${count} conversation(s) as expired.`);
  }
  return count;
}
