export const COUNTRIES = [
  'Singapore',
  'Malaysia',
  'Thailand',
  'Vietnam',
  'Indonesia',
] as const
export type Country = (typeof COUNTRIES)[number]

export const PARTNER_CLASSES = ['Customer', 'Supplier'] as const
export type PartnerClass = (typeof PARTNER_CLASSES)[number]

// ---- Email whitelist (requestor submits / migrates; approver approves) -------

export const REQUESTOR_EMAILS = ['mbprojects2022@gmail.com'] as const
export const APPROVER_EMAILS = ['sendtomarkbosco@gmail.com'] as const

export function isWhitelistedRequestor(email: string): boolean {
  return (REQUESTOR_EMAILS as readonly string[]).includes(
    email.trim().toLowerCase(),
  )
}

export function isWhitelistedApprover(email: string): boolean {
  return (APPROVER_EMAILS as readonly string[]).includes(
    email.trim().toLowerCase(),
  )
}

// DB value for "Supplier"
export const PARTNER_CLASS_DB: Record<PartnerClass, 'CUSTOMER' | 'VENDOR'> = {
  Customer: 'CUSTOMER',
  Supplier: 'VENDOR',
}

// KYC / Compliance Review tab (tab 3) redirect target — exact URL from spec
export const KYC_REVIEW_URL =
  'https://sim.no1.hana.ondemand.com/sap/bc/ui5_ui5/ui2/ushell/shells/abap/FioriLaunchpad.html?sap-client=100#Zcountry-sync'

export type BpTypeRequirement = {
  code: string
  country: string
  bpType: PartnerClass
  bpClassification: 'Domestic'
  bpGroups: string[]
}

// Country-specific BP type requirements (verbatim mapping from spec)
export const BP_TYPE_REQUIREMENTS: BpTypeRequirement[] = [
  { code: 'AE', country: 'UAE', bpType: 'Customer', bpClassification: 'Domestic', bpGroups: ['BPG003', 'BPG004'] },
  { code: 'IE', country: 'Ireland', bpType: 'Customer', bpClassification: 'Domestic', bpGroups: ['BPG006'] },
  { code: 'IN', country: 'India', bpType: 'Customer', bpClassification: 'Domestic', bpGroups: ['BPG004'] },
  { code: 'AE2', country: 'UAE', bpType: 'Supplier', bpClassification: 'Domestic', bpGroups: ['BPG003', 'BPG004'] },
  { code: 'GBIS', country: 'United Kingdom', bpType: 'Customer', bpClassification: 'Domestic', bpGroups: ['BPG006'] },
  { code: 'GBIS1', country: 'United Kingdom', bpType: 'Supplier', bpClassification: 'Domestic', bpGroups: ['BPG006'] },
  { code: 'IE1', country: 'Ireland', bpType: 'Supplier', bpClassification: 'Domestic', bpGroups: ['BPG006'] },
  { code: 'IN1', country: 'India', bpType: 'Supplier', bpClassification: 'Domestic', bpGroups: ['BPG004'] },
  { code: 'SGMB1', country: 'Singapore', bpType: 'Supplier', bpClassification: 'Domestic', bpGroups: ['BPG002'] },
  { code: 'SGST1', country: 'Singapore', bpType: 'Customer', bpClassification: 'Domestic', bpGroups: ['BPG002'] },
  { code: 'AE4', country: 'UAE', bpType: 'Supplier', bpClassification: 'Domestic', bpGroups: ['BPG007'] },
  { code: 'ZSG01', country: 'Singapore', bpType: 'Customer', bpClassification: 'Domestic', bpGroups: ['BPG008'] },
  { code: 'ZSG02', country: 'Singapore', bpType: 'Supplier', bpClassification: 'Domestic', bpGroups: ['BPG008'] },
  { code: 'ZSG03', country: 'Singapore', bpType: 'Customer', bpClassification: 'Domestic', bpGroups: ['BPG003', 'BPG008'] },
  { code: 'ZDE01', country: 'Germany', bpType: 'Customer', bpClassification: 'Domestic', bpGroups: ['BPG008'] },
]

export function matchBpRequirements(
  country: string,
  bpType: PartnerClass,
): BpTypeRequirement[] {
  // Countries in the mapping are not in the 5-country collect list; the
  // matching is by label so e.g. India collects matches IN/IN1
  return BP_TYPE_REQUIREMENTS.filter(
    (r) =>
      r.country === country ||
      (country === 'United States' &&
        /united states/i.test(r.country)) ||
      (country === 'Indonesia' && /indonesia/i.test(r.country)) ||
      (country === 'China' && /china/i.test(r.country)) ||
      r.country === country,
  ).filter((r) => r.bpType === bpType)
}
