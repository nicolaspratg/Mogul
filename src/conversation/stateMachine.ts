/**
 * Mogul conversation state machine.
 *
 * processMessage(shopId, waPhone, incomingText) → string (reply to send)
 *
 * Flow:
 *  1. WELCOME           → language selection
 *  2. DATE_FROM         → DATE_TO → BRANCH
 *  3. Per-person loop:
 *     PERSON_NAME       → PERSON_DOB → EQUIPMENT_CATEGORY
 *     ┌─ Ski:        SKI_SKILL (adults) → SKI_BOOTS → [SKI_BOOTS_TYPE | SKI_SOLE]
 *     │              → SKI_NEED → [SKI_MODEL] → HELMET → [HELMET_TYPE]
 *     │              → [MEASUREMENTS] → HOTEL
 *     ├─ Snowboard:  SNOWBOARD_BOOTS → SNOWBOARD_MODEL → HELMET → [HELMET_TYPE]
 *     │              → HOTEL
 *     └─ Other:      OTHER_CATEGORY
 *        ├─ Touring: TOURING_ITEMS → HELMET → [HELMET_TYPE] → [MEASUREMENTS] → HOTEL
 *        ├─ XC:      XC_TYPE → XC_BOOTS → MEASUREMENTS → HOTEL
 *        └─ Misc:    MISC_ITEM → HOTEL
 *     ADD_PERSON (yes → loop back | no → EMAIL → SPECIAL_REQUESTS → INSURANCE → CONFIRM)
 *  4. CONFIRM → DONE
 *
 * Measurement rule: height + weight required when equipment includes any of
 *   ski_*, kids_ski, touring_ski, xc_classic, xc_skating.
 * Skill level: asked upfront for adults in the ski branch.
 * Sole length: asked when customer has their own boots (ski branch).
 * Kids (DOB ≤ 14): skip skill level, one-touch kids ski/boots, no Other branch.
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
// Branch type
// ---------------------------------------------------------------------------

type Branch = 'ski' | 'snowboard' | 'touring' | 'xc' | 'misc';

// ---------------------------------------------------------------------------
// Equipment label map (used in summary)
// ---------------------------------------------------------------------------

const EQUIPMENT_LABEL_KEYS: Record<EquipmentItem, string> = {
  ski_factory_test:      'equipment_item_ski_factory_test',
  ski_diamond:           'equipment_item_ski_diamond',
  ski_premium:           'equipment_item_ski_premium',
  ski_economy:           'equipment_item_ski_economy',
  ski_basic:             'equipment_item_ski_basic',
  ski_boots_premium:     'equipment_item_ski_boots_premium',
  ski_boots_economy:     'equipment_item_ski_boots_economy',
  snowboard_premium:     'equipment_item_snowboard_premium',
  snowboard_economy:     'equipment_item_snowboard_economy',
  snowboard_boots:       'equipment_item_snowboard_boots',
  xc_classic:            'equipment_item_xc_classic',
  xc_classic_boots:      'equipment_item_xc_classic_boots',
  xc_skating:            'equipment_item_xc_skating',
  xc_skating_boots:      'equipment_item_xc_skating_boots',
  touring_ski:           'equipment_item_touring_ski',
  touring_boots:         'equipment_item_touring_boots',
  touring_backpack:      'equipment_item_touring_backpack',
  touring_radar:         'equipment_item_touring_radar',
  touring_shovel:        'equipment_item_touring_shovel',
  touring_avalanche_bag: 'equipment_item_touring_avalanche_bag',
  touring_probe:         'equipment_item_touring_probe',
  helmet_visor:          'equipment_item_helmet_visor',
  helmet_no_visor:       'equipment_item_helmet_no_visor',
  snowshoes:             'equipment_item_snowshoes',
  sleigh:                'equipment_item_sleigh',
  kids_ski:              'equipment_item_kids_ski',
  kids_boots:            'equipment_item_kids_boots',
};

function equipmentLabels(items: EquipmentItem[], language: Language): string {
  return items.map(item => t(language, EQUIPMENT_LABEL_KEYS[item])).join(', ');
}

// ---------------------------------------------------------------------------
// Equipment logic helpers
// ---------------------------------------------------------------------------

const MEASUREMENT_ITEMS: EquipmentItem[] = [
  'ski_factory_test', 'ski_diamond', 'ski_premium', 'ski_economy', 'ski_basic',
  'kids_ski', 'touring_ski', 'xc_classic', 'xc_skating',
];

function needsMeasurements(items: EquipmentItem[]): boolean {
  return items.some(i => MEASUREMENT_ITEMS.includes(i));
}

// ---------------------------------------------------------------------------
// Branches (example — replace with live Easyrent data when available)
// ---------------------------------------------------------------------------

const EXAMPLE_BRANCHES = [
  { id: 1, name: 'Obergurgl Zentrum', address: 'Piccardweg 5, 6456 Obergurgl' },
  { id: 2, name: 'Hochgurgl',         address: 'Hochgurglerstraße 16, 6456 Hochgurgl' },
  { id: 3, name: 'Kressbrunnen',      address: 'Kressbrunnenweg 6a, 6456 Obergurgl' },
  { id: 4, name: 'Pirchhütt',         address: 'Gurglerstraße 121, 6456 Obergurgl' },
  { id: 5, name: 'Längenfeld',        address: 'Oberlängenfeld 47, 6444 Längenfeld' },
];

// ---------------------------------------------------------------------------
// Mock prices (EUR per rental period — replace with live catalog prices)
// ---------------------------------------------------------------------------

const MOCK_PRICES: Record<EquipmentItem, number> = {
  ski_factory_test:      306,
  ski_diamond:           376,
  ski_premium:           250,
  ski_economy:           180,
  ski_basic:             120,
  ski_boots_premium:      80,
  ski_boots_economy:      50,
  snowboard_premium:     280,
  snowboard_economy:     190,
  snowboard_boots:        60,
  xc_classic:            120,
  xc_classic_boots:       40,
  xc_skating:            140,
  xc_skating_boots:       45,
  touring_ski:           200,
  touring_boots:          90,
  touring_backpack:       30,
  touring_radar:          25,
  touring_shovel:         15,
  touring_avalanche_bag:  40,
  touring_probe:          10,
  helmet_visor:           30,
  helmet_no_visor:        20,
  snowshoes:              30,
  sleigh:                 15,
  kids_ski:               60,
  kids_boots:             30,
};

const INSURANCE_RATE_ADULT = 3.50; // € per day per adult
const INSURANCE_RATE_KID   = 1.50; // € per day per child (≤ 14)

function calcRentalDays(datefrom?: string, dateto?: string): number {
  if (!datefrom || !dateto) return 1;
  const ms = new Date(dateto).getTime() - new Date(datefrom).getTime();
  return Math.max(1, Math.round(ms / (1000 * 60 * 60 * 24)));
}

function calcInsurancePrice(members: GroupMember[], datefrom?: string, dateto?: string): number {
  const days = calcRentalDays(datefrom, dateto);
  return members.reduce((sum, m) => sum + days * (isKid(m.dob) ? INSURANCE_RATE_KID : INSURANCE_RATE_ADULT), 0);
}

// ---------------------------------------------------------------------------
// ConversationStep enum
// ---------------------------------------------------------------------------

export enum ConversationStep {
  WELCOME            = 'welcome',
  DATE_FROM          = 'date_from',
  DATE_TO            = 'date_to',
  BRANCH             = 'branch',
  // Per-person
  PERSON_NAME        = 'person_name',
  PERSON_DOB         = 'person_dob',
  EQUIPMENT_CATEGORY = 'equipment_category',
  // Ski branch
  SKI_SKILL          = 'ski_skill',
  SKI_BOOTS          = 'ski_boots',
  SKI_BOOTS_TYPE     = 'ski_boots_type',
  SKI_SOLE           = 'ski_sole',
  SKI_NEED           = 'ski_need',
  SKI_MODEL          = 'ski_model',
  // Snowboard branch
  SNOWBOARD_BOOTS    = 'snowboard_boots',
  SNOWBOARD_MODEL    = 'snowboard_model',
  // Other branch
  OTHER_CATEGORY     = 'other_category',
  TOURING_ITEMS      = 'touring_items',
  XC_TYPE            = 'xc_type',
  XC_BOOTS           = 'xc_boots',
  MISC_ITEM          = 'misc_item',
  // Shared post-equipment
  HELMET             = 'helmet',
  HELMET_TYPE        = 'helmet_type',
  MEASUREMENTS       = 'measurements',
  HOTEL              = 'hotel',
  // Group + completion
  ADD_PERSON         = 'add_person',
  EMAIL              = 'email',
  SPECIAL_REQUESTS   = 'special_requests',
  INSURANCE          = 'insurance',
  CONFIRM            = 'confirm',
  DONE               = 'done',
}

interface InternalData extends ConversationData {
  currentMember?: Partial<GroupMember>;
  currentBranch?: Branch;
  rentalGroupIds?: number[];
  groupHotel?: string;
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

function parseDob(input: string): string | 'future' | null {
  const iso = parseDate(input);
  if (!iso) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (new Date(iso) >= today) return 'future';
  return iso;
}

function isoToDisplay(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function getAge(dob: string): number {
  const birth = new Date(dob);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

function isKid(dob: string): boolean {
  return getAge(dob) <= 14;
}

function parseName(input: string): { firstname: string; lastname: string } | null {
  const parts = input.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  return { firstname: parts[0], lastname: parts.slice(1).join(' ') };
}

function parseMeasurements(input: string): { heightcm: number; weightkg: number } | null {
  const parts = input.split(/[,\s]+/).filter(Boolean);
  if (parts.length < 2) return null;
  const h = parseFloat(parts[0]);
  const w = parseFloat(parts[1]);
  if (isNaN(h) || isNaN(w) || h < 80 || h > 230 || w < 10 || w > 200) return null;
  return { heightcm: Math.round(h), weightkg: Math.round(w) };
}

function parsePositiveFloat(input: string): number | null {
  const n = parseFloat(input.trim().replace(',', '.'));
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
// Post-helmet routing helper
// ---------------------------------------------------------------------------

/**
 * Route to HOTEL, or skip it entirely when the group hotel is already known.
 */
function hotelRouting(data: InternalData, member: Partial<GroupMember>, language: Language): StepResult {
  if (data.groupHotel) {
    const memberWithHotel = { ...member, hotel: data.groupHotel };
    return {
      nextStep: ConversationStep.ADD_PERSON,
      updatedData: { ...data, currentMember: memberWithHotel },
      reply: t(language, 'add_person_prompt'),
    };
  }
  return {
    nextStep: ConversationStep.HOTEL,
    updatedData: { ...data, currentMember: member },
    reply: t(language, 'hotel_prompt', { firstname: member.firstname ?? '' }),
  };
}

/**
 * After HELMET or HELMET_TYPE, route to MEASUREMENTS (if ski-type equipment
 * is present) or directly to HOTEL (or skip hotel if already known).
 */
function afterHelmet(data: InternalData, member: Partial<GroupMember>, language: Language): StepResult {
  if (needsMeasurements(member.equipment ?? [])) {
    return {
      nextStep: ConversationStep.MEASUREMENTS,
      updatedData: { ...data, currentMember: member },
      reply: t(language, 'measurements_prompt'),
    };
  }
  return hotelRouting(data, member, language);
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(data: InternalData, language: Language): string {
  const lines: string[] = [t(language, 'summary_header'), ''];

  if (data.branchId) {
    const branch = EXAMPLE_BRANCHES.find(b => b.id === data.branchId);
    if (branch) lines.push(t(language, 'summary_branch', { branch: branch.name }));
  }

  lines.push(t(language, 'summary_dates', {
    datefrom: data.datefrom ? isoToDisplay(data.datefrom) : '',
    dateto:   data.dateto   ? isoToDisplay(data.dateto)   : '',
  }));

  if (data.email) {
    lines.push(t(language, 'summary_email', { email: data.email }));
  }

  let grandTotal = 0;
  const members = data.members ?? [];
  members.forEach((m, i) => {
    lines.push('');
    lines.push(t(language, 'summary_person_header', {
      index:     i + 1,
      firstname: m.firstname,
      lastname:  m.lastname,
      dob:       isoToDisplay(m.dob),
    }));
    lines.push(t(language, 'summary_person_equipment', {
      equipment: equipmentLabels(m.equipment, language),
    }));
    if (m.heightcm !== undefined && m.weightkg !== undefined) {
      lines.push(t(language, 'summary_person_measurements', {
        height: m.heightcm,
        weight: m.weightkg,
      }));
    }
    if (m.skillLevel !== undefined) {
      lines.push(t(language, 'summary_person_skill', { skill: skillLabel(m.skillLevel, language) }));
    }
    if (m.solemm !== undefined) {
      lines.push(t(language, 'summary_person_sole', { sole: m.solemm }));
    }
    if (m.hotel) {
      lines.push(t(language, 'summary_person_hotel', { hotel: m.hotel }));
    }
    const personTotal = m.equipment.reduce((sum, item) => sum + (MOCK_PRICES[item] ?? 0), 0);
    grandTotal += personTotal;
    lines.push(t(language, 'summary_person_price', { price: personTotal.toFixed(2) }));
  });

  lines.push('');
  if (data.insurance) {
    const days = calcRentalDays(data.datefrom, data.dateto);
    let insuranceTotal = 0;
    lines.push(t(language, 'summary_insurance_header'));
    members.forEach(m => {
      const rate = isKid(m.dob) ? INSURANCE_RATE_KID : INSURANCE_RATE_ADULT;
      const personInsurance = days * rate;
      insuranceTotal += personInsurance;
      lines.push(t(language, 'summary_insurance_person', {
        firstname: m.firstname,
        lastname:  m.lastname,
        days:      String(days),
        rate:      rate.toFixed(2),
        price:     personInsurance.toFixed(2),
      }));
    });
    lines.push(t(language, 'summary_insurance_total', { price: insuranceTotal.toFixed(2) }));
    grandTotal += insuranceTotal;
  }
  if (data.specialRequests) {
    lines.push(t(language, 'summary_special_requests', { requests: data.specialRequests }));
  }
  lines.push(t(language, 'summary_total', { total: grandTotal.toFixed(2) }));

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

function handleDateTo(data: InternalData, input: string): StepResult | 'invalid' | 'past' | 'order' {
  const iso = parseDate(input);
  if (!iso) return 'invalid';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (new Date(iso) < today) return 'past';
  if (data.datefrom && new Date(iso) <= new Date(data.datefrom)) return 'order';
  return {
    nextStep: ConversationStep.BRANCH,
    updatedData: { ...data, dateto: iso, members: [] },
    reply: t(data.language, 'branch_prompt'),
  };
}

function handleBranch(data: InternalData, input: string): StepResult | null {
  const choice = parseInt(input.trim(), 10);
  const branch = EXAMPLE_BRANCHES[choice - 1];
  if (!branch) return null;
  return {
    nextStep: ConversationStep.PERSON_NAME,
    updatedData: { ...data, branchId: branch.id },
    reply: t(data.language, 'person_first_intro') + '\n' + t(data.language, 'person_name_prompt'),
  };
}

function parseEmail(input: string): string | null {
  const email = input.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function handleEmail(data: InternalData, input: string): StepResult | null {
  const email = parseEmail(input);
  if (!email) return null;
  return {
    nextStep: ConversationStep.SPECIAL_REQUESTS,
    updatedData: { ...data, email },
    reply: t(data.language, 'special_requests_prompt'),
  };
}

function handleSpecialRequests(data: InternalData, input: string): StepResult {
  const text = input.trim();
  const skip = text === '-' || text.toLowerCase() === 'none' || text.toLowerCase() === 'keine';
  const specialRequests = skip ? undefined : text;
  const days = calcRentalDays(data.datefrom, data.dateto);
  const totalInsurance = calcInsurancePrice(data.members ?? [], data.datefrom, data.dateto);
  return {
    nextStep: ConversationStep.INSURANCE,
    updatedData: { ...data, specialRequests },
    reply: t(data.language, 'insurance_prompt', {
      days: String(days),
      price: totalInsurance.toFixed(2),
    }),
  };
}

function handleInsurance(data: InternalData, input: string): StepResult | null {
  const answer = normalizeYesNo(input, data.language);
  if (!answer) return null;
  const insurance = answer === 'yes';
  const finalData = { ...data, insurance };
  const summary = buildSummary(finalData, data.language);
  return {
    nextStep: ConversationStep.CONFIRM,
    updatedData: finalData,
    reply: `${summary}\n\n${t(data.language, 'confirm_prompt')}`,
  };
}

function handlePersonName(data: InternalData, input: string): StepResult | null {
  const name = parseName(input);
  if (!name) return null;
  return {
    nextStep: ConversationStep.PERSON_DOB,
    updatedData: { ...data, currentMember: { ...name, equipment: [] } },
    reply: t(data.language, 'person_dob_prompt'),
  };
}

function handlePersonDob(data: InternalData, input: string): StepResult | 'invalid' | 'future' {
  const result = parseDob(input);
  if (!result) return 'invalid';
  if (result === 'future') return 'future';

  const member = { ...data.currentMember, dob: result };
  const kid = isKid(result);
  return {
    nextStep: ConversationStep.EQUIPMENT_CATEGORY,
    updatedData: { ...data, currentMember: member },
    reply: t(data.language, kid ? 'equipment_category_prompt_kid' : 'equipment_category_prompt_adult', {
      firstname: member.firstname ?? '',
    }),
  };
}

function handleEquipmentCategory(data: InternalData, input: string): StepResult | null {
  const choice = input.trim();
  const kid = isKid(data.currentMember?.dob ?? '1900-01-01');
  const firstname = data.currentMember?.firstname ?? '';

  if (choice === '1') {
    if (kid) {
      return {
        nextStep: ConversationStep.SKI_BOOTS,
        updatedData: { ...data, currentBranch: 'ski' },
        reply: t(data.language, 'ski_boots_prompt', { firstname }),
      };
    }
    return {
      nextStep: ConversationStep.SKI_SKILL,
      updatedData: { ...data, currentBranch: 'ski' },
      reply: t(data.language, 'ski_skill_prompt', { firstname }),
    };
  }

  if (choice === '2') {
    return {
      nextStep: ConversationStep.SNOWBOARD_BOOTS,
      updatedData: { ...data, currentBranch: 'snowboard' },
      reply: t(data.language, 'snowboard_boots_prompt', { firstname }),
    };
  }

  if (choice === '3' && !kid) {
    return {
      nextStep: ConversationStep.OTHER_CATEGORY,
      updatedData: { ...data },
      reply: t(data.language, 'other_category_prompt'),
    };
  }

  return null;
}

// --- Ski branch ---

function handleSkiSkill(data: InternalData, input: string): StepResult | null {
  const skill = skillFromInput(input);
  if (!skill) return null;
  return {
    nextStep: ConversationStep.SKI_BOOTS,
    updatedData: { ...data, currentMember: { ...data.currentMember, skillLevel: skill } },
    reply: t(data.language, 'ski_boots_prompt', { firstname: data.currentMember?.firstname ?? '' }),
  };
}

function handleSkiBoots(data: InternalData, input: string): StepResult | null {
  const choice = input.trim();
  const kid = isKid(data.currentMember?.dob ?? '1900-01-01');
  const firstname = data.currentMember?.firstname ?? '';

  if (choice === '1') {
    // Has own boots → ask sole length
    return {
      nextStep: ConversationStep.SKI_SOLE,
      updatedData: { ...data },
      reply: t(data.language, 'ski_sole_prompt'),
    };
  }

  if (choice === '2') {
    if (kid) {
      // Kids: auto-add kids_boots, skip type selection
      const equipment = [...(data.currentMember?.equipment ?? []), 'kids_boots' as EquipmentItem];
      return {
        nextStep: ConversationStep.SKI_NEED,
        updatedData: { ...data, currentMember: { ...data.currentMember, equipment } },
        reply: t(data.language, 'ski_need_prompt', { firstname }),
      };
    }
    return {
      nextStep: ConversationStep.SKI_BOOTS_TYPE,
      updatedData: { ...data },
      reply: t(data.language, 'ski_boots_type_prompt'),
    };
  }

  return null;
}

function handleSkiBootsType(data: InternalData, input: string): StepResult | null {
  const itemMap: Record<string, EquipmentItem> = {
    '1': 'ski_boots_premium',
    '2': 'ski_boots_economy',
  };
  const item = itemMap[input.trim()];
  if (!item) return null;

  const equipment = [...(data.currentMember?.equipment ?? []), item];
  return {
    nextStep: ConversationStep.SKI_NEED,
    updatedData: { ...data, currentMember: { ...data.currentMember, equipment } },
    reply: t(data.language, 'ski_need_prompt', { firstname: data.currentMember?.firstname ?? '' }),
  };
}

function handleSkiSole(data: InternalData, input: string): StepResult | 'invalid' {
  const n = parsePositiveFloat(input);
  if (!n || n < 150 || n > 380) return 'invalid';
  const member = { ...data.currentMember, solemm: Math.round(n) };
  const kid = isKid(member.dob ?? '1900-01-01');
  if (kid) {
    const equipment = [...(member.equipment ?? []), 'kids_ski' as EquipmentItem];
    return {
      nextStep: ConversationStep.HELMET,
      updatedData: { ...data, currentMember: { ...member, equipment } },
      reply: t(data.language, 'helmet_prompt', { firstname: member.firstname ?? '' }),
    };
  }
  return {
    nextStep: ConversationStep.SKI_MODEL,
    updatedData: { ...data, currentMember: member },
    reply: t(data.language, 'ski_model_prompt'),
  };
}

function handleSkiNeed(data: InternalData, input: string): StepResult | null {
  const choice = input.trim();
  const kid = isKid(data.currentMember?.dob ?? '1900-01-01');
  const firstname = data.currentMember?.firstname ?? '';

  if (choice === '1') {
    if (kid) {
      const equipment = [...(data.currentMember?.equipment ?? []), 'kids_ski' as EquipmentItem];
      const member = { ...data.currentMember, equipment };
      return {
        nextStep: ConversationStep.HELMET,
        updatedData: { ...data, currentMember: member },
        reply: t(data.language, 'helmet_prompt', { firstname }),
      };
    }
    return {
      nextStep: ConversationStep.SKI_MODEL,
      updatedData: { ...data },
      reply: t(data.language, 'ski_model_prompt'),
    };
  }

  if (choice === '2') {
    // Boots only — go to helmet
    return {
      nextStep: ConversationStep.HELMET,
      updatedData: { ...data },
      reply: t(data.language, 'helmet_prompt', { firstname }),
    };
  }

  return null;
}

function handleSkiModel(data: InternalData, input: string): StepResult | null {
  const itemMap: Record<string, EquipmentItem> = {
    '1': 'ski_factory_test',
    '2': 'ski_diamond',
    '3': 'ski_premium',
    '4': 'ski_economy',
    '5': 'ski_basic',
  };
  const item = itemMap[input.trim()];
  if (!item) return null;

  const equipment = [...(data.currentMember?.equipment ?? []), item];
  const member = { ...data.currentMember, equipment };
  return {
    nextStep: ConversationStep.HELMET,
    updatedData: { ...data, currentMember: member },
    reply: t(data.language, 'helmet_prompt', { firstname: member.firstname ?? '' }),
  };
}

// --- Snowboard branch ---

function handleSnowboardBoots(data: InternalData, input: string): StepResult | null {
  const choice = input.trim();

  if (choice === '1') {
    return {
      nextStep: ConversationStep.SNOWBOARD_MODEL,
      updatedData: { ...data },
      reply: t(data.language, 'snowboard_model_prompt'),
    };
  }
  if (choice === '2') {
    const equipment = [...(data.currentMember?.equipment ?? []), 'snowboard_boots' as EquipmentItem];
    return {
      nextStep: ConversationStep.SNOWBOARD_MODEL,
      updatedData: { ...data, currentMember: { ...data.currentMember, equipment } },
      reply: t(data.language, 'snowboard_model_prompt'),
    };
  }
  return null;
}

function handleSnowboardModel(data: InternalData, input: string): StepResult | null {
  const itemMap: Record<string, EquipmentItem> = {
    '1': 'snowboard_premium',
    '2': 'snowboard_economy',
  };
  const item = itemMap[input.trim()];
  if (!item) return null;

  const equipment = [...(data.currentMember?.equipment ?? []), item];
  const member = { ...data.currentMember, equipment };
  return {
    nextStep: ConversationStep.HELMET,
    updatedData: { ...data, currentMember: member },
    reply: t(data.language, 'helmet_prompt', { firstname: member.firstname ?? '' }),
  };
}

// --- Other branch ---

function handleOtherCategory(data: InternalData, input: string): StepResult | null {
  const choice = input.trim();

  if (choice === '1') {
    return {
      nextStep: ConversationStep.TOURING_ITEMS,
      updatedData: { ...data, currentBranch: 'touring' },
      reply: t(data.language, 'touring_items_prompt'),
    };
  }
  if (choice === '2') {
    return {
      nextStep: ConversationStep.XC_TYPE,
      updatedData: { ...data, currentBranch: 'xc' },
      reply: t(data.language, 'xc_type_prompt'),
    };
  }
  if (choice === '3') {
    return {
      nextStep: ConversationStep.MISC_ITEM,
      updatedData: { ...data, currentBranch: 'misc' },
      reply: t(data.language, 'misc_item_prompt'),
    };
  }
  return null;
}

function handleTouringItems(
  data: InternalData,
  input: string,
): StepResult | 'invalid' | 'none' {
  const itemMap: Record<string, EquipmentItem> = {
    '1': 'touring_ski',
    '2': 'touring_boots',
    '3': 'touring_backpack',
    '4': 'touring_radar',
    '5': 'touring_shovel',
    '6': 'touring_avalanche_bag',
    '7': 'touring_probe',
  };

  const parts = input.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return 'none';

  const selected: EquipmentItem[] = [];
  for (const part of parts) {
    const item = itemMap[part.trim()];
    if (!item) return 'invalid';
    if (!selected.includes(item)) selected.push(item);
  }
  if (selected.length === 0) return 'none';

  const equipment = [...(data.currentMember?.equipment ?? []), ...selected];
  const member = { ...data.currentMember, equipment };
  return {
    nextStep: ConversationStep.HELMET,
    updatedData: { ...data, currentMember: member },
    reply: t(data.language, 'helmet_prompt', { firstname: member.firstname ?? '' }),
  };
}

function handleXcType(data: InternalData, input: string): StepResult | null {
  const itemMap: Record<string, EquipmentItem> = {
    '1': 'xc_classic',
    '2': 'xc_skating',
  };
  const item = itemMap[input.trim()];
  if (!item) return null;

  const equipment = [...(data.currentMember?.equipment ?? []), item];
  return {
    nextStep: ConversationStep.XC_BOOTS,
    updatedData: { ...data, currentMember: { ...data.currentMember, equipment } },
    reply: t(data.language, 'xc_boots_prompt', { firstname: data.currentMember?.firstname ?? '' }),
  };
}

function handleXcBoots(data: InternalData, input: string): StepResult | null {
  const choice = input.trim();
  const currentEquipment = data.currentMember?.equipment ?? [];

  if (choice !== '1' && choice !== '2') return null;

  let equipment = [...currentEquipment];
  if (choice === '1') {
    const bootsItem: EquipmentItem = currentEquipment.includes('xc_classic')
      ? 'xc_classic_boots'
      : 'xc_skating_boots';
    equipment = [...equipment, bootsItem];
  }

  const member = { ...data.currentMember, equipment };
  // XC: no helmet — always goes to measurements (XC ski is always present)
  return {
    nextStep: ConversationStep.MEASUREMENTS,
    updatedData: { ...data, currentMember: member },
    reply: t(data.language, 'measurements_prompt'),
  };
}

function handleMiscItem(data: InternalData, input: string): StepResult | null {
  const itemMap: Record<string, EquipmentItem> = {
    '1': 'snowshoes',
    '2': 'sleigh',
  };
  const item = itemMap[input.trim()];
  if (!item) return null;

  const equipment = [...(data.currentMember?.equipment ?? []), item];
  const member = { ...data.currentMember, equipment };
  // Misc: no helmet, no measurements
  return hotelRouting(data, member, data.language);
}

// --- Shared: Helmet, Measurements, Hotel ---

function handleHelmet(data: InternalData, input: string): StepResult | null {
  const choice = input.trim();

  if (choice === '1') {
    return {
      nextStep: ConversationStep.HELMET_TYPE,
      updatedData: { ...data },
      reply: t(data.language, 'helmet_type_prompt'),
    };
  }
  if (choice === '2') {
    return afterHelmet(data, data.currentMember ?? {}, data.language);
  }
  return null;
}

function handleHelmetType(data: InternalData, input: string): StepResult | null {
  const itemMap: Record<string, EquipmentItem> = {
    '1': 'helmet_visor',
    '2': 'helmet_no_visor',
  };
  const item = itemMap[input.trim()];
  if (!item) return null;

  const equipment = [...(data.currentMember?.equipment ?? []), item];
  const member = { ...data.currentMember, equipment };
  return afterHelmet(data, member, data.language);
}

function handleMeasurements(data: InternalData, input: string): StepResult | 'invalid' {
  const m = parseMeasurements(input);
  if (!m) return 'invalid';

  const member = { ...data.currentMember, ...m };
  return hotelRouting(data, member, data.language);
}

function handleHotel(data: InternalData, input: string): StepResult | null {
  const hotel = input.trim();
  if (!hotel) return null;

  const member = { ...data.currentMember, hotel };
  return {
    nextStep: ConversationStep.ADD_PERSON,
    updatedData: { ...data, currentMember: member, groupHotel: hotel },
    reply: t(data.language, 'add_person_prompt'),
  };
}

// --- Group management ---

function handleAddPerson(data: InternalData, input: string): StepResult | null {
  const answer = normalizeYesNo(input, data.language);
  if (!answer) return null;

  const currentMember = data.currentMember as GroupMember;
  const members = [...(data.members ?? []), currentMember];
  const nextPersonNumber = members.length + 1;

  if (answer === 'yes') {
    return {
      nextStep: ConversationStep.PERSON_NAME,
      updatedData: { ...data, members, currentMember: undefined, currentBranch: undefined },
      reply:
        t(data.language, 'person_next_intro', { index: nextPersonNumber }) +
        '\n' +
        t(data.language, 'person_name_prompt'),
    };
  }

  const finalData = { ...data, members, currentMember: undefined, currentBranch: undefined };
  return {
    nextStep: ConversationStep.EMAIL,
    updatedData: finalData,
    reply: t(data.language, 'email_prompt'),
  };
}

// ---------------------------------------------------------------------------
// Easyrent API calls
// ---------------------------------------------------------------------------

async function createEasyrentReservation(
  data: InternalData,
  shopConfig: ShopEasyrentConfig,
): Promise<string> {
  if (process.env.MOCK_EASYRENT === 'true') {
    console.info('[mock] MOCK_EASYRENT=true — skipping Easyrent API calls');
    return `MOCK-${Date.now()}`;
  }

  const members = data.members ?? [];
  if (members.length === 0) throw new Error('No members in reservation');

  const primary = members[0];

  // 1. Create / update primary customer
  const primaryResult = await soapCustInsertOrUpdateV2(shopConfig, {
    customer: {
      firstname:            primary.firstname,
      lastname:             primary.lastname,
      dateofbirth:          primary.dob ? new Date(primary.dob) : undefined,
      hotelname:            primary.hotel,
      heightcm:             primary.heightcm,
      weightkg:             primary.weightkg,
      solemm:               primary.solemm,
      int_isoskiertypeid:   primary.skillLevel ? skillToEasyrentId(primary.skillLevel) : undefined,
      languagecode:         data.language,
    },
  });

  const primaryCode = primaryResult.customerresult.er_custcode;
  const groupCode   = primaryResult.customerresult.er_groupcode;

  // 2. Create additional group members
  const memberCodes: string[] = [primaryCode];
  for (const member of members.slice(1)) {
    const result = await soapCustInsertOrUpdateV2(shopConfig, {
      customer: {
        firstname:          member.firstname,
        lastname:           member.lastname,
        dateofbirth:        member.dob ? new Date(member.dob) : undefined,
        hotelname:          member.hotel,
        heightcm:           member.heightcm,
        weightkg:           member.weightkg,
        solemm:             member.solemm,
        int_isoskiertypeid: member.skillLevel ? skillToEasyrentId(member.skillLevel) : undefined,
        er_groupcode:       groupCode,
        languagecode:       data.language,
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
    groupCode:    members.length > 1 ? groupCode : undefined,
    branchId:     shopConfig.branchId,
    dateFrom:     data.datefrom,
    dateTo:       data.dateto,
    positions:    (data.rentalGroupIds ?? []).flatMap(rentalGroupId =>
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
    soapUrl:     shop.easyrent_soap_url,
    restBaseUrl: shop.easyrent_rest_base_url,
    accessId:    shop.easyrent_accessid,
    branchId:    shop.easyrent_branchid,
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
  const kid = isKid(data.currentMember?.dob ?? '1900-01-01');

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
      if (r === 'past')    return t(language, 'date_past');
      result = r;
      break;
    }

    case ConversationStep.DATE_TO: {
      const r = handleDateTo(data, input);
      if (r === 'invalid') return t(language, 'date_invalid');
      if (r === 'past')    return t(language, 'date_past');
      if (r === 'order')   return t(language, 'date_order');
      result = r;
      break;
    }

    case ConversationStep.BRANCH: {
      result = handleBranch(data, input);
      if (!result) return t(language, 'branch_invalid');
      break;
    }

    case ConversationStep.PERSON_NAME: {
      result = handlePersonName(data, input);
      if (!result) return t(language, 'person_name_invalid');
      break;
    }

    case ConversationStep.PERSON_DOB: {
      const r = handlePersonDob(data, input);
      if (r === 'invalid') return t(language, 'person_dob_invalid');
      if (r === 'future')  return t(language, 'person_dob_future');
      result = r;
      break;
    }

    case ConversationStep.EQUIPMENT_CATEGORY: {
      result = handleEquipmentCategory(data, input);
      if (!result) return t(language, kid ? 'equipment_category_invalid_kid' : 'equipment_category_invalid_adult');
      break;
    }

    case ConversationStep.SKI_SKILL: {
      result = handleSkiSkill(data, input);
      if (!result) return t(language, 'ski_skill_invalid');
      break;
    }

    case ConversationStep.SKI_BOOTS: {
      result = handleSkiBoots(data, input);
      if (!result) return t(language, 'ski_boots_invalid');
      break;
    }

    case ConversationStep.SKI_BOOTS_TYPE: {
      result = handleSkiBootsType(data, input);
      if (!result) return t(language, 'ski_boots_type_invalid');
      break;
    }

    case ConversationStep.SKI_SOLE: {
      const r = handleSkiSole(data, input);
      if (r === 'invalid') return t(language, 'ski_sole_invalid');
      result = r;
      break;
    }

    case ConversationStep.SKI_NEED: {
      result = handleSkiNeed(data, input);
      if (!result) return t(language, 'ski_need_invalid');
      break;
    }

    case ConversationStep.SKI_MODEL: {
      result = handleSkiModel(data, input);
      if (!result) return t(language, 'ski_model_invalid');
      break;
    }

    case ConversationStep.SNOWBOARD_BOOTS: {
      result = handleSnowboardBoots(data, input);
      if (!result) return t(language, 'snowboard_boots_invalid');
      break;
    }

    case ConversationStep.SNOWBOARD_MODEL: {
      result = handleSnowboardModel(data, input);
      if (!result) return t(language, 'snowboard_model_invalid');
      break;
    }

    case ConversationStep.OTHER_CATEGORY: {
      result = handleOtherCategory(data, input);
      if (!result) return t(language, 'other_category_invalid');
      break;
    }

    case ConversationStep.TOURING_ITEMS: {
      const r = handleTouringItems(data, input);
      if (r === 'invalid') return t(language, 'touring_items_invalid');
      if (r === 'none')    return t(language, 'touring_items_none');
      result = r;
      break;
    }

    case ConversationStep.XC_TYPE: {
      result = handleXcType(data, input);
      if (!result) return t(language, 'xc_type_invalid');
      break;
    }

    case ConversationStep.XC_BOOTS: {
      result = handleXcBoots(data, input);
      if (!result) return t(language, 'xc_boots_invalid');
      break;
    }

    case ConversationStep.MISC_ITEM: {
      result = handleMiscItem(data, input);
      if (!result) return t(language, 'misc_item_invalid');
      break;
    }

    case ConversationStep.HELMET: {
      result = handleHelmet(data, input);
      if (!result) return t(language, 'helmet_invalid');
      break;
    }

    case ConversationStep.HELMET_TYPE: {
      result = handleHelmetType(data, input);
      if (!result) return t(language, 'helmet_type_invalid');
      break;
    }

    case ConversationStep.MEASUREMENTS: {
      const r = handleMeasurements(data, input);
      if (r === 'invalid') return t(language, 'measurements_invalid');
      result = r;
      break;
    }

    case ConversationStep.HOTEL: {
      result = handleHotel(data, input);
      if (!result) return t(language, 'hotel_invalid');
      break;
    }

    case ConversationStep.ADD_PERSON: {
      result = handleAddPerson(data, input);
      if (!result) return t(language, 'add_person_invalid');
      break;
    }

    case ConversationStep.EMAIL: {
      result = handleEmail(data, input);
      if (!result) return t(language, 'email_invalid');
      break;
    }

    case ConversationStep.SPECIAL_REQUESTS: {
      result = handleSpecialRequests(data, input);
      break;
    }

    case ConversationStep.INSURANCE: {
      result = handleInsurance(data, input);
      if (!result) return t(language, 'insurance_invalid');
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
 * Called on a periodic interval (configured via CLEANUP_INTERVAL_MS).
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
