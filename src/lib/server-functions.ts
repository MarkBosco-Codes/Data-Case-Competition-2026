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
  getItApproverEmail,
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
  updateRequestApprovalColumns,
  updateRequestPayload,
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
import { getSyncState, setSyncState } from '~/lib/db'
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

    // Agent picks the bonus field that best matches the requester free-text
    // email; creates a new subclass if the attribute is not covered yet.
    const bonusText = (data.notes ?? '').trim() || null
    const reason = data.reason.trim()
    let matchedBonus: ReturnType<typeof matchBonusField> = null
    let createdBonus: string | null = null
    if (bonusText) {
      const fields = listBonusFields('businessPartner')
      matchedBonus = matchBonusField(fields, bonusText)
    }
    const derivedNewField = bonusText && !matchedBonus && !!deriveBonusName(bonusText)
    const needsItConfig = !!derivedNewField

    const businessApprovers = listLinks()
      .filter((l) => l.requester === String(data.requestorEmail ?? '').trim().toLowerCase())
      .map((l) => l.approver)
    const approverList = businessApprovers.length
      ? businessApprovers
      : (listUsers() as any[]).filter((u) => (u.roles || []).includes('approver')).map((u) => u.email)
    const requiredApprovers = [...approverList]
    if (needsItConfig && !requiredApprovers.includes(getItApproverEmail())) {
      requiredApprovers.push(getItApproverEmail())
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
      approvalType: 'QUALITY',
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

export const submitBpDetails = createServerFn({ method: 'POST' })
  .validator(
    (data: {
      requestId: string
      secret: string
      bankAccountNumber: string
      creditTerms: 'NET15' | 'NET30' | 'NET45' | 'NET60' | 'PREPAID'
      requiresRegulatoryApproval?: boolean
    }) => data,
  )
  .handler(async ({ data }) => {
    const link = getRequestLink(data.requestId, data.secret)
    if (!link) {
      return { ok: false as const, error: 'ACCESS_DENIED: invalid link' }
    }
    const req = getRequest(data.requestId)
    if (!req) return { ok: false as const, error: 'NOT_FOUND' }

    if (req.status !== 'IN_PROGRESS' && req.status !== 'NEW') {
      return { ok: false as const, error: `Request status is ${req.status}` }
    }

    const bankAccountNumber = (data.bankAccountNumber ?? '').trim()
    const creditTerms = data.creditTerms
    if (!bankAccountNumber) {
      return { ok: false as const, error: 'Bank account number is required' }
    }
    if (!creditTerms) {
      return { ok: false as const, error: 'Credit terms are required' }
    }

    let approvalType = req.approvalType
    let regulatoryApproved = req.regulatoryApproved
    if (data.requiresRegulatoryApproval) {
      approvalType = 'REGULATORY'
      regulatoryApproved = 'PENDING'
    }

    const businessApprovers = listLinks()
      .filter((l) => l.requester === String(req.requesterEmail ?? '').trim().toLowerCase())
      .map((l) => l.approver)
    const approverList = businessApprovers.length
      ? businessApprovers
      : (listUsers() as any[]).filter((u) => (u.roles || []).includes('approver')).map((u) => u.email)
    const requiredApprovers = [...approverList]
    if (approvalType === 'REGULATORY') {
      for (const u of listUsers() as any[]) {
        if ((u.roles || []).includes('regulatory') && !requiredApprovers.includes(u.email)) {
          requiredApprovers.push(u.email)
        }
      }
    }

    const needsItConfig = !!req.needsItConfig
    if (needsItConfig && !requiredApprovers.includes(getItApproverEmail())) {
      requiredApprovers.push(getItApproverEmail())
    }

    const updatedPayload = {
      ...req.payload,
      bankAccountNumber,
      creditTerms,
      approvers: requiredApprovers,
    }

    updateRequestPayload(req.id, updatedPayload)
    updateRequestStatus(req.id, 'PENDING_APPROVAL')
    updateRequestApprovalColumns(req.id, 'N/A', regulatoryApproved)

    const last4 = bankAccountNumber.slice(-4)
    const maskedBank = '*'.repeat(Math.max(0, bankAccountNumber.length - 4)) + last4

    appendAudit(
      req.id,
      req.requesterEmail,
      'SUBMITTED',
      `Requester submitted Bank Account Number (${maskedBank}). Request sent for approval.`,
    )

    const partnerName = req.payload?.name
    const partner = partnerName ? (listPartners() as any[]).find((p) => p.name === partnerName) : undefined
    if (partner) {
      updatePartnerRecord(partner.id, {
        bankAccountNumber,
        creditTerms,
      })
    }

    const wire = template({
      request_id: req.id,
      process_status: 'PENDING_APPROVAL',
      custom_data: { name: partnerName },
    })

    const subjectPrefix = approvalType === 'REGULATORY' ? 'Regulatory review — ' : 'Quality review — '
    const subject = `Approval needed: ${subjectPrefix}New ${req.bpClass ?? 'Partner'} ${partnerName}`
    const detailText = `Name: ${partnerName}\nPartner class: ${req.bpClass}\nRequest reason: ${req.requestReason ?? 'N/A'}`

    for (const approverEmail of requiredApprovers) {
      const appLink = ensureRequestLink(req.id, approverEmail, true)
      const reviewUrl = `${APP_URL}/r/${req.id}/${appLink.secret}`
      const body = `Hi,\n\nA new business-partner request requires your approval.\n\n${detailText}\n\nYour link (review and approve):\n${reviewUrl}\n\nWire:\n${wire}\n\nThanks,\nLifeGroup DataGent`
      await sendMail({
        fromAddress: mailboxEmail(),
        toAddress: approverEmail,
        subject,
        content: body,
      })
      recordEmail(req.id, approverEmail, subject, body)
    }

    insertApiRequest(req.id, wire)

    return { ok: true as const, status: 'PENDING_APPROVAL' }
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
      userRoles(approverEmail).includes('approver') ||
      userRoles(approverEmail).includes('regulatory') ||
      userRoles(approverEmail).includes('it')
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
      updateRequestApprovalColumns(req.id, 'N/A', req.regulatoryApproved !== 'N/A' ? 'REJECTED' : 'N/A')
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
    if (final) {
      updateRequestApprovalColumns(req.id, 'N/A', req.regulatoryApproved !== 'N/A' ? 'APPROVED' : 'N/A')
    }

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

// ---- Approver Reminders ---------------------------------------------------

export const getReminderSettingsFn = createServerFn({ method: 'GET' }).handler(async () => {
  const daysStr = getSyncState('reminder_frequency_days')
  const days = daysStr ? parseInt(daysStr, 10) : 3
  const lastPushedAt = getSyncState('last_reminder_pushed_at')
  return { days: isNaN(days) ? 3 : days, lastPushedAt }
})

export const setReminderDaysFn = createServerFn({ method: 'POST' })
  .validator((data: { days: number }) => data)
  .handler(async ({ data }) => {
    const d = Math.max(1, Math.min(365, data.days || 3))
    setSyncState('reminder_frequency_days', String(d))
    return { ok: true, days: d }
  })

export const pushRemindersNowFn = createServerFn({ method: 'POST' }).handler(async () => {
  const requests = listRequests() as any[]
  const users = listUsers() as any[]
  const userMap: Record<string, string> = {}
  for (const u of users) userMap[u.email] = u.name ?? u.email

  const pendingRequests = requests.filter((r) => r.status === 'PENDING_APPROVAL')

  const approverOutstanding: Record<
    string,
    Array<{ id: string; type: string; requesterEmail: string; requesterName: string; link: string }>
  > = {}

  for (const req of pendingRequests) {
    let payload: any = {}
    try {
      payload = typeof req.payload === 'string' ? JSON.parse(req.payload) : (req.payload ?? {})
    } catch {
      payload = {}
    }
    const requiredApprovers: string[] =
      Array.isArray(payload.approvers) && payload.approvers.length
        ? payload.approvers
        : ['sendtomarkbosco@gmail.com']

    if (req.needsItConfig && !requiredApprovers.includes(getItApproverEmail())) {
      requiredApprovers.push(getItApproverEmail())
    }

    const existingApprovals = listApprovals(req.id)

    for (const approverEmail of requiredApprovers) {
      const alreadyDecided = existingApprovals.some((a) => a.approverEmail === approverEmail)
      if (!alreadyDecided) {
        if (!approverOutstanding[approverEmail]) approverOutstanding[approverEmail] = []
        const linkRow = ensureRequestLink(req.id, approverEmail, true)
        const approveLink = `${APP_URL}/r/${req.id}/${linkRow.secret}`
        const requesterName = userMap[req.requesterEmail] ?? req.requesterEmail
        approverOutstanding[approverEmail].push({
          id: req.id,
          type: req.type,
          requesterEmail: req.requesterEmail,
          requesterName,
          link: approveLink,
        })
      }
    }
  }

  const approverEmails = Object.keys(approverOutstanding)
  if (approverEmails.length === 0) {
    const now = new Date().toISOString()
    setSyncState('last_reminder_pushed_at', now)
    return { ok: true, sentCount: 0, approversNotified: [], message: 'No pending approvals outstanding for any approver.' }
  }

  const fromAddress = mailboxEmail()
  let sentCount = 0
  const notified: string[] = []

  for (const approverEmail of approverEmails) {
    const items = approverOutstanding[approverEmail]
    const count = items.length
    if (count === 0) continue

    const listLines = items
      .map(
        (it) =>
          `• ${it.type.replace(/_/g, ' ')} — Requested by ${it.requesterName} (${it.requesterEmail})\n  Approve link: ${it.link}`,
      )
      .join('\n\n')

    const subject = `Reminder: You have ${count} outstanding request${count > 1 ? 's' : ''} to approve`
    const body = `Hi,\n\nYou have ${count} outstanding request${count > 1 ? 's' : ''} awaiting your approval:\n\n${listLines}\n\nThanks,\nLifeGroup DataGent`

    const mailRes = await sendMail({
      fromAddress,
      toAddress: approverEmail,
      subject,
      content: body,
    })

    for (const item of items) {
      recordEmail(item.id, approverEmail, subject, body)
      appendAudit(item.id, 'system', 'REMINDER_SENT', `Sent approval reminder email to ${approverEmail}`)
    }

    sentCount += count
    notified.push(approverEmail)
  }

  const now = new Date().toISOString()
  setSyncState('last_reminder_pushed_at', now)

  return {
    ok: true,
    sentCount,
    approversNotified: notified,
    message: `Successfully sent reminders to ${notified.length} approver(s) (${sentCount} outstanding request(s) total).`,
  }
})

export type { Schema }
