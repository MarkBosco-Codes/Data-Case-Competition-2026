import { matchBpRequirements } from './constants'
import type { BpTypeRequirement } from './constants'
import type { BankAccount, BusinessPartner, Schema } from './types'

// ---- Validation helpers -----------------------------------------------------

const MOD_97_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** IBAN checksum via mod-97 (ISO 13616). */
export function isValidIban(iban: string): boolean {
  const s = iban.replace(/\s+/g, '').toUpperCase()
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false
  const rearranged = s.slice(4) + s.slice(0, 4)
  let remainder = 0
  for (const ch of rearranged) {
    const val = MOD_97_ALPHABET.indexOf(ch)
    if (val < 0) return false
    if (val < 10) {
      remainder = (remainder * 10 + val) % 97
    } else {
      // two-digit expansion, e.g. 'A' -> 10
      const tens = Math.floor(val / 10)
      const ones = val % 10
      remainder = (remainder * 100 + tens * 10 + ones) % 97
    }
  }
  return remainder === 1
}

/** Beneficiary-name match — normalized comparison against IBAN registered name. */
export function beneficiaryMatchesBankRegistery(
  inputBeneficiary: string,
  bankRegisteredName: string,
): boolean {
  const norm = (v: string) =>
    v.toUpperCase().replace(/\s+/g, ' ').replace(/[^A-Z0-9 ]/g, '').trim()
  return norm(inputBeneficiary) === norm(bankRegisteredName)
}

/** Counterparty tax format validation per country set. */
export function isValidTaxFormat(country: string, taxId: string): boolean {
  switch (country) {
    case 'United States':
      // EIN: XX-XXXXXXXX
      return /^\d{2}-\d{7}$/.test(taxId)
    case 'China':
      // Unified Social Credit Code: 18 alphanumerics
      return /^[0-9A-HJ-NPQRTUWXY]{18}$/.test(taxId.toUpperCase())
    case 'Singapore':
      // UEN: 8-10 alphanumeric + check letter(s)
      return /^\d{8}[A-Z]$|^\d{9}[A-Z]$|^[TS]\d{2}[A-Z]{2}\d{5}[A-Z]$/.test(
        taxId.toUpperCase(),
      )
    case 'India':
      // GSTIN: 15 chars
      return /^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}[Z]{1}[A-Z\d]{1}$/.test(
        taxId.toUpperCase(),
      )
    case 'Indonesia':
      // NPWP: 15-16 digits
      return /^\d{15,16}$/.test(taxId.replace(/[.\-]/g, ''))
    default:
      return false
  }
}

/** Front-office dedupe: duplicate detection on name + country + partnerClass. */
export function findDuplicate(existing: BusinessPartner[], incoming: Schema) {
  return existing.find(
    (p) =>
      p.partnerClass === incoming.partnerClass &&
      p.country === incoming.country &&
      p.name.replace(/\s+/g, '').toLowerCase() ===
        incoming.name.replace(/\s+/g, '').toLowerCase(),
  )
}

/** The shared wire template — "This is the template we need to implement exactly elsewhere". */
export function template(store: {
  request_id: string
  process_status?: string
  custom_data?: Record<string, string>
}): string {
  return (
    '{"requestId":"' +
    store.request_id +
    '",' +
    '"processStatus":"' +
    (store.process_status || 'PENDING') +
    '",' +
    '"customData":"' +
    JSON.stringify(store.custom_data || {}) +
    '"}'
  )
}

/** Bank dual-approval staged push (uuid staged in bank_accounts before push). */
export function stagedBankAccount(
  bpId: string,
  iban: string,
  beneficiaryName: string,
  bankRegisteredName: string,
  taxId: string,
  country: string,
): BankAccount | null {
  if (!isValidIban(iban)) return null
  if (!beneficiaryMatchesBankRegistery(beneficiaryName, bankRegisteredName))
    return null
  if (!isValidTaxFormat(country, taxId)) return null
  return {
    id: crypto.randomUUID(),
    bpId,
    iban: iban.replace(/\s+/g, ''),
    beneficiaryName,
    ibanValid: true,
    beneficiaryMatch: true,
    taxFormatValid: true,
    approval1By: null,
    approval2By: null,
    status: 'DUAL_APPROVAL_PENDING',
  }
}

export { matchBpRequirements }
export type { BpTypeRequirement }

// ---- Bonus-field agent matching ---------------------------------------------
// The agent picks the bonus field that best matches the requester's free-text
// email; if the requester specifies an attribute not covered yet, a new
// subclass (bonus field) is created. All bonus attributes are nullable.

export interface BonusField {
  id: string
  parentType: string
  name: string
  nullable: boolean
}

/** Tokenize the free text into candidate attribute names. */
function candidateNames(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
  // camelCase-ish bigrams: "payment terms" -> paymentTerms
  const out = new Set<string>(words)
  for (let i = 0; i < words.length - 1; i++) {
    out.add(words[i] + words[i + 1].replace(/^\w/, (c) => c.toUpperCase()))
  }
  return [...out]
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'have', 'has', 'need', 'needs',
  'want', 'please', 'also', 'into', 'from', 'our', 'your', 'their', 'would',
  'should', 'could', 'record', 'request', 'customer', 'vendor', 'supplier',
  'name', 'address', 'credit', 'terms', 'bank', 'account', 'contact', 'email',
  'phone', 'country', 'product', 'order', 'quantity', 'data', 'field', 'fields',
  'new', 'add', 'added', 'create', 'created', 'business', 'partner', 'team',
  'using', 'used', 'each', 'must', 'than', 'only', 'will', 'them', 'they',
])

/**
 * Score each existing bonus field against the free text; return the best
 * match (>=1 shared token) or null if none covered.
 */
export function matchBonusField(
  fields: BonusField[],
  text: string,
): BonusField | null {
  const candidates = new Set(candidateNames(text))
  let best: BonusField | null = null
  let bestScore = 0
  for (const f of fields) {
    const labels = new Set<string>([
      f.name.toLowerCase(),
      ...candidateNames(f.name.replace(/([A-Z])/g, ' $1')),
    ])
    let score = 0
    for (const c of candidates) if (labels.has(c)) score++
    if (score > bestScore) {
      bestScore = score
      best = f
    }
  }
  return bestScore > 0 ? best : null
}

/** Derive a camelCase attribute name for a brand-new bonus subclass. */
export function deriveBonusName(text: string): string | null {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
  if (words.length === 0) return null
  const base = words.slice(0, 2)
  return (
    base[0] + (base[1] ? base[1].replace(/^\w/, (c) => c.toUpperCase()) : '')
  ).slice(0, 40)
}
