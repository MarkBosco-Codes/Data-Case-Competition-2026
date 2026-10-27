import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { useServerFn } from '@tanstack/react-start'
import {
  syncInboxFn,
  getSyncStatus,
  listRequestsFn,
  getUsers,
  getReminderSettingsFn,
  setReminderDaysFn,
  pushRemindersNowFn,
} from '~/lib/server-functions'
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
  const getReminderSettings = useServerFn(getReminderSettingsFn)
  const setReminderDays = useServerFn(setReminderDaysFn)
  const pushRemindersNow = useServerFn(pushRemindersNowFn)

  const [tab, setTab] = useState<'requests' | 'sync' | 'reminders'>('requests')
  const [requests, setRequests] = useState<RequestRow[] | null>(null)
  const [userNames, setUserNames] = useState<Record<string, string>>({})
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [lastAgnes, setLastAgnes] = useState<{ input: string; output: string } | null>(null)

  const [reminderDays, setReminderDaysState] = useState<number>(3)
  const [lastReminderPushedAt, setLastReminderPushedAt] = useState<string | null>(null)
  const [pushingReminders, setPushingReminders] = useState(false)
  const [reminderResult, setReminderResult] = useState<any>(null)
  const [savingDays, setSavingDays] = useState(false)
  const [saveDaysMsg, setSaveDaysMsg] = useState<string | null>(null)

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

  useEffect(() => {
    if (tab !== 'reminders') return
    getReminderSettings()
      .then((res: any) => {
        if (res?.days) setReminderDaysState(res.days)
        if (res?.lastPushedAt) setLastReminderPushedAt(res.lastPushedAt)
      })
      .catch(() => {})
  }, [tab, getReminderSettings])

  const onSaveDays = async () => {
    setSavingDays(true)
    setSaveDaysMsg(null)
    try {
      const res = await setReminderDays({ data: { days: reminderDays } })
      if (res.ok) setSaveDaysMsg(`Saved reminder frequency: every ${res.days} day(s).`)
    } catch (e: any) {
      setSaveDaysMsg(`Failed to save: ${e?.message ?? String(e)}`)
    } finally {
      setSavingDays(false)
    }
  }

  const onPushReminders = async () => {
    setPushingReminders(true)
    setReminderResult(null)
    try {
      const res = await pushRemindersNow()
      setReminderResult(res)
      if (res.ok) setLastReminderPushedAt(new Date().toISOString())
      loadRequests()
    } catch (e: any) {
      setReminderResult({ ok: false, message: `Error pushing reminders: ${e?.message ?? String(e)}` })
    } finally {
      setPushingReminders(false)
    }
  }

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
            ['reminders', 'Reminders', undefined],
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

      {tab === 'reminders' && (
        <div style={card}>
          <h2 style={sectionTitle}>Approver reminders</h2>
          <p style={{ color: T.muted, fontSize: 14, marginTop: -6 }}>
            Configure reminder frequency and send email notifications to approvers with outstanding requests.
          </p>

          <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 480 }}>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: T.navy, marginBottom: 6 }}>
                Reminder frequency (days)
              </label>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ fontSize: 14, color: T.text }}>Send reminders to approvers every</span>
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={reminderDays}
                  onChange={(e) => setReminderDaysState(parseInt(e.target.value || '3', 10))}
                  style={{
                    width: 70,
                    padding: '8px 10px',
                    borderRadius: 6,
                    border: `1px solid ${T.border}`,
                    fontFamily: T.font,
                    fontSize: 14,
                  }}
                />
                <span style={{ fontSize: 14, color: T.text }}>day(s)</span>
                <button
                  type="button"
                  onClick={onSaveDays}
                  disabled={savingDays}
                  style={{
                    padding: '8px 16px',
                    borderRadius: 6,
                    border: 'none',
                    background: T.navy,
                    color: '#fff',
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: savingDays ? 'not-allowed' : 'pointer',
                    opacity: savingDays ? 0.7 : 1,
                  }}
                >
                  {savingDays ? 'Saving…' : 'Save'}
                </button>
              </div>
              {saveDaysMsg && (
                <div style={{ fontSize: 13, marginTop: 6, color: saveDaysMsg.startsWith('Saved') ? '#147a3d' : T.red }}>
                  {saveDaysMsg}
                </div>
              )}
            </div>

            <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: T.navy, marginBottom: 6 }}>
                Manual push
              </div>
              <p style={{ fontSize: 13, color: T.muted, marginTop: 0, marginBottom: 12 }}>
                Instantly email all approvers who have pending requests awaiting their decision.
              </p>
              <button
                type="button"
                onClick={onPushReminders}
                disabled={pushingReminders}
                style={primaryBtn({ disabled: pushingReminders })}
              >
                {pushingReminders ? 'Sending reminders…' : 'Push reminders now'}
              </button>
            </div>

            {lastReminderPushedAt && (
              <div style={{ fontSize: 12, color: T.muted }}>
                Last reminder push: {lastReminderPushedAt.slice(0, 16).replace('T', ' ')}
              </div>
            )}

            {reminderResult && (
              <div
                style={{
                  marginTop: 8,
                  padding: 12,
                  borderRadius: 8,
                  background: reminderResult.ok ? '#eaf6ec' : '#fdeded',
                  border: `1px solid ${reminderResult.ok ? '#bbf2c4' : '#f5c6c6'}`,
                  color: reminderResult.ok ? '#147a3d' : T.red,
                  fontSize: 13,
                  fontWeight: 500,
                }}
              >
                <div>{reminderResult.message}</div>
                {reminderResult.approversNotified?.length > 0 && (
                  <div style={{ marginTop: 6, fontSize: 12, color: T.text }}>
                    Approvers notified: <b>{reminderResult.approversNotified.join(', ')}</b>
                  </div>
                )}
              </div>
            )}
          </div>
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
