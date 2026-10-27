import {
  insertPartner,
  insertRequest,
  insertProduct,
  insertOrder,
  appendAudit,
  listPartners,
  listBonusFields,
  addBonusField,
  setBonusValue,
  recordEmail,
  isEmailProcessed,
  markEmailProcessed,
  ensureRequestLink,
  getLatestPendingRequest,
  getLatestRequest,
  updateRequestPayload,
  updateRequestReason,
  updatePartnerRecord,
  getSyncState,
  setSyncState,
  listProducts,
  listLinks,
  listUsers,
  insertApiRequest,
} from '~/lib/db'
  import { findDuplicate, matchBonusField, deriveBonusName, template, isValidTaxFormat } from '~/lib/validation'
import type { BusinessPartner } from '~/lib/types'
import { listUnreadMessages, getMessageContent, sendReply, sendMail, resolveAgentName, mailboxEmail } from './zoho.server'
import { parseEmailToIntake } from './agnes.server'
import { COUNTRIES } from '~/lib/constants'

export interface SyncResult {
  ok: boolean
  agentName?: string | null
  processed: number
  skipped: number
  errors: string[]
  lastSyncAt: string
  tried?: string[]
  agnesLog?: { input: string; output: string }[]
}

const APP_URL = (process.env['APP_URL'] ?? process.env['VITE_APP_URL'] ?? 'http://localhost:3000').replace(/\/$/, '')

function creditTermsOrDefault(v: any): any {
  const allowed = ['NET15', 'NET30', 'NET45', 'NET60', 'PREPAID']
  return allowed.includes(v) ? v : 'NET30'
}

function makeViewLink(requestId: string, secret: string) {
  return `${APP_URL}/r/${requestId}/${secret}`
}

export async function syncInbox(): Promise<SyncResult> {
  const errors: string[] = []
  let processed = 0
  let skipped = 0
  const agnesLog: { input: string; output: string }[] = []

  const resolved = await resolveAgentName()
  console.log(`[datagent] sync starting for agent ${resolved.name ?? '(unresolved)'}`)
  if (!resolved.name) {
    const r: SyncResult = {
      ok: false,
      agentName: null,
      processed: 0,
      skipped: 0,
      errors: [resolved.error ?? 'No working agent name'],
      lastSyncAt: new Date().toISOString(),
      tried: resolved.tried,
      agnesLog,
    }
    setSyncState('last_sync_at', r.lastSyncAt)
    setSyncState('last_sync_error', r.errors.join('; '))
    return r
  }

  const listing = await listUnreadMessages(50)
  console.log(`[datagent] fetched inbox for ${resolved.name}: ${listing.messages.length} unread message(s)`)
  if (!listing.ok) {
    const r: SyncResult = {
      ok: false,
      agentName: resolved.name,
      processed: 0,
      skipped: 0,
      errors: [listing.error ?? 'Failed to list messages'],
      lastSyncAt: new Date().toISOString(),
      agnesLog,
    }
    setSyncState('last_sync_at', r.lastSyncAt)
    setSyncState('last_sync_error', r.errors.join('; '))
    return r
  }

  for (const msg of listing.messages) {
    if (isEmailProcessed(msg.messageId)) {
      skipped++
      continue
    }
    console.log(`[datagent] new message detected: ${msg.messageId} from ${msg.fromAddress || msg.sender} subject="${msg.subject}"`)
    try {
      const content = await getMessageContent(msg.messageId)
      const textContent = content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
      const fromEmail = (msg.fromAddress || msg.sender || '').trim().toLowerCase()
      const subject = msg.subject || '(no subject)'
      // Skip only the agent's own outbound mail if it lands in its own inbox.
      // Human follow-up replies ("Re: ...") are processed: if the sender already has an
      // open request, the reply is treated as a follow-up providing missing details
      // instead of a new request.
      if (!fromEmail || fromEmail === mailboxEmail().toLowerCase()) {
        console.log(`[datagent] skipping self-mail ${msg.messageId} (${subject})`)
        markEmailProcessed(msg.messageId, null, fromEmail, subject, !fromEmail ? 'NO_FROM' : 'SELF_REPLY')
        skipped++
        continue
      }
      const agnesResult = await parseEmailToIntake({ subject, content: textContent, from: fromEmail })
      const parsed = agnesResult.parsed
      agnesLog.push({ input: agnesResult.input, output: agnesResult.output })
      console.log(`[datagent] classified: ${JSON.stringify(parsed)}`)

      const fromAddress = mailboxEmail()
      const reply = async (body: string, subj?: string, to?: string) => {
        console.log(`[datagent] sending reply to ${msg.messageId}:\n${body}`)
        await sendReply({
          messageId: msg.messageId,
          fromAddress,
          toAddress: to,
          subject: subj ?? `Re: ${subject}`,
          content: body,
          action: 'reply',
        })
      }
      const approversFor = (requesterEmail: string): string[] => {
        const linked = listLinks()
          .filter((l) => l.requester === requesterEmail)
          .map((l) => l.approver)
        if (linked.length) return linked
        return (listUsers() as any[])
          .filter((u) => (u.roles || []).includes('approver'))
          .map((u) => u.email)
      }
      const notifyApprovers = async (requestId: string, wire: string, kind: string, detail: string, subject?: string, approversOverride?: string[]) => {
        const approvers = approversOverride ?? approversFor(fromEmail)
        for (const approverEmail of approvers) {
          const link = ensureRequestLink(requestId, approverEmail, true)
          const body = `Hi,\n\nA new ${kind} request requires your approval.\n\n${detail}\n\nYour link (review and approve):\n${makeViewLink(requestId, link.secret)}\n\nWire:\n${wire}\n\nThanks,\nLifeGroup DataGent`
          const mailRes = await sendMail({
            fromAddress,
            toAddress: approverEmail,
            subject: subject ?? `Approval needed: ${kind} request`,
            content: body,
          })
          if (!mailRes.ok) console.log(`[datagent] approver mail failed: ${mailRes.error}`)
          recordEmail(requestId, approverEmail, subject ?? `Approval needed: ${kind} request`, body)
        }
        return approvers
      }

      // ---- Follow-up: human reply ("Re: ...") on an open request updates it ----
      const followupType = String(parsed?.type ?? '').toUpperCase()
      const openRequest = /^re:/i.test(subject) ? getLatestPendingRequest(fromEmail) : undefined
      if (openRequest && (!followupType || followupType === 'UNKNOWN' || followupType === openRequest.type)) {
        if (parsed?.requestReason && parsed.requestReason.trim() && parsed.requestReason.trim() !== (openRequest.requestReason ?? '')) {
          updateRequestReason(openRequest.id, parsed.requestReason.trim())
        }
        const bodyHead = `Hi,\n\n`
        const bodyTail = `\n\nTrack it here:\n${makeViewLink(openRequest.id, ensureRequestLink(openRequest.id, fromEmail, false).secret)}\n\nThanks,\nLifeGroup DataGent`
        if (openRequest.type === 'BUSINESS_PARTNER') {
          const payload: any = { ...openRequest.payload }
          for (const f of [
            'name',
            'creditTerms',
            'bankAccountNumber',
            'contactName',
            'contactEmail',
            'contactPhone',
            'country',
            'countryOfOrigin',
            'partnerClass',
          ] as const) {
            const v = (parsed as any)?.[f]
            if (v !== undefined && v !== null && String(v).trim() !== '') payload[f] = v
          }
          if ((parsed as any)?.addresses !== undefined && (parsed as any)?.addresses !== null) {
            const ra = (parsed as any).addresses
            const norm = typeof ra === 'string'
              ? ra.trim()
              : [ra?.registered, ra?.office, ra?.correspondence].filter((v) => String(v ?? '').trim()).join('; ').trim()
           if (norm) payload.addresses = norm
           }
          const addresses = String(payload.addresses ?? '').trim()
          updateRequestPayload(openRequest.id, payload)
          const oldName = String((openRequest.payload as any).name ?? '').trim()
          const partner = oldName ? (listPartners() as any[]).find((p) => p.name === oldName) : undefined
          if (partner) updatePartnerRecord(partner.id, { ...payload })
          const missing: string[] = []
          if (!String(payload.name ?? '').trim()) missing.push('Business-Partner name')
          if (!String(payload.bankAccountNumber ?? '').trim()) missing.push('Bank Account Number')
          if (!String(payload.contactName ?? '').trim()) missing.push('Contact Name')
          if (!String(payload.contactEmail ?? '').trim()) missing.push('Contact Email')
          if (!String(payload.contactPhone ?? '').trim()) missing.push('Contact Phone')
          if (!payload.country || !(COUNTRIES as readonly string[]).includes(String(payload.country))) missing.push('Country')
          if (!String(addresses ?? '').trim()) missing.push('Address')
          if (missing.length) {
            const body = `${bodyHead}Thanks — I've updated your business-partner request. Still missing:\n${missing.map((m) => `• ${m}`).join('\n')}\n\nPlease reply with the missing details. Credit terms default to NET30 unless you state otherwise.${bodyTail}`
            await reply(body)
            recordEmail(openRequest.id, fromEmail, subject, body)
            markEmailProcessed(msg.messageId, openRequest.id, fromEmail, subject, 'STILL_MISSING')
            processed++
            continue
          }
          appendAudit(openRequest.id, fromEmail, 'UPDATED', `Follow-up email ${msg.messageId} — details completed`)
          const body = `${bodyHead}Thanks — your business-partner request now has all the required details and is pending approval.\n\nName: ${payload.name}\nPartner class: ${payload.partnerClass ?? openRequest.bpClass ?? 'Customer'}\nBank Account Number: ${payload.bankAccountNumber}\nContact phone: ${payload.contactPhone}\nAddress: ${addresses}${bodyTail}`
          await reply(body)
          recordEmail(openRequest.id, fromEmail, subject, body)
          markEmailProcessed(msg.messageId, openRequest.id, fromEmail, subject, 'FOLLOW_UP')
          processed++
          continue
        } else {
          const payload: any = { ...openRequest.payload }
          const allowed =
            openRequest.type === 'PRODUCT'
              ? ['code', 'name', 'tracksCogs']
              : openRequest.type === 'ORDER'
                ? ['orderNumber', 'qty', 'paymentDate', 'productCode', 'partnerId']
                : []
          let merged = 0
          for (const [k, v] of Object.entries(parsed ?? {})) {
            if (!allowed.includes(k)) continue
            if (v !== undefined && v !== null && String(v).trim() !== '') {
              payload[k] = v
              merged++
            }
          }
          if (!merged && !parsed?.requestReason) {
            const body = `${bodyHead}Thanks for the reply. This request is already pending approval and I could not tell which field(s) this update refers to. If you meant to update it, reply with the field name and value (e.g. "Name: ..."). If it's a new request, please send a new email (not a reply) with the details and a reason.${bodyTail}`
            await reply(body)
            recordEmail(openRequest.id, fromEmail, subject, body)
            markEmailProcessed(msg.messageId, openRequest.id, fromEmail, subject, 'FOLLOW_UP_NOOP')
            processed++
            continue
          }
          updateRequestPayload(openRequest.id, payload)
          appendAudit(openRequest.id, fromEmail, 'UPDATED', `Follow-up email ${msg.messageId}`)
          const body = `${bodyHead}Thanks — I've updated your request with the details you provided. It remains pending approval.${bodyTail}\n\nYou will be notified once a decision is made.`
          await reply(body)
          recordEmail(openRequest.id, fromEmail, subject, body)
          markEmailProcessed(msg.messageId, openRequest.id, fromEmail, subject, 'FOLLOW_UP')
          processed++
          continue
        }
      }

      // ---- Change request on an already-approved record -----------------------
      // Requestor replies to the thread asking to modify/delete an approved MDM
      // object. We create a new PENDING_APPROVAL request capturing the proposed
      // change and route it through the normal approver-permission flow.
      const latestAny = /^re:/i.test(subject) ? getLatestRequest(fromEmail) : undefined
      const intent = String(parsed?.intent ?? 'create').toLowerCase()
      if (
        latestAny &&
        (latestAny.status === 'CREATED_IN_MDM' || latestAny.status === 'APPROVED') &&
        (intent === 'modify' || intent === 'delete')
      ) {
        const reason = String(parsed?.requestReason ?? parsed?.reason ?? '').trim() || null
        if (!reason) {
          await reply(
            `Hi,\n\nA reason is required before I can request this change. Please reply with the details plus a short reason (e.g. "Reason: customer address correction").\n\nThanks,\nLifeGroup DataGent`,
          )
          markEmailProcessed(msg.messageId, null, fromEmail, subject, 'MISSING_REASON')
          processed++
          continue
        }
        const changeType = latestAny.type
        const proposed: any = { ...(parsed ?? {}) }
        delete proposed.type
        delete proposed.intent
        delete proposed.reason
        delete proposed.notes
        const businessApprovers = approversFor(fromEmail)
        const requiredApprovers = [...businessApprovers]
        if (parsed?.notes && deriveBonusName(String(parsed.notes)) && !requiredApprovers.includes('vanadite111@gmail.com')) {
          requiredApprovers.push('vanadite111@gmail.com')
        }
        const payload: any = {
          originalRequestId: latestAny.id,
          intent,
          approvers: requiredApprovers,
          ...proposed,
        }
        const request = insertRequest({
          threadId: msg.messageId,
          type: changeType,
          bpClass: latestAny.bpClass ?? undefined,
          requesterEmail: fromEmail || 'unknown@unknown',
          status: 'PENDING_APPROVAL',
          payload,
          needsItConfig: !!parsed?.notes && !!deriveBonusName(String(parsed.notes)),
          requestReason: reason,
          bonusText: (parsed?.notes ?? '').trim() || null,
        })
        appendAudit(request.id, fromEmail || 'agent', 'SUBMITTED', `Change request (${intent}) on ${latestAny.id} — Request reason: ${reason}`)
        const trackLink = makeViewLink(request.id, ensureRequestLink(request.id, fromEmail || 'unknown@unknown', false).secret)
        const requesterBody = `Hi,\n\nYour ${intent} request for the previously approved record has been created and is pending approver permission.\n\nRequest reason: ${reason}\n\nTrack it here:\n${trackLink}\n\nYou will be notified once a decision is made.\n\nThanks,\nLifeGroup DataGent`
        await reply(requesterBody)
        recordEmail(request.id, fromEmail, `Re: ${subject}`, requesterBody)
        await notifyApprovers(request.id, template({ request_id: request.id, process_status: 'PENDING_APPROVAL', custom_data: {} }), changeType.toLowerCase().replace('_', '-'), `Change: ${intent}\nOriginal request: ${latestAny.id}\nRequest reason: ${reason}`, undefined, requiredApprovers)
        const changeWire = template({ request_id: request.id, process_status: 'PENDING_APPROVAL', custom_data: {} })
        insertApiRequest(request.id, changeWire)
        markEmailProcessed(msg.messageId, request.id, fromEmail, subject, null)
        processed++
        continue
      }

      if (!parsed || !parsed.type || parsed.type === 'UNKNOWN') {
        const isReply = /^re:/i.test(subject)
        await reply(
          isReply
            ? `Hi,\n\nI heard you, but I couldn't tell exactly what you want to update. If you're replying with details for a previous request, please state them as field/value pairs and include what it's for. If it's a new request, please include the request details plus a short reason (e.g. "Reason: onboarding new supplier").\n\nThanks,\nLifeGroup DataGent`
            : `Hi,\n\nI could not determine what you want to do. Please reply indicating one of:\n1. Add a business partner (customer or supplier)\n2. Add a new product\n3. Create a new order\n\nInclude the relevant details and I'll create the request and send you a tracking link.\n\nThanks,\nLifeGroup DataGent`,
        )
        markEmailProcessed(msg.messageId, null, fromEmail, subject, 'UNKNOWN_TYPE')
        processed++
        continue
      }

      const type = String(parsed.type).toUpperCase()
      const notes = (parsed.notes ?? '').trim() || null
      const reason = String(parsed.requestReason ?? parsed.reason ?? '').trim() || null
      const bonusParentType =
        type === 'BUSINESS_PARTNER' ? 'businessPartner' : type === 'PRODUCT' ? 'product' : 'order'

      // Reason is mandatory for every request
      if (!reason) {
        await reply(
          `Hi,\n\nA reason for your request is required before I can create it. Please reply to this email with your request details plus a short reason (e.g. "Reason: onboarding new supplier for Q3"), and I'll process it.\n\nThanks,\nLifeGroup DataGent`,
        )
        markEmailProcessed(msg.messageId, null, fromEmail, subject, 'MISSING_REASON')
        processed++
        continue
      }

      // ---- BUSINESS_PARTNER ----
      if (type === 'BUSINESS_PARTNER') {
        const name = String(parsed.name ?? '').trim()
        const rawAddr = parsed.addresses
        const parsedAddresses: string = typeof rawAddr === 'string'
          ? rawAddr.trim()
          : [rawAddr?.registered, rawAddr?.office, rawAddr?.correspondence].filter((v) => String(v ?? '').trim()).join('; ').trim()
        const missing: string[] = []
        if (!name) missing.push('Business-Partner name')
        if (!String(parsed.bankAccountNumber ?? '').trim()) missing.push('Bank Account Number')
        if (!String(parsed.contactName ?? '').trim()) missing.push('Contact Name')
        if (!String(parsed.contactEmail ?? '').trim()) missing.push('Contact Email')
        if (!String(parsed.contactPhone ?? '').trim()) missing.push('Contact Phone')
        if (!parsed.country || !(COUNTRIES as readonly string[]).includes(String(parsed.country))) missing.push('Country')
        if (!parsedAddresses) missing.push('Address')
        if (missing.length) {
          await reply(
            `Hi,\n\nThese details must be filled in by the customer before I can create the request:\n${missing.map((m) => `• ${m}`).join('\n')}\n\nPlease reply with the missing details. Note: credit terms default to NET30 unless you state otherwise;\nand country of origin will be collected during KYC.\n\nThanks,\nLifeGroup DataGent`,
          )
          markEmailProcessed(msg.messageId, null, fromEmail, subject, 'MISSING_DETAILS')
          processed++
          continue
        }
        const country = (parsed.country as any) || COUNTRIES[0]
        const partnerClass = parsed.partnerClass === 'Supplier' ? 'Supplier' : 'Customer'
        const existing = listPartners()
        const dupe = findDuplicate(existing as any, {
          name,
          partnerClass,
          country,
          creditTerms: creditTermsOrDefault(parsed.creditTerms),
          bankAccountNumber: parsed.bankAccountNumber ?? '',
           contactDetails: {
             contactName: parsed.contactName ?? '',
             email: parsed.contactEmail ?? '',
             phone: parsed.contactPhone ?? '',
           },
          addresses: parsedAddresses,
        } as any)
        if (dupe) {
          await reply(`Hi,\n\nA duplicate business partner was found (${(dupe as any).name}). No new request created.\n\nThanks,\nLifeGroup DataGent`)
          markEmailProcessed(msg.messageId, null, fromEmail, subject, 'DUPLICATE')
          processed++
          continue
        }

        const bp: BusinessPartner = {
          id: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
          processStatus: 'PENDING',
          customData: {},
          name,
          creditTerms: creditTermsOrDefault(parsed.creditTerms),
          bankAccountNumber: parsed.bankAccountNumber ?? '',
          contactName: parsed.contactName ?? name,
           contactEmail: parsed.contactEmail ?? '',
          contactPhone: parsed.contactPhone ?? '',
          partnerClass,
          partnerClassDb: partnerClass === 'Supplier' ? 'VENDOR' : 'CUSTOMER',
          country,
          countryOfOrigin: parsed.countryOfOrigin ?? null,
          countrySynced: false,
          addresses: parsedAddresses as BusinessPartner['addresses'],
          createdAt: new Date().toISOString(),
        }
        bp.customData = { ibanScreen: 'VALID', creditTerms: bp.creditTerms }
        insertPartner(bp)

        let matchedBonus: any = null
        if (notes) {
          const fields = listBonusFields('businessPartner') as any[]
          matchedBonus = matchBonusField(fields, notes)
        }
        const derivedNewField = !matchedBonus && !!deriveBonusName(notes)
        const needsItConfig = derivedNewField || !isValidTaxFormat(bp.country, bp.bankAccountNumber)
        const businessApprovers = approversFor(fromEmail)
        const requiredApprovers = [...businessApprovers]
        if (needsItConfig && !requiredApprovers.includes('vanadite111@gmail.com')) {
          requiredApprovers.push('vanadite111@gmail.com')
        }
        const request = insertRequest({
          threadId: msg.messageId,
          type: 'BUSINESS_PARTNER',
          bpClass: bp.partnerClassDb,
          requesterEmail: fromEmail || 'unknown@unknown',
          status: 'PENDING_APPROVAL',
          payload: {
            name: bp.name,
            creditTerms: bp.creditTerms,
            bankAccountNumber: bp.bankAccountNumber,
            contactName: bp.contactName,
            contactEmail: bp.contactEmail,
            contactPhone: bp.contactPhone,
            partnerClass: bp.partnerClass,
            country: bp.country,
            countryOfOrigin: bp.countryOfOrigin,
            addresses: bp.addresses,
            approvers: requiredApprovers,
          },
          needsItConfig,
          requestReason: reason,
          bonusText: notes,
        })
        if (matchedBonus) setBonusValue(request.id, matchedBonus.id, notes?.slice(0, 200) ?? null)
        else if (notes) {
          const derived = deriveBonusName(notes)
          if (derived) {
            const nf: any = addBonusField('businessPartner', derived)
            if (nf) {
              setBonusValue(request.id, nf.id, notes.slice(0, 200))
            }
          }
        }
        const wire = template({ request_id: request.id, process_status: request.status, custom_data: bp.customData })
        appendAudit(request.id, fromEmail || 'agent', 'SUBMITTED', `Ingested from email ${msg.messageId} — Request reason: ${reason}`)
        const trackLink = makeViewLink(request.id, ensureRequestLink(request.id, fromEmail || 'unknown@unknown', false).secret)
        const requesterBody = `Hi,\n\nYour business-partner request has been created and is pending approval.\n\nName: ${bp.name}\nPartner class: ${bp.partnerClass} (${bp.partnerClassDb})\nCountry: ${bp.country}\nRequest reason: ${reason}\n\nTrack it here:\n${trackLink}\n\nYou will be notified once a decision is made.\n\nThanks,\nLifeGroup DataGent`
        await reply(requesterBody)
        recordEmail(request.id, fromEmail, `Re: ${subject}`, requesterBody)
        await notifyApprovers(request.id, wire, 'business-partner', `Name: ${bp.name}\nPartner class: ${bp.partnerClass} (${bp.partnerClassDb})\nCountry: ${bp.country}\nRequest reason: ${reason}`, `Approval needed: New ${bp.partnerClass} ${bp.name}`, requiredApprovers)
        insertApiRequest(request.id, wire)
        markEmailProcessed(msg.messageId, request.id, fromEmail, subject, null)
        processed++
        continue
      }

      // ---- PRODUCT ----
      if (type === 'PRODUCT') {
        const pname = String(parsed.name ?? '').trim()
        if (!pname) {
          await reply(`Hi,\n\nMissing product name. Please reply with product name (and code if known).\n\nThanks,\nLifeGroup DataGent`)
          markEmailProcessed(msg.messageId, null, fromEmail, subject, 'MISSING_PRODUCT_NAME')
          processed++
          continue
        }
        const code = String(parsed.code ?? '').trim() || `P${Date.now().toString(36).toUpperCase()}`
        const tracksCogs = parsed.tracksCogs === false ? 0 : 1
        // duplicate code check
        const existing = listProducts() as any[]
        if (existing.some((p) => p.code === code)) {
          await reply(`Hi,\n\nProduct code "${code}" already exists. Please choose a different code.\n\nThanks,\nLifeGroup DataGent`)
          markEmailProcessed(msg.messageId, null, fromEmail, subject, 'DUPLICATE_PRODUCT')
          processed++
          continue
        }
        insertProduct({ id: crypto.randomUUID(), code, name: pname, tracksCogs, createdAt: new Date().toISOString() })

        let matchedBonus: any = null
        if (notes) {
          const fields = listBonusFields('product') as any[]
          matchedBonus = matchBonusField(fields, notes)
        }
        const derivedNewField = !matchedBonus && !!deriveBonusName(notes)
        const businessApprovers = approversFor(fromEmail)
        const requiredApprovers = [...businessApprovers]
        if (derivedNewField && !requiredApprovers.includes('vanadite111@gmail.com')) {
          requiredApprovers.push('vanadite111@gmail.com')
        }
        const request = insertRequest({
          threadId: msg.messageId,
          type: 'PRODUCT',
          bpClass: undefined,
          requesterEmail: fromEmail || 'unknown@unknown',
          status: 'PENDING_APPROVAL',
          payload: { code, name: pname, tracksCogs: !!tracksCogs, approvers: requiredApprovers },
          needsItConfig: derivedNewField,
          requestReason: reason,
          bonusText: notes,
        })
        if (matchedBonus) setBonusValue(request.id, matchedBonus.id, notes?.slice(0, 200) ?? null)
        else if (notes) {
          const derived = deriveBonusName(notes)
          if (derived) {
            const nf: any = addBonusField('product', derived)
            if (nf) setBonusValue(request.id, nf.id, notes.slice(0, 200))
          }
        }
        const wire = template({ request_id: request.id, process_status: request.status, custom_data: { code, name: pname } })
        appendAudit(request.id, fromEmail || 'agent', 'SUBMITTED', `Ingested product from email ${msg.messageId} — Request reason: ${reason}`)
        const trackLink = makeViewLink(request.id, ensureRequestLink(request.id, fromEmail || 'unknown@unknown', false).secret)
        const requesterBody = `Hi,\n\nYour product request has been created and is pending approval.\n\nCode: ${code}\nName: ${pname}\nTracks COGS: ${!!tracksCogs}\nRequest reason: ${reason}\n\nTrack it here:\n${trackLink}\n\nYou will be notified once a decision is made.\n\nThanks,\nLifeGroup DataGent`
        await reply(requesterBody)
        recordEmail(request.id, fromEmail, `Re: ${subject}`, requesterBody)
        await notifyApprovers(request.id, wire, 'product', `Code: ${code}\nName: ${pname}\nTracks COGS: ${!!tracksCogs}\nRequest reason: ${reason}`, `Approval needed: New product ${pname}`, requiredApprovers)
        insertApiRequest(request.id, wire)
        markEmailProcessed(msg.messageId, request.id, fromEmail, subject, null)
        processed++
        continue
      }

      // ---- ORDER ----
      if (type === 'ORDER') {
        const orderNumber = String(parsed.orderNumber ?? '').trim() || `ORD-${Date.now().toString(36).toUpperCase()}`
        const productCode = String(parsed.productCode ?? '').trim()
        const partnerName = String(parsed.partnerName ?? '').trim()
        const qty = Number(parsed.qty) > 0 ? Number(parsed.qty) : 1
        const paymentDate = parsed.paymentDate ?? null
        const deliveryDate = parsed.deliveryDate ?? null

        const partners = listPartners() as any[]
        const partner = partnerName
          ? partners.find((p) => String(p.name).toLowerCase() === partnerName.toLowerCase())
          : null
        const partnerId = partner?.id ?? (partners[0]?.id ?? '')

        if (!productCode) {
          await reply(`Hi,\n\nMissing product code for the order. Please reply with product code, quantity, and customer/vendor.\n\nThanks,\nLifeGroup DataGent`)
          markEmailProcessed(msg.messageId, null, fromEmail, subject, 'MISSING_PRODUCT_CODE')
          processed++
          continue
        }

        insertOrder({
          id: crypto.randomUUID(),
          orderNumber,
          productCode,
          partnerId,
          qty,
          paymentDate,
          deliveryDate,
          createdAt: new Date().toISOString(),
        })

        let matchedBonus: any = null
        if (notes) {
          const fields = listBonusFields('order') as any[]
          matchedBonus = matchBonusField(fields, notes)
        }
        const derivedNewField = !matchedBonus && !!deriveBonusName(notes)
        const businessApprovers = approversFor(fromEmail)
        const requiredApprovers = [...businessApprovers]
        if (derivedNewField && !requiredApprovers.includes('vanadite111@gmail.com')) {
          requiredApprovers.push('vanadite111@gmail.com')
        }
        const request = insertRequest({
          threadId: msg.messageId,
          type: 'ORDER',
          bpClass: undefined,
          requesterEmail: fromEmail || 'unknown@unknown',
          status: 'PENDING_APPROVAL',
          payload: { orderNumber, productCode, partnerName, partnerId, qty, paymentDate, deliveryDate, approvers: requiredApprovers },
          needsItConfig: derivedNewField,
          requestReason: reason,
          bonusText: notes,
        })
        if (matchedBonus) setBonusValue(request.id, matchedBonus.id, notes?.slice(0, 200) ?? null)
        else if (notes) {
          const derived = deriveBonusName(notes)
          if (derived) {
            const nf: any = addBonusField('order', derived)
            if (nf) setBonusValue(request.id, nf.id, notes.slice(0, 200))
          }
        }
        const wire = template({ request_id: request.id, process_status: request.status, custom_data: { orderNumber, productCode, qty: String(qty) } })
        appendAudit(request.id, fromEmail || 'agent', 'SUBMITTED', `Ingested order from email ${msg.messageId} — Request reason: ${reason}`)
        const trackLink = makeViewLink(request.id, ensureRequestLink(request.id, fromEmail || 'unknown@unknown', false).secret)
        const requesterBody = `Hi,\n\nYour order request has been created and is pending approval.\n\nOrder: ${orderNumber}\nProduct: ${productCode}\nPartner: ${partnerName || partnerId}\nQty: ${qty}\nRequest reason: ${reason}\n\nTrack it here:\n${trackLink}\n\nYou will be notified once a decision is made.\n\nThanks,\nLifeGroup DataGent`
        await reply(requesterBody)
        recordEmail(request.id, fromEmail, `Re: ${subject}`, requesterBody)
        await notifyApprovers(request.id, wire, 'order', `Order: ${orderNumber}\nProduct: ${productCode}\nPartner: ${partnerName || partnerId}\nQty: ${qty}\nRequest reason: ${reason}`, `Approval needed: New order ${orderNumber}`, requiredApprovers)
        insertApiRequest(request.id, wire)
        markEmailProcessed(msg.messageId, request.id, fromEmail, subject, null)
        processed++
        continue
      }

      // Unknown type fallback
      await reply(`Hi,\n\nI could not classify your request. Please specify: business partner, product, or order.\n\nThanks,\nLifeGroup DataGent`)
      markEmailProcessed(msg.messageId, null, fromEmail, subject, 'UNHANDLED_TYPE')
      processed++
    } catch (e: any) {
      const errMsg = e?.message ?? String(e)
      errors.push(`${msg.messageId}: ${errMsg}`)
      markEmailProcessed(msg.messageId, null, msg.fromAddress, msg.subject, errMsg)
    }
  }

  const lastSyncAt = new Date().toISOString()
  setSyncState('last_sync_at', lastSyncAt)
  setSyncState('last_sync_error', errors.join('; '))
  setSyncState('last_sync_processed', String(processed))
  if (agnesLog.length > 0) {
    const last = agnesLog[agnesLog.length - 1]
    setSyncState('last_agnes_input', last.input)
    setSyncState('last_agnes_output', last.output)
  }
  return {
    ok: errors.length === 0,
    agentName: resolved.name,
    processed,
    skipped,
    errors,
    lastSyncAt,
    agnesLog,
  }
}