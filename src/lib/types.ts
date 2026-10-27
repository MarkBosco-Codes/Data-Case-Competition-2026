import { z } from 'zod'
import { COUNTRIES, PARTNER_CLASSES } from './constants'

// ---- Shared payload schemas -------------------------------------------------

export const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  creditTerms: z.enum(['NET15', 'NET30', 'NET45', 'NET60', 'PREPAID']),
  bankAccountNumber: z.string().min(1, 'Bank account number is required'),
  contactDetails: z.object({
    contactName: z.string().min(1, 'Contact name is required'),
    email: z.string().email(),
    phone: z.string().min(1),
  }),
  partnerClass: z.enum(PARTNER_CLASSES),
  country: z.enum(COUNTRIES),
  countryOfOrigin: z.string().optional(),
  addresses: z.string().min(1, 'Address is required'),
})

export type Schema = z.infer<typeof schema>

// ---- Persisted record (staging table) --------------------------------------

export type BankAccount = {
  id: string
  bpId: string
  iban: string
  beneficiaryName: string
  ibanValid: boolean
  beneficiaryMatch: boolean
  taxFormatValid: boolean
  approval1By: string | null
  approval2By: string | null
  status:
    | 'PENDING_INFORMATION'
    | 'DUAL_APPROVAL_PENDING'
    | 'APPROVED'
    | 'PUSHED_TO_SAP'
}

export type BusinessPartner = {
  id: string
  requestId: string
  processStatus: 'PENDING' | 'VALIDATED' | 'PUSHED_TO_SAP' | 'REJECTED'
  customData: Record<string, string>
  name: string
  creditTerms: Schema['creditTerms']
  bankAccountNumber: string
  contactName: string
  contactEmail: string
  contactPhone: string
  partnerClass: Schema['partnerClass']
  partnerClassDb: 'CUSTOMER' | 'VENDOR'
  country: Schema['country']
  countryOfOrigin: string | null
  countrySynced: boolean
  addresses: Schema['addresses']
  createdAt: string
}
