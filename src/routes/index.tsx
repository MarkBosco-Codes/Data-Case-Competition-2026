import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { syncInboxFn, getSyncStatus, listRequestsFn, getUsers } from '~/lib/server-functions'
import {
  T,
  Kicker,
  card,
  pageStyle,
  primaryBtn,
  sectionTitle,
  statusColors,
  statusLabel,
  badge,
  tableStyles,
  titleStyle,
} from '~/components/ui'

export const Route = createFileRoute('/')({
  component: HomePage,
})

type RequestRow = {
  id: string
  viewSecret: string
  type: string
  bpClass: string | null
  requesterEmail: string
  status: string
  requestReason: string | null
  approvalType: 'QUALITY' | 'REGULATORY'
  qualityApproved: 'N/A' | 'PENDING' | 'APPROVED' | 'REJECTED'
  regulatoryApproved: 'N/A' | 'PENDING' | 'APPROVED' | 'REJECTED'
  createdAt: string
}

function HomePage() {
  const sync = useServerFn(syncInboxFn)
  const status = useServerFn(getSyncStatus)

  const [tab, setTab] = useState<'requests' | 'sync'>('requests')
  const [requests, setRequests] = useState<RequestRow[] | null>(null)
  const [userNames, setUserNames] = useState<Record<string, string>>({})
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [lastAgnes, setLastAgnes] = useState<{ input: string; output: string } | null>(null)

  useEffect(() => {
    loadRequests()
  }, [])

  const loadRequests = () => {
    Promise.all([
      listRequestsFn() as unknown as Promise<RequestRow[]>,
      getUsers() as unknown as Promise<{ users: { email: string; name: string | null }[] }>,
    ])
      .then(([reqs, users]) => {
        setRequests(reqs as RequestRow[])
        const names: Record<string, string> = {}
        for (const u of users.users) names[u.email] = u.name ?? u.email
        setUserNames(names)
      })
      .catch(() => setRequests([]))
  }

  useEffect(() => {
    if (tab !== 'sync') return
    status()
      .then((s: any) => {
        if (s?.lastAgnesInput || s?.lastAgnesOutput) {
          setLastAgnes({ input: s.lastAgnesInput ?? '', output: s.lastAgnesOutput ?? '' })
        }
      })
      .catch(() => {})
  }, [tab, status])

  const onSync = async () => {
    setRunning(true)
    try {
      const r = await sync()
      setResult(r)
      const l = r?.agnesLog?.length ? r.agnesLog[r.agnesLog.length - 1] : null
      if (l) setLastAgnes(l)
      else {
        const s: any = await status()
        if (s?.lastAgnesInput || s?.lastAgnesOutput) {
          setLastAgnes({ input: s.lastAgnesInput ?? '', output: s.lastAgnesOutput ?? '' })
        }
      }
      loadRequests()
    } catch (e: any) {
      setResult({ ok: false, errors: [e?.message ?? String(e)] })
    } finally {
      setRunning(false)
    }
  }

  const last = lastAgnes
  const pendingCount = (requests ?? []).filter((r) => r.status === 'PENDING_APPROVAL').length

  return (
    <main style={pageStyle}>
      <Kicker>Lifegroup MDM</Kicker>
      <h1 style={{ ...titleStyle, marginTop: 16 }}>Data requests</h1>
      <p style={{ color: T.muted, maxWidth: 560 }}>
        Track master-data requests, approvals and inbox ingestion in one place.
        Open a request to see all fields, the audit trail and the approval
        actions — no login required.
      </p>

      <div style={{ display: 'flex', gap: 32, borderBottom: `1px solid ${T.border}`, marginBottom: 20 }}>
        {(
          [
            ['requests', 'Requests', pendingCount],
            ['sync', 'Inbox sync', undefined],
          ] as const
        ).map(([key, label, count]) => {
          const active = tab === key
          return (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              style={{
                background: 'none',
                border: 'none',
                fontFamily: T.font,
                fontSize: 14,
                fontWeight: 600,
                color: active ? T.navyDark : T.muted,
                padding: '10px 2px 12px',
                cursor: 'pointer',
                position: 'relative',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              {label}
              {count ? ` · ${count} pending` : ''}
              <span
                style={{
                  position: 'absolute',
                  left: 0,
                  bottom: 0,
                  width: '100%',
                  height: 3,
                  background: T.gradient,
                  transform: active ? 'scaleX(1)' : 'scaleX(0)',
                  transformOrigin: 'left',
                  transition: 'transform 0.3s ease',
                }}
              />
            </button>
          )
        })}
      </div>

      {tab === 'requests' && (
        <div style={card}>
          <h2 style={sectionTitle}>All requests</h2>
          {requests === null ? (
            <p style={{ color: T.muted, fontSize: 14 }}>Loading requests…</p>
          ) : requests.length === 0 ? (
            <p style={{ color: T.muted, fontSize: 14 }}>
              No requests yet. Send an email to the DataGent mailbox — a reason is mandatory for
              every request and will show up here.
            </p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={tableStyles.table}>
                <thead style={tableStyles.thead}>
                  <tr>
                    <th style={{ padding: '8px 10px 10px 0' }}>Type</th>
                    <th style={{ padding: '8px 10px 10px 0' }}>Requestor</th>
                    <th style={{ padding: '8px 10px 10px 0' }}>Reason</th>
                    <th style={{ padding: '8px 10px 10px 0' }}>Created</th>
                    <th style={{ padding: '8px 10px 10px 0' }}>Status</th>
                    <th style={{ padding: '8px 10px 10px 0' }}>Request</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id} style={tableStyles.rowBordered}>
                      <td style={{ padding: '12px 10px 12px 0', whiteSpace: 'nowrap' }}>
                        <b>{r.type.replace(/_/g, ' ')}</b>
                        {' '}
                        <span style={badge(T.navy)}>Quality: N/A</span>
                        {' '}
                        <span style={badge(r.regulatoryApproved === 'APPROVED' ? '#147a3d' : r.regulatoryApproved === 'REJECTED' ? T.red : r.regulatoryApproved === 'PENDING' ? '#b26a00' : T.navy)}>
                          Regulatory: {r.regulatoryApproved ?? 'N/A'}
                        </span>
                        {r.bpClass && (
                          <span style={{ color: T.muted, fontSize: 12 }}>
                            {' '}
                            · {r.bpClass === 'CUSTOMER' ? 'Customer' : 'Supplier'}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '12px 10px 12px 0', ...tableStyles.small }}>
                        {userNames[r.requesterEmail] ?? r.requesterEmail}
                      </td>
                      <td style={{ padding: '12px 10px 12px 0', color: T.muted, maxWidth: 260, ...tableStyles.small }}>
                        {r.requestReason ?? '—'}
                      </td>
                      <td style={{ padding: '12px 10px 12px 0', whiteSpace: 'nowrap', ...tableStyles.small }}>
                        {r.createdAt.slice(0, 16).replace('T', ' ')}
                      </td>
                      <td style={{ padding: '12px 10px 12px 0' }}>
                        <span style={badge(statusColors[r.status] ?? T.navy)}>
                          {statusLabel[r.status] ?? r.status}
                        </span>
                      </td>
                      <td style={{ padding: '12px 10px 12px 0' }}>
                        {r.viewSecret ? (
                          <a href={`/r/${r.id}/${r.viewSecret}`} style={linkStyle2}>
                            View →
                          </a>
                        ) : (
                          <span style={{ fontSize: 12, color: T.muted }}>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'sync' && (
        <div style={card}>
          <h2 style={sectionTitle}>Inbox sync</h2>
          <p style={{ color: T.muted, fontSize: 14, marginTop: -6 }}>
            Pull new emails from Zoho AgentInbox, classify them with Agnes, and
            create MDM requests (a reason is mandatory). Also runs
            automatically every 5 seconds on the server.
          </p>
          <button onClick={onSync} disabled={running} style={primaryBtn({ disabled: running })}>
            {running ? 'Syncing…' : 'Sync now'}
          </button>

          {result && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 13, color: result.ok ? '#147a3d' : T.red, fontWeight: 600 }}>
                {result.ok ? 'Sync OK' : 'Sync finished with errors'} — processed {result.processed}, skipped{' '}
                {result.skipped}
              </div>
              {result.errors?.length > 0 && (
                <pre style={{ ...pre, color: T.red }}>{result.errors.join('\n')}</pre>
              )}
              {last && (
                <div style={{ marginTop: 12 }}>
                  <h3 style={{ fontSize: 14, marginBottom: 4, color: T.navy }}>Agnes input</h3>
                  <pre style={pre}>{last.input}</pre>
                  <h3 style={{ fontSize: 14, marginBottom: 4, marginTop: 12, color: T.navy }}>Agnes output</h3>
                  <pre style={pre}>{last.output}</pre>
                </div>
              )}
              {result.agnesLog?.length > 1 && (
                <div style={{ fontSize: 12, color: T.muted, marginTop: 8 }}>
                  ({result.agnesLog.length} Agnes calls this sync)
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </main>
  )
}

const linkStyle2 = {
  fontWeight: 700,
  fontSize: 13,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  background: T.gradient,
  WebkitBackgroundClip: 'text',
  backgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  textDecoration: 'none',
} as const

const pre = {
  background: T.gray,
  color: T.text,
  border: `1px solid ${T.border}`,
  padding: 12,
  borderRadius: 10,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  fontSize: 12,
  maxHeight: 240,
  overflow: 'auto',
} as const
