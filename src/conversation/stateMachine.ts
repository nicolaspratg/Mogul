/**
 * AlpChat conversation state machine.
 *
 * processMessage(shopId, waPhone, incomingText) → string (reply to send)
 *
 * Flow:
 *  1. WELCOME       → language selection
 *  2. DATE_FROM     → DATE_TO
 *  3. Per-person loop (one or more people):
 *     PERSON_NAME_FIRST → PERSON_NAME_LAST → PERSON_AGE → PERSON_EQUIPMENT
 *     → (conditional) PERSON_HEIGHT → PERSON_WEIGHT → PERSON_SKILL → PERSON_SOLE
 *     → ADD_PERSON  (Yes → loop back to PERSON_NAME_FIRST | No → CONFIRM)
 *  4. CONFIRM → DONE
 *
 * Measurement rules per person:
 *  - Alpine/touring skis, XC skis, kids skis → height + weight
 *  - Alpine/touring skis (adults) → also skill level (1–3)
 *  - Alpine/touring/kids skis AND no boots rented → also sole length (mm)
 *  - All boots, snowboard, helmets, accessories → no measurements
 */

import { pool } from '../db/pool';
import { config } from '../config';
import { t } from '../i18n';
import {
  EasyrentError,
  type Language,
  type EquipmentItem,
  type SkillLevel,
  type GroupMember,
  type ConversationData,
} from '../types/easyrent';
import type { ShopEasyrentConfig } from '../integrations/easyrent/soapClient';
import {
  soapCustInsertOrUpdateV2,
  soapSetGroupCustomerV2,
} from '../integrations/easyrent/soapClient';
import { restInsertUpdateReservation } from '../integrations/easyrent/restClient';

// ---------------------------------------------------------------------------
// Equipment catalog
// ---------------------------------------------------------------------------

interface CatalogItem {
  num: number;
  key: EquipmentItem;
  labelKey: string;
}

interface CatalogSection {
  titleKey: string;
  items: CatalogItem[];
}

const ADULT_CATALOG_SECTIONS: CatalogSection[] = [
  {
    titleKey: 'equipment_section_alpine',
    items: [
      { num: 1,  key: 'ski_factory_test',     labelKey: 'equipment_item_ski_factory_test' },
      { num: 2,  key: 'ski_diamond',           labelKey: 'equipment_item_ski_diamond' },
      { num: 3,  key: 'ski_premium',           labelKey: 'equipment_item_ski_premium' },
      { num: 4,  key: 'ski_economy',           labelKey: 'equipment_item_ski_economy' },
      { num: 5,  key: 'ski_basic',             labelKey: 'equipment_item_ski_basic' },
    ],
  },
  {
    titleKey: 'equipment_section_ski_boots',
    items: [
      { num: 6,  key: 'ski_boots_premium',     labelKey: 'equipment_item_ski_boots_premium' },
      { num: 7,  key: 'ski_boots_economy',     labelKey: 'equipment_item_ski_boots_economy' },
    ],
  },
  {
    titleKey: 'equipment_section_snowboard',
    items: [
      { num: 8,  key: 'snowboard_premium',     labelKey: 'equipment_item_snowboard_premium' },
      { num: 9,  key: 'snowboard_economy',     labelKey: 'equipment_item_snowboard_economy' },
      { num: 10, key: 'snowboard_boots',       labelKey: 'equipment_item_snowboard_boots' },
    ],
  },
  {
    titleKey: 'equipment_section_xc',
    items: [
      { num: 11, key: 'xc_classic',            labelKey: 'equipment_item_xc_classic' },
      { num: 12, key: 'xc_classic_boots',      labelKey: 'equipment_item_xc_classic_boots' },
      { num: 13, key: 'xc_skating',            labelKey: 'equipment_item_xc_skating' },
      { num: 14, key: 'xc_skating_boots',      labelKey: 'equipment_item_xc_skating_boots' },
    ],
  },
  {
    titleKey: 'equipment_section_touring',
    items: [
      { num: 15, key: 'touring_ski',           labelKey: 'equipment_item_touring_ski' },
      { num: 16, key: 'touring_boots',         labelKey: 'equipment_item_touring_boots' },
      { num: 17, key: 'touring_backpack',      labelKey: 'equipment_item_touring_backpack' },
      { num: 18, key: 'touring_radar',         labelKey: 'equipment_item_touring_radar' },
      { num: 19, key: 'touring_shovel',        labelKey: 'equipment_item_touring_shovel' },
      { num: 20, key: 'touring_avalanche_bag', labelKey: 'equipment_item_touring_avalanche_bag' },
      { num: 21, key: 'touring_probe',         labelKey: 'equipment_item_touring_probe' },
    ],
  },
  {
    titleKey: 'equipment_section_other',
    items: [
      { num: 22, key: 'helmet_visor',          labelKey: 'equipment_item_helmet_visor' },
      { num: 23, key: 'helmet_no_visor',       labelKey: 'equipment_item_helmet_no_visor' },
      { num: 24, key: 'snowshoes',             labelKey: 'equipment_item_snowshoes' },
      { num: 25, key: 'sleigh',                labelKey: 'equipment_item_sleigh' },
    ],
  },
];

const KIDS_CATALOG_SECTIONS: CatalogSection[] = [
  {
    titleKey: 'equipment_section_kids',
    items: [
      { num: 1, key: 'kids_ski',        labelKey: 'equipment_item_kids_ski' },
      { num: 2, key: 'kids_boots',      labelKey: 'equipment_item_kids_boots' },
    ],
  },
  {
    titleKey: 'equipment_section_other',
    items: [
      { num: 3, key: 'helmet_visor',    labelKey: 'equipment_item_helmet_visor' },
      { num: 4, key: 'helmet_no_visor', labelKey: 'equipment_item_helmet_no_visor' },
      { num: 5, key: 'snowshoes',       labelKey: 'equipment_item_snowshoes' },
      { num: 6, key: 'sleigh',          labelKey: 'equipment_item_sleigh' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Equipment logic helpers
// ---------------------------------------------------------------------------

const ALPINE_TOURING_SKI_ITEMS: EquipmentItem[] = [
  'ski_factory_test', 'ski_diamond', 'ski_premium', 'ski_economy', 'ski_basic', 'touring_ski',
];
const XC_SKI_ITEMS: EquipmentItem[] = ['xc_classic', 'xc_skating'];
const KIDS_SKI_ITEMS: EquipmentItem[] = ['kids_ski'];
const BOOT_ITEMS: EquipmentItem[] = [
  'ski_boots_premium', 'ski_boots_economy', 'touring_boots', 'kids_boots',
];

function hasAlpineOrTouringSki(items: EquipmentItem[]): boolean {
  return items.some(i => ALPINE_TOURING_SKI_ITEMS.includes(i));
}
function hasKidsSki(items: EquipmentItem[]): boolean {
  return items.some(i => KIDS_SKI_ITEMS.includes(i));
}
function hasXcSki(items: EquipmentItem[]): boolean {
  return items.some(i => XC_SKI_ITEMS.includes(i));
}
function hasBoots(items: EquipmentItem[]): boolean {
  return items.some(i => BOOT_ITEMS.includes(i));
}

/** Height + weight required */
function needsMeasurements(items: EquipmentItem[]): boolean {
  return hasAlpineOrTouringSki(items) || hasKidsSki(items) || hasXcSki(items);
}

/** Skill level required (alpine + touring skis only, not XC, not kids) */
function needsSkillLevel(items: EquipmentItem[]): boolean {
  return hasAlpineOrTouringSki(items);
}

/** Sole length required: ski present but no boots rented */
function needsSoleLength(items: EquipmentItem[]): boolean {
  return (hasAlpineOrTouringSki(items) || hasKidsSki(items)) && !hasBoots(items);
}

// ---------------------------------------------------------------------------
// ConversationStep enum
// ---------------------------------------------------------------------------

export enum ConversationStep {
  WELCOME           = 'welcome',
  DATE_FROM         = 'date_from',
  DATE_TO           = 'date_to',
  PERSON_NAME_FIRST = 'person_name_first',
  PERSON_NAME_LAST  = 'person_name_last',
  PERSON_AGE        = 'person_age',
  PERSON_EQUIPMENT  = 'person_equipment',
  PERSON_HEIGHT     = 'person_height',
  PERSON_WEIGHT     = 'person_weight',
  PERSON_SKILL      = 'person_skill',
  PERSON_SOLE       = 'person_sole',
  ADD_PERSON        = 'add_person',
  CONFIRM           = 'confirm',
  DONE              = 'done',
}

interface InternalData extends ConversationData {
  currentMember?: Partial<GroupMember>;
  /** Placeholder for future availability check — needs rework for multi-item bookings. */
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

function parseDate(input: string): string | null {
  const trimmed = input.trim();
  const dmyMatch = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(trimmed);
  if (dmyMatch) {
    const [, d, m, y] = dmyMatch;
    const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    const date = new Date(iso);
    if (!isNaN(date.getTime())) return iso;
  }
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
    de: ['ja', 'j', 'yes', 'y', 'ok', '1'],
    en: ['yes', 'y', 'ja', 'ok', '1'],
    it: ['si', 'sì', 's', 'yes', 'y', 'ok', '1'],
  };
  const noTokens: Record<Language, string[]> = {
    de: ['nein', 'n', 'no', 'abbrechen', '2'],
    en: ['no', 'n', 'nein', 'cancel', '2'],
    it: ['no', 'n', 'cancel', '2'],
  };
  if (yesTokens[language].includes(lower)) return 'yes';
  if (noTokens[language].includes(lower)) return 'no';
  return null;
}

function skillFromInput(input: string): SkillLevel | null {
  const map: Record<string, SkillLevel> = {
    '1': 'beginner', '2': 'intermediate', '3': 'advanced',
    beginner: 'beginner', intermediate: 'intermediate', advanced: 'advanced',
    anfänger: 'beginner', fortgeschritten: 'intermediate', experte: 'advanced',
  };
  return map[input.trim().toLowerCase()] ?? null;
}

function skillToEasyrentId(skill: SkillLevel): number {
  const map: Record<SkillLevel, number> = { beginner: 1, intermediate: 2, advanced: 3 };
  return map[skill];
}

function skillLabel(skill: SkillLevel, language: Language): string {
  const keyMap: Record<SkillLevel, string> = {
    beginner: 'skill_beginner', intermediate: 'skill_intermediate', advanced: 'skill_advanced',
  };
  return t(language, keyMap[skill]);
}

// ---------------------------------------------------------------------------
// Equipment catalog helpers
// ---------------------------------------------------------------------------

function getCatalogSections(age: number): CatalogSection[] {
  return age <= 14 ? KIDS_CATALOG_SECTIONS : ADULT_CATALOG_SECTIONS;
}

function buildEquipmentMenu(sections: CatalogSection[], language: Language): string {
  const lines: string[] = [];
  for (const section of sections) {
    lines.push(t(language, section.titleKey) + ':');
    for (const item of section.items) {
      lines.push(`${item.num} - ${t(language, item.labelKey)}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function buildEquipmentPrompt(age: number, firstname: string, language: Language): string {
  const sections = getCatalogSections(age);
  const header = t(language, 'person_equipment_prompt_header', { firstname });
  const menu = buildEquipmentMenu(sections, language);
  return `${header}\n\n${menu}`;
}

function parseEquipmentSelection(input: string, age: number): EquipmentItem[] | null {
  const sections = getCatalogSections(age);
  const allItems = sections.flatMap(s => s.items);
  const numToKey = new Map(allItems.map(i => [i.num, i.key]));

  const parts = input.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return null;

  const selected: EquipmentItem[] = [];
  for (const part of parts) {
    const num = parseInt(part.trim(), 10);
    if (isNaN(num)) return null;
    const key = numToKey.get(num);
    if (!key) return null;
    if (!selected.includes(key)) selected.push(key);
  }
  return selected.length > 0 ? selected : null;
}

function equipmentLabels(items: EquipmentItem[], language: Language): string {
  const allSections = [...ADULT_CATALOG_SECTIONS, ...KIDS_CATALOG_SECTIONS];
  const keyToLabelKey = new Map(allSections.flatMap(s => s.items).map(i => [i.key, i.labelKey]));
  return items.map(item => t(language, keyToLabelKey.get(item) ?? item)).join(', ');
}

// ---------------------------------------------------------------------------
// Measurement step router
// ---------------------------------------------------------------------------

/**
 * After saving a measurement value, determine the next step + prompt.
 * Called after PERSON_EQUIPMENT and each measurement step.
 * Returns ADD_PERSON when all required measurements are collected.
 */
function nextMeasurementStep(
  member: Partial<GroupMember>,
  language: Language,
): { step: ConversationStep; prompt: string } {
  const items = member.equipment ?? [];

  if (needsMeasurements(items) && member.heightcm === undefined) {
    return { step: ConversationStep.PERSON_HEIGHT, prompt: t(language, 'person_height_prompt') };
  }
  if (needsMeasurements(items) && member.weightkg === undefined) {
    return { step: ConversationStep.PERSON_WEIGHT, prompt: t(language, 'person_weight_prompt') };
  }
  if (needsSkillLevel(items) && member.skillLevel === undefined) {
    return { step: ConversationStep.PERSON_SKILL, prompt: t(language, 'person_skill_prompt') };
  }
  if (needsSoleLength(items) && member.solemm === undefined) {
    return { step: ConversationStep.PERSON_SOLE, prompt: t(language, 'person_sole_prompt') };
  }

  return { step: ConversationStep.ADD_PERSON, prompt: t(language, 'add_person_prompt') };
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(data: InternalData, language: Language): string {
  const lines: string[] = [t(language, 'summary_header'), ''];

  lines.push(
    t(language, 'summary_dates', {
      datefrom: data.datefrom ? isoToDisplay(data.datefrom) : '',
      dateto: data.dateto ? isoToDisplay(data.dateto) : '',
    }),
  );

  const members = data.members ?? [];
  members.forEach((m, i) => {
    lines.push('');
    lines.push(
      t(language, 'summary_person_header', {
        index: i + 1,
        firstname: m.firstname,
        lastname: m.lastname,
        age: m.age,
      }),
    );
    lines.push(
      t(language, 'summary_person_equipment', {
        equipment: equipmentLabels(m.equipment, language),
      }),
    );
    if (m.heightcm !== undefined && m.weightkg !== undefined) {
      lines.push(
        t(language, 'summary_person_measurements', {
          height: m.heightcm,
          weight: m.weightkg,
        }),
      );
    }
    if (m.skillLevel !== undefined) {
      lines.push(t(language, 'summary_person_skill', { skill: skillLabel(m.skillLevel, language) }));
    }
    if (m.solemm !== undefined) {
      lines.push(t(language, 'summary_person_sole', { sole: m.solemm }));
    }
  });

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Step handlers
// ---------------------------------------------------------------------------

function handleLanguageSelection(input: string): StepResult | null {
  const choice = input.trim();
  let language: Language;

  if (choice === '1' || choice.toLowerCase() === 'de' || choice.toLowerCase() === 'deutsch') {
    language = 'de';
  } else if (choice === '2' || choice.toLowerCase() === 'en' || choice.toLowerCase() === 'english') {
    language = 'en';
  } else if (choice === '3' || choice.toLowerCase() === 'it' || choice.toLowerCase() === 'italiano') {
    return {
      nextStep: ConversationStep.WELCOME,
      updatedData: { language: 'en' },
      reply: t('en', 'language_it_unavailable'),
    };
  } else {
    return null;
  }

  return {
    nextStep: ConversationStep.DATE_FROM,
    updatedData: { language },
    reply: t(language, 'date_from_prompt'),
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
    nextStep: ConversationStep.PERSON_NAME_FIRST,
    updatedData: { ...data, dateto: iso, members: [] },
    reply: t(data.language, 'person_first_intro') + '\n' + t(data.language, 'person_name_first_prompt'),
  };
}

function handlePersonNameFirst(data: InternalData, input: string): StepResult | null {
  const name = input.trim();
  if (!name) return null;
  return {
    nextStep: ConversationStep.PERSON_NAME_LAST,
    updatedData: { ...data, currentMember: { ...data.currentMember, firstname: name } },
    reply: t(data.language, 'person_name_last_prompt'),
  };
}

function handlePersonNameLast(data: InternalData, input: string): StepResult | null {
  const name = input.trim();
  if (!name) return null;
  return {
    nextStep: ConversationStep.PERSON_AGE,
    updatedData: { ...data, currentMember: { ...data.currentMember, lastname: name } },
    reply: t(data.language, 'person_age_prompt'),
  };
}

function handlePersonAge(data: InternalData, input: string): StepResult | null {
  const n = parsePositiveInt(input);
  if (!n || n > 99) return null;
  const member = { ...data.currentMember, age: n };
  return {
    nextStep: ConversationStep.PERSON_EQUIPMENT,
    updatedData: { ...data, currentMember: member },
    reply: buildEquipmentPrompt(n, member.firstname ?? '', data.language),
  };
}

function handlePersonEquipment(
  data: InternalData,
  input: string,
): StepResult | 'invalid' | 'none' {
  const age = data.currentMember?.age ?? 99;
  const selected = parseEquipmentSelection(input, age);
  if (!selected) return 'invalid';
  if (selected.length === 0) return 'none';

  const member = { ...data.currentMember, equipment: selected };
  const { step, prompt } = nextMeasurementStep(member, data.language);
  return {
    nextStep: step,
    updatedData: { ...data, currentMember: member },
    reply: prompt,
  };
}

function handlePersonHeight(data: InternalData, input: string): StepResult | 'invalid' {
  const n = parsePositiveFloat(input);
  if (!n || n < 80 || n > 230) return 'invalid';
  const member = { ...data.currentMember, heightcm: Math.round(n) };
  const { step, prompt } = nextMeasurementStep(member, data.language);
  return {
    nextStep: step,
    updatedData: { ...data, currentMember: member },
    reply: prompt,
  };
}

function handlePersonWeight(data: InternalData, input: string): StepResult | 'invalid' {
  const n = parsePositiveFloat(input);
  if (!n || n < 10 || n > 200) return 'invalid';
  const member = { ...data.currentMember, weightkg: Math.round(n) };
  const { step, prompt } = nextMeasurementStep(member, data.language);
  return {
    nextStep: step,
    updatedData: { ...data, currentMember: member },
    reply: prompt,
  };
}

function handlePersonSkill(data: InternalData, input: string): StepResult | null {
  const skill = skillFromInput(input);
  if (!skill) return null;
  const member = { ...data.currentMember, skillLevel: skill };
  const { step, prompt } = nextMeasurementStep(member, data.language);
  return {
    nextStep: step,
    updatedData: { ...data, currentMember: member },
    reply: prompt,
  };
}

function handlePersonSole(data: InternalData, input: string): StepResult | 'invalid' {
  const n = parsePositiveFloat(input);
  if (!n || n < 150 || n > 380) return 'invalid';
  const member = { ...data.currentMember, solemm: Math.round(n) };
  const { step, prompt } = nextMeasurementStep(member, data.language);
  return {
    nextStep: step,
    updatedData: { ...data, currentMember: member },
    reply: prompt,
  };
}

function handleAddPerson(data: InternalData, input: string): StepResult | null {
  const answer = normalizeYesNo(input, data.language);
  if (!answer) return null;

  // Finalize current member
  const currentMember = data.currentMember as GroupMember;
  const members = [...(data.members ?? []), currentMember];
  const nextPersonNumber = members.length + 1;

  if (answer === 'yes') {
    return {
      nextStep: ConversationStep.PERSON_NAME_FIRST,
      updatedData: { ...data, members, currentMember: undefined },
      reply:
        t(data.language, 'person_next_intro', { index: nextPersonNumber }) +
        '\n' +
        t(data.language, 'person_name_first_prompt'),
    };
  }

  // 'no' → show full summary and request confirmation
  const summary = buildSummary({ ...data, members, currentMember: undefined }, data.language);
  return {
    nextStep: ConversationStep.CONFIRM,
    updatedData: { ...data, members, currentMember: undefined },
    reply: `${summary}\n\n${t(data.language, 'confirm_prompt')}`,
  };
}

// ---------------------------------------------------------------------------
// Easyrent API calls
// ---------------------------------------------------------------------------

async function createEasyrentReservation(
  data: InternalData,
  shopConfig: ShopEasyrentConfig,
): Promise<string> {
  const members = data.members ?? [];
  if (members.length === 0) throw new Error('No members in reservation');

  const primary = members[0];

  // 1. Create / update primary customer
  const primaryResult = await soapCustInsertOrUpdateV2(shopConfig, {
    customer: {
      firstname: primary.firstname,
      lastname: primary.lastname,
      heightcm: primary.heightcm,
      weightkg: primary.weightkg,
      solemm: primary.solemm,
      int_isoskiertypeid: primary.skillLevel ? skillToEasyrentId(primary.skillLevel) : undefined,
      languagecode: data.language,
    },
  });

  const primaryCode = primaryResult.customerresult.er_custcode;
  const groupCode = primaryResult.customerresult.er_groupcode;

  // 2. Create additional group members
  const memberCodes: string[] = [primaryCode];
  for (const member of members.slice(1)) {
    const result = await soapCustInsertOrUpdateV2(shopConfig, {
      customer: {
        firstname: member.firstname,
        lastname: member.lastname,
        heightcm: member.heightcm,
        weightkg: member.weightkg,
        solemm: member.solemm,
        int_isoskiertypeid: member.skillLevel ? skillToEasyrentId(member.skillLevel) : undefined,
        er_groupcode: groupCode,
        languagecode: data.language,
      },
    });
    memberCodes.push(result.customerresult.er_custcode);
  }

  // 3. Link all members to the group
  if (members.length > 1) {
    await soapSetGroupCustomerV2(shopConfig, {
      customer: memberCodes.map(code => ({ customercode: code, groupcode: groupCode })),
    });
  }

  // 4. Create the reservation
  // TODO: reservationData body must be confirmed against live Easyrent before production.
  const reservationData = {
    customerCode: primaryCode,
    groupCode: members.length > 1 ? groupCode : undefined,
    branchId: shopConfig.branchId,
    dateFrom: data.datefrom,
    dateTo: data.dateto,
    positions: (data.rentalGroupIds ?? []).flatMap(rentalGroupId =>
      memberCodes.map(code => ({ rentalGroupId, customerCode: code, quantity: 1 })),
    ),
  };

  const reservationResult = await restInsertUpdateReservation(shopConfig, reservationData);
  return reservationResult.reservationCode ?? String(reservationResult.reservationId ?? 'N/A');
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function loadShop(shopId: string): Promise<ShopRow | null> {
  const { rows } = await pool.query<ShopRow>(
    `SELECT id, name, easyrent_soap_url, easyrent_rest_base_url,
            easyrent_accessid, easyrent_branchid, languages
     FROM shops WHERE id = $1 AND active = true`,
    [shopId],
  );
  return rows[0] ?? null;
}

async function loadConversation(shopId: string, waPhone: string): Promise<ConversationRow | null> {
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

async function expireConversation(conversationId: string): Promise<void> {
  await pool.query(
    `UPDATE conversations SET status = 'expired', updated_at = NOW() WHERE id = $1`,
    [conversationId],
  );
}

async function completeConversation(conversationId: string, data: InternalData): Promise<void> {
  await pool.query(
    `UPDATE conversations SET status = 'completed', step = $1, data = $2, updated_at = NOW()
     WHERE id = $3`,
    [ConversationStep.DONE, JSON.stringify(data), conversationId],
  );
}

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
    [shopId, conversationId, customerCode, groupCode, reservationCode, JSON.stringify(data)],
  );
}

// ---------------------------------------------------------------------------
// Exported entry point
// ---------------------------------------------------------------------------

/**
 * Process one inbound WhatsApp message and return the reply string.
 * Never throws — any unhandled error results in a user-friendly error reply.
 */
export async function processMessage(
  shopId: string,
  waPhone: string,
  incomingText: string,
): Promise<string> {
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

  // Check expiry — reset if expired
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

  try {
    return await routeStep(currentStep, data, incomingText, language, shop, shopConfig, conversation.id, ttl);
  } catch (err) {
    console.error('[stateMachine] Unhandled error in step handler:', err);
    return t(language, 'error_generic');
  }
}

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
      const r = handleLanguageSelection(input);
      if (!r) return t(language, 'language_invalid');
      result = r;
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

    case ConversationStep.PERSON_NAME_FIRST: {
      result = handlePersonNameFirst(data, input);
      if (!result) return t(language, 'name_invalid');
      break;
    }

    case ConversationStep.PERSON_NAME_LAST: {
      result = handlePersonNameLast(data, input);
      if (!result) return t(language, 'name_invalid');
      break;
    }

    case ConversationStep.PERSON_AGE: {
      result = handlePersonAge(data, input);
      if (!result) return t(language, 'person_age_invalid');
      break;
    }

    case ConversationStep.PERSON_EQUIPMENT: {
      const r = handlePersonEquipment(data, input);
      if (r === 'invalid') return t(language, 'person_equipment_invalid');
      if (r === 'none') return t(language, 'person_equipment_none');
      result = r;
      break;
    }

    case ConversationStep.PERSON_HEIGHT: {
      const r = handlePersonHeight(data, input);
      if (r === 'invalid') return t(language, 'person_height_invalid');
      result = r;
      break;
    }

    case ConversationStep.PERSON_WEIGHT: {
      const r = handlePersonWeight(data, input);
      if (r === 'invalid') return t(language, 'person_weight_invalid');
      result = r;
      break;
    }

    case ConversationStep.PERSON_SKILL: {
      result = handlePersonSkill(data, input);
      if (!result) return t(language, 'person_skill_invalid');
      break;
    }

    case ConversationStep.PERSON_SOLE: {
      const r = handlePersonSole(data, input);
      if (r === 'invalid') return t(language, 'person_sole_invalid');
      result = r;
      break;
    }

    case ConversationStep.ADD_PERSON: {
      result = handleAddPerson(data, input);
      if (!result) return t(language, 'add_person_invalid');
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
      return t(language, 'welcome', { shopName: shop.name });
    }

    default: {
      console.warn('[stateMachine] Unknown step:', currentStep);
      return t(language, 'error_generic');
    }
  }

  const newLanguage = result.updatedData.language ?? language;
  await saveConversation(conversationId, result.nextStep, result.updatedData, newLanguage, ttl);
  return result.reply;
}

// ---------------------------------------------------------------------------
// Cleanup job
// ---------------------------------------------------------------------------

/**
 * Mark stale active conversations as expired.
 * Call on a periodic interval (configured via CLEANUP_INTERVAL_MS).
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
