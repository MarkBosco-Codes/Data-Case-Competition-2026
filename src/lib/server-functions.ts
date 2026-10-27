import { createServerFn } from '@tanstack/react-start'
import { KYC_REVIEW_URL } from '~/lib/constants'
import {
  addBonusField,
  appendAudit,
  approverAssignedTo,
  getBankAccount,
  getBonusFieldByName,
  getRequest,
  getRequestLink,
  ensureRequestLink,
  insertBankAccount,
  insertPartner,
  insertRequest,
  listApprovals,
  listAudit,
  listBankAccounts,
  insertApiRequest,
  listApiRequests,
  listBonusFields,
  listEmails,
  listLinks,
  listOrders,
  listPartners,
  listProducts,
  listRequests,
  listUsers,
  markPartnersPushed,
  recordApproval,
  recordEmail,
  setBonusValue,
  setLinks as setLinkRows,
  syncUsersFromConfig,
  updateBankAccount,
  updatePartnerStatus,
  updatePartnerRecord,
  updateRequestStatus,
  upsertUser,
  userRoles,
} from '~/lib/db'
import {
  deriveBonusName,
  findDuplicate,
  isValidIban,
  isValidTaxFormat,
  matchBonusField,
  stagedBankAccount,
  template,
} from '~/lib/validation'
import type { BpTypeRequirement } from '~/lib/constants'
import { BP_TYPE_REQUIREMENTS, COUNTRIES } from '~/lib/constants'
import { syncInbox } from '~/lib/ingest.server'
import { resolveAgentName, listUnreadMessages, sendMail, mailboxEmail } from '~/lib/zoho.server'
const APP_URL = (process.env['APP_URL'] ?? process.env['VITE_APP_URL'] ?? 'http://localhost:3000').replace(/\/$/, '')
import { getSyncState } from '~/lib/db'
import type { BusinessPartner, Schema } from '~/lib/types'

// ---- Access helpers (Sprint 1: role-based request tracking) ------------------

function requireRole(email: string, role: string): { ok: false; error: string } | null {
  if (!email || !userRoles(email).includes(role)) {
    return { ok: false, error: `ACCESS_DENIED: ${email || 'unknown'} is not a whitelisted ${role}` }
  }
  return null
}

// ---- User management ---------------------------------------------------------

export const getUsers = createServerFn({ method: 'GET' }).handler(() => {
  return { users: listUsers(), links: listLinks() }
})

export const saveUser = createServerFn({ method: 'POST' })
  .validator((data: { email: string; roles: string[] }) => data)
  .handler(async ({ data }) => {
    if (!data.roles.length) return { ok: false as const, error: 'Select at least one role' }
    const user = upsertUser(data.email, data.roles)
    return { ok: true as const, user }
  })

export const linkApprover = createServerFn({ method: 'POST' })
  .validator((data: { requesterEmail: string; approverEmail: string }) => data)
  .handler(async ({ data }) => {
    const ok = setLinkRows(data.requesterEmail, data.approverEmail)
    return ok ? { ok: true as const } : { ok: false as const, error: 'Both emails must exist as users first' }
  })

// ---- Sync users from users.yaml (runs per build / request) ------------------

export const syncUsers = createServerFn({ method: 'GET' }).handler(() => {
  return syncUsersFromConfig()
})

export const listApprovalsFn = createServerFn({ method: 'GET' })
  .validator((d: { requestId: string }) => d)
  .handler(async ({ data }: { data: { requestId: string } }) => {
    return listApprovals(data.requestId)
  })

export const listAuditFn = createServerFn({ method: 'GET' })
  .validator((d: { requestId: string }) => d)
  .handler(async ({ data }: { data: { requestId: string } }) => {
    return listAudit(data.requestId)
  })

export const listEmailsFn = createServerFn({ method: 'GET' })
  .validator((d: { requestId: string }) => d)
  .handler(async ({ data }: { data: { requestId: string } }) => {
    return listEmails(data.requestId)
  })

export const submitBpIntake = createServerFn({ method: 'POST' })
  .validator(
    (data: Schema & { requestorEmail: string; reason: string; notes?: string; threadId?: string }) => {
      if (!data.reason?.trim()) throw new Error('A reason is required for every request')
      return data
    },
  )
  .handler(async ({ data }) => {
    const denied = requireRole(data.requestorEmail, 'requester')
    if (denied) return { ok: false as const, error: denied.error }

    const existing = listPartners()

    // Front-office dedupe — validation step
    const dupe = findDuplicate(existing, data)
    if (dupe) {
      return { ok: false as const, error: 'DUPLICATE', duplicate: dupe }
    }

    // Country of origin: collected from KYC docs; if missing, ask user. It
    // only synchronizes after passing KYC review (tab 3 redirect).
    const countryOfOrigin = (data.countryOfOrigin ?? '').trim() || null

    const bp: BusinessPartner = {
      id: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      processStatus: 'PENDING',
      customData: {},
      name: data.name,
      creditTerms: data.creditTerms,
      bankAccountNumber: data.bankAccountNumber,
      contactName: data.contactDetails.contactName,
      contactEmail: data.contactDetails.email,
      contactPhone: data.contactDetails.phone,
      partnerClass: data.partnerClass,
      // UI label "Supplier" -> DB value "VENDOR"
      partnerClassDb: data.partnerClass === 'Supplier' ? 'VENDOR' : 'CUSTOMER',
      country: data.country,
      countryOfOrigin,
      countrySynced: false, // synchronized only after KYC review passes
      addresses: data.addresses,
      createdAt: new Date().toISOString(),
    }

    // Bank screen + validate IBAN. IBAN failure does not block intake but
    // flags the staged bank account record.
    const ibanOk = isValidIban(data.bankAccountNumber)
    bp.customData = {
      ibanScreen: ibanOk ? 'VALID' : 'INVALID_IBAN',
      creditTerms: data.creditTerms,
    }

    insertPartner(bp)

    // New datafields not covered by bonus fields need IT-team configuration.
    const bankNumberTaxIdOk = isValidTaxFormat(data.country, data.bankAccountNumber)
    const needsItConfig = !bankNumberTaxIdOk

    const businessApprovers = listLinks()
      .filter((l) => l.requester === data.requestorEmail.trim().toLowerCase())
      .map((l) => l.approver)
    const approverList = businessApprovers.length
      ? businessApprovers
      : (listUsers() as any[]).filter((u) => (u.roles || []).includes('approver')).map((u) => u.email)
    const requiredApprovers = [...approverList]
    if (needsItConfig && !requiredApprovers.includes('vanadite111@gmail.com')) {
      requiredApprovers.push('vanadite111@gmail.com')
    }

    // Agent picks the bonus field that best matches the requester free-text
    // email; creates a new subclass if the attribute is not covered yet.
    const bonusText = (data.notes ?? '').trim() || null
    const reason = data.reason.trim()
    let matchedBonus: ReturnType<typeof matchBonusField> = null
    let createdBonus: string | null = null
    if (bonusText) {
      const fields = listBonusFields('businessPartner') as Parameters<typeof matchBonusField>[0]
      matchedBonus = matchBonusField(fields, bonusText)
    }

    // Agentic MDM request: 1 email thread = 1 conversation context = 1 request
    const request = insertRequest({
      threadId: data.threadId,
      type: 'BUSINESS_PARTNER',
      bpClass: bp.partnerClassDb,
      requesterEmail: data.requestorEmail,
      status: 'PENDING_APPROVAL',
      payload: {
        name: bp.name,
        creditTerms: bp.creditTerms,
        bankAccountNumber: bp.bankAccountNumber,
        contactName: bp.contactName,
        contactEmail: bp.contactEmail,
        contactPhone: bp.contactPhone,
        country: bp.country,
        countryOfOrigin,
        addresses: bp.addresses,
        approvers: requiredApprovers,
      },
      needsItConfig,
      requestReason: reason,
      bonusText,
    })

    if (matchedBonus) {
      setBonusValue(request.id, matchedBonus.id, bonusText?.slice(0, 200) ?? null)
    } else if (bonusText) {
      const derived = deriveBonusName(bonusText)
      if (derived) {
        const nf = addBonusField('businessPartner', derived)
        if (nf) {
          createdBonus = nf.name
          setBonusValue(request.id, (nf as any).id, bonusText.slice(0, 200))
        }
      }
    }

    // Emit the shared wire template exactly as specified
    const wire = template({
      request_id: request.id,
      process_status: request.status,
      custom_data: bp.customData,
    })

    appendAudit(request.id, data.requestorEmail, 'SUBMITTED', `Requester ${data.requestorEmail} submitted ${request.type} — Reason: ${reason}`)

    return {
      ok: true as const,
      partner: bp,
      request,
      wire,
      ibanOk,
      matchedBonus: matchedBonus?.name ?? null,
      createdBonus,
      needsItConfig,
    }
  })

// ---- Read side --------------------------------------------------------------

export const getPartners = createServerFn({ method: 'GET' }).handler(() => {
  return listPartners()
})

export const getBankAccounts = createServerFn({ method: 'GET' }).handler(() => {
  return listBankAccounts()
})

export const getBpRequirements = createServerFn({ method: 'GET' }).handler((): BpTypeRequirement[] => {
  return BP_TYPE_REQUIREMENTS
})

export const getCountries = createServerFn({ method: 'GET' }).handler(() => {
  return COUNTRIES
})

interface ProductRow {
  id: string
  code: string
  name: string
  tracksCogs: number
  createdAt: string
}
interface OrderRow {
  id: string
  orderNumber: string
  productCode: string
  partnerId: string
  direction: string
  qty: number
  paymentDate: string | null
  deliveryDate: string | null
  createdAt: string
}

export const getProducts = createServerFn({ method: 'GET' }).handler((): ProductRow[] => {
  return listProducts() as ProductRow[]
})

export const getOrders = createServerFn({ method: 'GET' }).handler((): OrderRow[] => {
  return listOrders() as OrderRow[]
})

export const getBonusFields = createServerFn({ method: 'GET' }).handler(() => {
  return listBonusFields()
})

export const getKycReviewUrl = createServerFn({ method: 'GET' }).handler(() => {
  // Tab 3 "KYC / Compliance Review" redirect target
  return KYC_REVIEW_URL
})

// ---- Request approval (Sprint 1 core flow) -----------------------------------
// Approver authorizes the request -> record created in MDM (mock SAP B1 write)

// Per-recipient magic links: the approver's link carries the decision rights
// and their identity is resolved from the link owner's email — no email input.
// Requestor links resolve without canApprove and stay view-only.
export const decideRequest = createServerFn({ method: 'POST' })
  .validator(
    (data: {
      requestId: string
      secret: string
      decision: 'APPROVE' | 'REJECT'
      note?: string
    }) => data,
  )
  .handler(async ({ data }) => {
    const link = getRequestLink(data.requestId, data.secret)
    if (!link || !link.canApprove) {
      return { ok: false as const, error: 'ACCESS_DENIED: this link does not carry approval rights' }
    }
    const approverEmail = link.email

    const denied =
      userRoles(approverEmail).includes('approver') || userRoles(approverEmail).includes('it')
        ? null
        : { ok: false as const, error: `ACCESS_DENIED: ${approverEmail} is not an approver` }
    if (denied) return denied

    const req = getRequest(data.requestId)
    if (!req) return { ok: false as const, error: 'NOT_FOUND' }
    if (req.status !== 'PENDING_APPROVAL') {
      return { ok: false as const, error: `Request already ${req.status}` }
    }
    const requiredApprovers: string[] = Array.isArray(req.payload?.approvers) && req.payload.approvers.length
      ? req.payload.approvers
      : [approverEmail]
    if (!requiredApprovers.includes(approverEmail)) {
      return {
        ok: false as const,
        error: `ACCESS_DENIED: ${approverEmail} is not an assigned approver for this request`,
      }
    }

    if (data.decision === 'REJECT') {
      const rejectionReason = (data.note ?? '').trim()
      if (!rejectionReason) {
        return { ok: false as const, error: 'REJECTION_REASON_REQUIRED: a reason is required when rejecting' }
      }
      recordApproval(req.id, approverEmail, 'REJECTED', rejectionReason)
      appendAudit(req.id, approverEmail, 'REJECTED', rejectionReason)
      updateRequestStatus(req.id, 'REJECTED', approverEmail, rejectionReason)
      const requester = listUsers().find((u) => u.email === req.requesterEmail)
      const rejectBody = `Hi ${requester?.name ?? req.requesterEmail},\n\nYour request was rejected by ${approverEmail}.\nRejection reason: ${rejectionReason}\nStatus: REJECTED.\n\nView: ${APP_URL}/r/${req.id}/${ensureRequestLink(req.id, req.requesterEmail, false).secret}`
      await sendMail({
        fromAddress: mailboxEmail(),
        toAddress: req.requesterEmail,
        subject: `Update on your request ${req.id.slice(0, 8)} — REJECTED`,
        content: rejectBody,
      })
      recordEmail(req.id, req.requesterEmail, `Update on your request ${req.id.slice(0, 8)} — REJECTED`, rejectBody)
      return {
        ok: true as const,
        status: 'REJECTED',
        approvalCount: listApprovals(req.id).length,
        required: 1,
        wire: template({
          request_id: req.id,
          process_status: 'REJECTED',
          custom_data: { decidedBy: approverEmail, rejectionReason },
        }),
      }
    }

    // Approve: record approval first, then decide if all required approvers done
    recordApproval(req.id, approverEmail, 'APPROVED', data.note ?? null)
    appendAudit(req.id, approverEmail, 'APPROVED', data.note ?? undefined)
    const approvedCount = listApprovals(req.id).filter(
      (a) => a.decision === 'APPROVED' && requiredApprovers.includes(a.approverEmail),
    ).length
    const final = approvedCount >= requiredApprovers.length

    if (final) {
      const isChange = !!req.payload?.originalRequestId && !!req.payload?.intent
      if (isChange && req.type === 'BUSINESS_PARTNER') {
        const original = getRequest(req.payload.originalRequestId)
        const partner = (listPartners() as any[]).find((p) => p.name === (original?.payload?.name ?? req.payload?.name))
        if (partner) {
          if (req.payload.intent === 'delete') updatePartnerStatus(partner.id, 'REJECTED')
          else updatePartnerRecord(partner.id, req.payload)
        }
      } else {
        const linked = listPartners().find((p: any) => p.name === req.payload.name)
        if (linked) updatePartnerStatus(linked.id, 'PUSHED_TO_SAP')
      }
    }

    const status = final ? 'CREATED_IN_MDM' : 'PENDING_APPROVAL'
    updateRequestStatus(req.id, status, approverEmail, data.note ?? null)

    const wire = template({
      request_id: req.id,
      process_status: final ? 'CREATED_IN_MDM' : 'PENDING',
      custom_data: { decidedBy: approverEmail, mockedSapB1: final ? 'true' : 'false' },
    })
    if (final) insertApiRequest(req.id, wire)

    // Email the requestor
    const requester = listUsers().find((u) => u.email === req.requesterEmail)
    const requesterName = requester?.name ?? req.requesterEmail
    const approveBody = `Hi ${requesterName},\n\nYour request was approved by ${approverEmail}.\n${data.note ? 'Note: ' + data.note + '\n' : ''}Status: ${status}.\n${final ? '' : 'Pending remaining approvers: ' + requiredApprovers.filter((a) => !listApprovals(req.id).some((x) => x.approverEmail === a && x.decision === 'APPROVED')).join(', ') + '\n'}\nView: ${APP_URL}/r/${req.id}/${ensureRequestLink(req.id, req.requesterEmail, false).secret}`
    await sendMail({
      fromAddress: mailboxEmail(),
      toAddress: req.requesterEmail,
      subject: `Update on your request ${req.id.slice(0, 8)} — APPROVED`,
      content: approveBody,
    })
    recordEmail(req.id, req.requesterEmail, `Update on your request ${req.id.slice(0, 8)} — APPROVED`, approveBody)

    return {
      ok: true as const,
      status,
      approvalCount: approvedCount,
      required: requiredApprovers.length,
      wire,
    }
  })
 
export const cancelRequest = createServerFn({ method: 'POST' })
  .validator((data: { requestId: string; secret: string; note?: string }) => data)
  .handler(async ({ data }) => {
    const link = getRequestLink(data.requestId, data.secret)
    if (!link) return { ok: false as const, error: 'ACCESS_DENIED: invalid link' }
    const req = getRequest(data.requestId)
    if (!req || req.id !== link.requestId) return { ok: false as const, error: 'NOT_FOUND' }
    if (link.email !== req.requesterEmail) {
      return { ok: false as const, error: 'ACCESS_DENIED: only the requester can cancel' }
    }
    if (req.status !== 'PENDING_APPROVAL') {
      return { ok: false as const, error: `Request already ${req.status}` }
    }
    const partner = req.type === 'BUSINESS_PARTNER'
      ? (listPartners() as any[]).find((p) => p.name === req.payload?.name)
      : undefined
    if (partner) updatePartnerStatus(partner.id, 'REJECTED')
    appendAudit(req.id, link.email, 'CANCELLED', data.note ?? 'Cancelled by requester')
    updateRequestStatus(req.id, 'CANCELLED', link.email, data.note ?? 'Cancelled by requester')
    const requester = listUsers().find((u) => u.email === req.requesterEmail)
    const cancelBody = `Hi ${requester?.name ?? req.requesterEmail},\n\nYour request was cancelled by ${link.email}.\n${data.note ? 'Note: ' + data.note + '\n' : ''}Status: CANCELLED.\n\nView: ${APP_URL}/r/${req.id}/${ensureRequestLink(req.id, req.requesterEmail, false).secret}`
    await sendMail({
      fromAddress: mailboxEmail(),
      toAddress: req.requesterEmail,
      subject: `Update on your request ${req.id.slice(0, 8)} — CANCELLED`,
      content: cancelBody,
    })
    recordEmail(req.id, req.requesterEmail, `Update on your request ${req.id.slice(0, 8)} — CANCELLED`, cancelBody)
    return { ok: true as const, status: 'CANCELLED' }
  })
export const listRequestsFn = createServerFn({ method: 'GET' }).handler(() => {
  return listRequests().map((r) => ({
    ...r,
    viewSecret: ensureRequestLink(r.id, r.requesterEmail, false).secret,
  }))
})

// ---- Bank staging + dual approval ------------------------------------------

export const stageBankAccount = createServerFn({ method: 'POST' })
  .validator(
    (data: {
      requestorEmail: string
      bpId: string
      iban: string
      beneficiaryName: string
      bankRegisteredName: string
      taxId: string
      country: string
    }) => data,
  )
  .handler(async ({ data }) => {
    const denied = requireRole(data.requestorEmail, 'requester')
    if (denied) return { ok: false as const, error: denied.error }

    // uuid staged in bank_accounts before push
    const staged = stagedBankAccount(
      data.bpId,
      data.iban,
      data.beneficiaryName,
      data.bankRegisteredName,
      data.taxId,
      data.country,
    )
    if (!staged) {
      return { ok: false as const, error: 'VALIDATION_FAILED' }
    }
    insertBankAccount(staged)
    return {
      ok: true as const,
      bank_account_id: staged.id,
      wire: template({
        request_id: staged.id,
        process_status: 'PENDING',
        custom_data: { bpId: staged.bpId, iban: staged.iban },
      }),
    }
  })

export const approveBankAccount = createServerFn({ method: 'POST' })
  .validator(
    (data: {
      approverEmail: string
      bankAccountId: string
      tier: 'APPROVER_1' | 'APPROVER_2'
    }) => data,
  )
  .handler(async ({ data }) => {
    const denied = requireRole(data.approverEmail, 'approver')
    if (denied) return { ok: false as const, error: denied.error }

    const acct = getBankAccount(data.bankAccountId)
    if (!acct) return { ok: false as const, error: 'NOT_FOUND' }
    if (acct.status === 'PUSHED_TO_SAP') {
      return { ok: false as const, error: 'ALREADY_PUSHED' }
    }
    const nextStatus: 'DUAL_APPROVAL_PENDING' | 'PUSHED_TO_SAP' =
      data.tier === 'APPROVER_1' ? 'DUAL_APPROVAL_PENDING' : 'PUSHED_TO_SAP'
    updateBankAccount(data.bankAccountId, {
      approval1By: data.tier === 'APPROVER_1' ? data.approverEmail : acct.approval1By ?? null,
      approval2By: data.tier === 'APPROVER_2' ? data.approverEmail : acct.approval2By ?? null,
      status: nextStatus,
    })
    return {
      ok: true as const,
      status: nextStatus,
      wire: template({
        request_id: acct.id,
        process_status: nextStatus,
        custom_data: { bpId: acct.bpId, decidedBy: data.approverEmail },
      }),
    }
  })

// ---- Zoho AgentInbox ingestion ----------------------------------------------

export const syncInboxFn = createServerFn({ method: 'POST' }).handler(async () => {
  return syncInbox()
})

export const getSyncStatus = createServerFn({ method: 'GET' }).handler(() => {
  return {
    lastSyncAt: getSyncState('last_sync_at'),
    lastError: getSyncState('last_sync_error'),
    lastProcessed: getSyncState('last_sync_processed'),
    agentName: getSyncState('zoho_agent_name'),
    lastAgnesInput: getSyncState('last_agnes_input'),
    lastAgnesOutput: getSyncState('last_agnes_output'),
  }
})

export const testZoho = createServerFn({ method: 'GET' }).handler(async () => {
  const resolved = await resolveAgentName()
  if (!resolved.name) return { ok: false, agentName: null, error: resolved.error, tried: resolved.tried }
  const listing = await listUnreadMessages(5)
  return { ok: listing.ok, agentName: resolved.name, count: listing.messages.length, error: listing.error }
})

// ---- Legacy migration to SAP S/4 HANA ---------------------------------------

export const pushLegacyPartners = createServerFn({ method: 'POST' })
  .validator((data: { requestorEmail: string; partnerIds: string[] }) => data)
  .handler(async ({ data }) => {
    const denied = requireRole(data.requestorEmail, 'requester')
    if (denied) return { ok: false as const, error: denied.error }
    const requestIdById: Record<string, string> = {}
    for (const p of listPartners()) {
      requestIdById[(p as any).id] = (p as any).requestId
    }
    markPartnersPushed(data.partnerIds, requestIdById)
    return {
      ok: true as const,
      wire: template({
        request_id: data.partnerIds.join('|'),
        process_status: 'PUSHED_TO_SAP',
        custom_data: { count: String(data.partnerIds.length) },
      }),
    }
  })

export type { Schema }
