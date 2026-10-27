import { useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { Spoiler, isSensitiveKey } from '~/components/Spoiler'
import {
  T,
  Kicker,
  badge,
  card,
  outlineBtn,
  pageStyle,
  primaryBtn,
  sectionTitle,
  statusColors,
  statusLabel,
  tableStyles,
  titleStyle,
} from '~/components/ui'
import {
  listApprovalsFn,
  listAuditFn,
  listEmailsFn,
  decideRequest,
  cancelRequest,
  syncUsers,
  getUsers,
} from '~/lib/server-functions'
import { getRequest, getRequestLink, type RequestRow, userRoles, listApiRequests } from '~/lib/db'

export interface MagicLoad {
  request: RequestRow
  approvers: string[]
  approvals: { approverEmail: string; decision: string; reason?: string | null; decidedAt: string }[]
  audit: { seq: number; actor: string; action: string; detail: string | null; createdAt: string }[]
  emails: { toEmail: string; subject: string; body: string; createdAt: string }[]
  userNames: Record<string, string>
  viewer: { email: string; canApprove: boolean } | null
  viewerRoles: string[]
  apiRequests: { content: string; createdAt: string }[]
}

export const loadBySecret = createServerFn({ method: 'GET' })
  .validator((d: { id: string; secret: string }) => d)
  .handler(async ({ data }): Promise<MagicLoad> => {
    await syncUsers()
    const empty: MagicLoad = {
      request: undefined as any,
      approvers: [],
      approvals: [],
      audit: [],
      emails: [],
      userNames: {},
      viewer: null,
      viewerRoles: [],
      apiRequests: [],
    }
    const link = getRequestLink(data.id, data.secret)
    if (!link) return empty
    const req = getRequest(data.id)
    if (!req || req.id !== link.requestId) return empty
    const users = await getUsers()
    const approvers = (users.users as any[])
      .filter((u) => u.roles.includes('approver'))
      .map((u) => u.email)
    const userNames: Record<string, string> = {}
    for (const u of users.users as any[]) {
      userNames[u.email] = u.name ?? u.email
    }
    const approvals = await listApprovalsFn({ data: { requestId: req.id } })
    const audit = await listAuditFn({ data: { requestId: req.id } })
    const emails = await listEmailsFn({ data: { requestId: req.id } })
    const apiRequests = listApiRequests(req.id)
    return {
      request: req,
      approvers: (req.payload?.approvers as string[]) ?? approvers,
      approvals,
      audit,
      emails,
      userNames,
      viewer: { email: link.email, canApprove: link.canApprove },
      viewerRoles: userRoles(link.email),
      apiRequests,
    }
  })

interface Props {
  initial: MagicLoad
  requestId: string
  secret: string
}

export function RequestPage({ initial, requestId, secret }: Props) {
  const decide = useServerFn(decideRequest)
  const cancel = useServerFn(cancelRequest)
  const router = useRouter()
  const userNames = initial.userNames
  const [approverList, setApproverList] = useState<string[]>(initial.approvers)
  const viewer = initial.viewer
  const viewerRoles = initial.viewerRoles ?? []
  const [request, setRequest] = useState<RequestRow>(initial.request)
  const [approvals, setApprovals] = useState(initial.approvals)
  const [audit, setAudit] = useState(initial.audit)
  const [emails, setEmails] = useState(initial.emails)
  const [apiRequests, setApiRequests] = useState(initial.apiRequests ?? [])
  const [msg, setMsg] = useState<string | null>(null)
  const [lastWire, setLastWire] = useState<string | null>(null)
  const [confirmAction, setConfirmAction] = useState<'approve' | 'reject' | 'cancel' | null>(null)
  const [rejectReason, setRejectReason] = useState('')

  const onDecide = async (decision: 'APPROVE' | 'REJECT', note?: string) => {
    const res = await decide({ data: { requestId, secret, decision, note } })
    if (res.ok) {
      setLastWire(res.wire)
      setMsg(
        decision === 'APPROVE'
          ? `Approved by ${viewer?.email} — record created in MDM (mock SAP B1 write).`
          : `Rejected by ${viewer?.email}.`,
      )
      const fresh = (await loadBySecret({ data: { id: requestId, secret } })) as MagicLoad
      setRequest(fresh.request)
      setApprovals(fresh.approvals)
      setApproverList(fresh.approvers ?? approverList)
      setAudit(fresh.audit)
      setEmails(fresh.emails)
      setApiRequests(fresh.apiRequests ?? [])
      router.invalidate({ sync: true })
    } else {
      setMsg(res.error)
    }
  }

  const onCancel = async () => {
    const res = await cancel({ data: { requestId, secret } })
    if (res.ok) {
      setMsg('Request cancelled.')
      const fresh = (await loadBySecret({ data: { id: requestId, secret } })) as MagicLoad
      setRequest(fresh.request)
      setApprovals(fresh.approvals)
      setApproverList(fresh.approvers ?? approverList)
      setAudit(fresh.audit)
      setEmails(fresh.emails)
      setApiRequests(fresh.apiRequests ?? [])
      router.invalidate({ sync: true })
    } else {
      setMsg(res.error)
    }
  }

  const runConfirmed = async () => {
    const action = confirmAction
    setConfirmAction(null)
    setRejectReason('')
    if (action === 'approve') await onDecide('APPROVE')
    else if (action === 'reject') await onDecide('REJECT', rejectReason.trim())
    else if (action === 'cancel') await onCancel()
  }

  const canDecide = request.status === 'PENDING_APPROVAL' && !!viewer?.canApprove
  const isRequester = !!viewer && viewer.email === request.requesterEmail

  const requesterName = userNames[request.requesterEmail] ?? request.requesterEmail
  const approvedRows = approvals.filter((a) => a.decision === 'APPROVED')
  const rejectedRows = approvals.filter((a) => a.decision === 'REJECTED')
  const decisionLine =
    approvedRows.length > 0
      ? `Approved by ${approvedRows.map((a) => userNames[a.approverEmail] ?? a.approverEmail).join(', ')} on ${approvedRows[approvedRows.length - 1].decidedAt.slice(0, 16).replace('T', ' ')}`
      : rejectedRows.length > 0
        ? `Rejected by ${rejectedRows.map((a) => userNames[a.approverEmail] ?? a.approverEmail).join(', ')} on ${rejectedRows[rejectedRows.length - 1].decidedAt.slice(0, 16).replace('T', ' ')}`
        : 'Pending approval — no decision recorded yet'

  const statusLabel2 = statusLabel[request.status] ?? request.status
  const displayApprovals = approverList.map((email) => {
    const found = approvals.find((a) => a.approverEmail === email)
    return found ?? { approverEmail: email, decision: 'PENDING', reason: null, decidedAt: '' }
  })

  return (
    <main style={pageStyle}>
      <Kicker>{canDecide ? 'Approval needed' : 'Track request'}</Kicker>
      <h1
        style={{
          ...titleStyle,
          marginTop: 16,
          color: canDecide ? T.red : T.navyDark,
        }}
      >
        {canDecide ? 'Approve request?' : statusLabel2}
      </h1>
      <p style={{ color: T.muted }}>
        {' '}
        {viewer
          ? `Signed in as ${userNames[viewer.email] ?? viewer.email} (${viewer.email})${viewer.canApprove ? ' - Request approver' : ' - Request creator'}.`
          : 'Access and approval depend on assigned permissions, but the request and its audit trail stay visible to both requestor and approver.'}
      </p>

      <div style={{ ...card, borderRadius: 20 }}>
        {canDecide && (
          <div style={callout}>
            <b>Action required</b> — review the request below and approve or reject.
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <b style={{ fontSize: 16 }}>{request.type.replace(/_/g, ' ')}</b>
          {request.bpClass && <span style={badge(T.navy)}>{request.bpClass === 'CUSTOMER' ? 'Customer' : 'Supplier'}</span>}
          <span style={badge(statusColors[request.status] ?? T.navy)}>{statusLabel2}</span>
          {request.needsItConfig && (
            <span style={badge('#b26a00')}>new datafields — IT configuration needed</span>
          )}
        </div>

        <div style={{ fontSize: 13, color: T.muted, marginTop: 10 }}>
          Requested by <b>{requesterName}</b> ({request.requesterEmail}) ·{' '}
          {request.createdAt.slice(0, 16).replace('T', ' ')}
        </div>
        <div style={{ fontSize: 13, color: T.muted }}>
          Approvers: {approverList.map((a) => userNames[a] ?? a).join(', ') || 'none assigned'} · {decisionLine}
        </div>
        {request.requestReason && (
          <div style={reasonBox}>
            <b>Request reason:</b> {request.requestReason}
          </div>
        )}
        {request.decisionNote && (
          <div style={reasonBox}>
            <b>{request.status === 'REJECTED' ? 'Rejection reason:' : 'Decision note:'}</b> {request.decisionNote}
          </div>
        )}
        {request.bonusText && (
          <div style={{ fontSize: 14, marginTop: 8 }}>Free-text: “{request.bonusText}”</div>
        )}

        <h3 style={{ ...sectionTitle, marginTop: 20 }}>Details</h3>
        <table style={tableStyles.table} cellPadding={6}>
          <tbody>
            {Object.entries(request.payload)
              .filter(([k]) => k !== 'countryOfOrigin')
              .map(([k, v]) => {
                const val =
                  k === 'country' && request.payload?.countryOfOrigin
                    ? `${v} (origin: ${request.payload.countryOfOrigin})`
                    : v
                return (
                  <tr key={k} style={tableStyles.rowBordered}>
                    <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{k}</td>
                    <td style={{ wordBreak: 'break-all' }}>
                      {isSensitiveKey(k) ? <Spoiler>{String(val)}</Spoiler> : String(val)}
                    </td>
                  </tr>
                )
              })}
          </tbody>
        </table>

        {canDecide && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 18, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: T.muted }}>
              Approving as <b>{userNames[viewer!.email] ?? viewer?.email}</b>
            </span>
            <button
              type="button"
              onClick={() => setConfirmAction('approve')}
              style={{ ...primaryBtn(), background: '#147a3d' }}
            >
              Approve → create record
            </button>
            <button
              type="button"
              onClick={() => setConfirmAction('reject')}
              style={{ ...primaryBtn(), background: T.red }}
            >
              Reject
            </button>
          </div>
        )}

        {isRequester && request.status === 'PENDING_APPROVAL' && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 18, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => setConfirmAction('cancel')}
              style={outlineBtn({ danger: true })}
            >
              Cancel request
            </button>
          </div>
        )}
      </div>

      {/* Audit trail tag — visible to requestors and approvers alike */}
      <div style={{ ...card, borderRadius: 20, marginTop: 20 }}>
        <Kicker>Audit trail</Kicker>
        <div style={{ marginTop: 14, fontSize: 14 }}>
          <div>
            <b>Created by</b> {requesterName} ({request.requesterEmail}) on{' '}
            {request.createdAt.slice(0, 16).replace('T', ' ')}
          </div>
          <div>
            <b>Decision:</b> {decisionLine}
          </div>
        </div>

        {displayApprovals.length > 0 && (
          <>
            <h3 style={{ ...sectionTitle, marginTop: 18 }}>Approvals</h3>
            <table style={tableStyles.table} cellPadding={6}>
              <thead style={tableStyles.thead}>
                <tr>
                  <th>Approver</th>
                  <th>Decision</th>
                  <th>Reason</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {displayApprovals.map((a) => (
                  <tr key={`${a.approverEmail}|${a.decidedAt}`} style={tableStyles.rowBordered}>
                     <td>{userNames[a.approverEmail] ?? a.approverEmail}</td>
                     <td>{a.decision}</td>
                     <td style={{ fontSize: 12 }}>{a.reason ?? '—'}</td>
                     <td style={{ fontSize: 12, color: T.muted }}>{a.decidedAt ? a.decidedAt.slice(0, 16).replace('T', ' ') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {audit.length > 0 && (
          <>
            <h3 style={{ ...sectionTitle, marginTop: 18 }}>Events</h3>
            <table style={{ ...tableStyles.table, fontSize: 13 }} cellPadding={6}>
              <thead style={tableStyles.thead}>
                <tr>
                  <th>#</th>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((e) => (
                  <tr key={e.seq} style={tableStyles.rowBordered}>
                    <td>{e.seq}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{e.createdAt.slice(0, 16).replace('T', ' ')}</td>
                    <td>{userNames[e.actor] ?? e.actor}</td>
                    <td>{e.action}</td>
                    <td>{e.detail ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {emails.length > 0 && (
          <>
            <h3 style={{ ...sectionTitle, marginTop: 18 }}>Email updates to requester</h3>
            <ul style={{ fontSize: 13, color: T.muted }}>
              {emails.map((e, i) => (
                <li key={i}>
                  <b>{e.subject}</b> → {e.toEmail} ({e.createdAt.slice(0, 16).replace('T', ' ')})
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {viewerRoles.includes('it') && (
        <div style={{ ...card, borderRadius: 20, marginTop: 20 }}>
          <Kicker>API requests</Kicker>
          <div style={{ marginTop: 14, fontSize: 13, color: T.muted }}>
            SAP B1 MDM template requests for this request.
          </div>
          {apiRequests.length === 0 ? (
            <p style={{ fontSize: 13, color: T.muted, marginTop: 10 }}>No API requests recorded yet.</p>
          ) : (
            <ul style={{ marginTop: 10 }}>
              {apiRequests.map((a, i) => (
                <li key={i} style={{ marginBottom: 8 }}>
                  <pre style={wireBox}>{a.content}</pre>
                  <div style={{ fontSize: 11, color: T.muted }}>{a.createdAt}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {lastWire && <pre style={wireBox}>{lastWire}</pre>}
      {confirmAction && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
          }}
        >
          <div style={{ ...card, maxWidth: 420, width: '90%' }}>
            <h3 style={sectionTitle}>
              {confirmAction === 'approve'
                ? 'Approve this request?'
                : confirmAction === 'reject'
                  ? 'Reject this request?'
                  : 'Cancel this request?'}
            </h3>
            <p style={{ fontSize: 14, color: T.muted, marginTop: 8 }}>
              {confirmAction === 'approve'
                ? 'This will create the record in MDM (mock SAP B1 write).'
                : confirmAction === 'reject'
                  ? 'The requester will be notified of the rejection.'
                  : 'This will cancel the request. It cannot be undone.'}
            </p>
            {confirmAction === 'reject' && (
              <div style={{ marginTop: 12 }}>
                <label style={{ fontSize: 13, fontWeight: 600, color: T.text }}>
                  Rejection reason (required)
                </label>
                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  rows={3}
                  style={{
                    width: '100%',
                    marginTop: 6,
                    padding: '8px 10px',
                    borderRadius: 10,
                    border: `1px solid ${T.border}`,
                    fontFamily: 'inherit',
                    fontSize: 14,
                    resize: 'vertical',
                  }}
                  placeholder="Explain why this request is being rejected…"
                />
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
              <button type="button" onClick={() => setConfirmAction(null)} style={outlineBtn()}>
                No, go back
              </button>
              <button
                type="button"
                onClick={runConfirmed}
                disabled={confirmAction === 'reject' && rejectReason.trim() === ''}
                style={{
                  ...primaryBtn(),
                  background:
                    confirmAction === 'approve' ? '#147a3d' : T.red,
                  opacity: confirmAction === 'reject' && rejectReason.trim() === '' ? 0.5 : 1,
                  cursor: confirmAction === 'reject' && rejectReason.trim() === '' ? 'not-allowed' : 'pointer',
                }}
              >
                Yes, confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

const callout = {
  background: `color-mix(in srgb, ${T.red} 8%, #fff)`,
  border: `1px solid color-mix(in srgb, ${T.red} 25%, #fff)`,
  color: T.red,
  padding: '12px 16px',
  borderRadius: 12,
  marginBottom: 16,
  fontSize: 14,
} as const

const reasonBox = {
  marginTop: 12,
  background: '#f8fafa',
  border: `1px solid ${T.border}`,
  borderRadius: 12,
  padding: '10px 14px',
  fontSize: 14,
} as const

const wireBox = {
  background: T.gray,
  border: `1px solid ${T.border}`,
  padding: 12,
  borderRadius: 10,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  fontSize: 12,
  marginTop: 16,
  color: T.text,
} as const
