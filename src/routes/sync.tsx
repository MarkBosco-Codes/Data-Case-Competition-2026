import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useCallback } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { syncInboxFn, getSyncStatus, testZoho } from '~/lib/server-functions'
import { T, Kicker, card as cardBox, pageStyle, primaryBtn, sectionTitle, titleStyle } from '~/components/ui'

export const Route = createFileRoute('/sync')({
  component: SyncPage,
})

function SyncPage() {
  const sync = useServerFn(syncInboxFn)
  const status = useServerFn(getSyncStatus)
  const test = useServerFn(testZoho)

  const [result, setResult] = useState<any>(null)
  const [st, setSt] = useState<any>(null)
  const [testing, setTesting] = useState<any>(null)
  const [running, setRunning] = useState(false)
  const [auto, setAuto] = useState(true)

  const runSync = useCallback(async () => {
    setRunning(true)
    try {
      const r = await sync()
      setResult(r)
    } catch (e: any) {
      setResult({ ok: false, errors: [e?.message ?? String(e)] })
    } finally {
      setRunning(false)
    }
    try {
      setSt(await status())
    } catch {}
  }, [sync, status])

  const runTest = useCallback(async () => {
    setTesting(await test())
  }, [test])

  useEffect(() => {
    runTest()
    runSync()
  }, [runTest, runSync])

  useEffect(() => {
    if (!auto) return
    const id = setInterval(runSync, 5000)
    return () => clearInterval(id)
  }, [auto, runSync])

  return (
    <main style={pageStyle}>
      <Kicker>Lifegroup MDM</Kicker>
      <h1 style={{ ...titleStyle, marginTop: 16 }}>Inbox sync</h1>
      <p style={{ color: T.muted, maxWidth: 560 }}>
        Polls Zoho AgentInbox every 5 seconds and ingests incoming emails into
        MDM requests. Magic links are emailed back to the sender. A reason is
        mandatory for every request.
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={runSync} disabled={running} style={primaryBtn({ disabled: running })}>
          {running ? 'Syncing…' : 'Sync now'}
        </button>
        <button onClick={runTest} style={ghostBtn}>
          Test Zoho connection
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14 }}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          Auto-sync every 5s
        </label>
      </div>

      {testing && (
        <section style={cardBox}>
          <h3 style={sectionTitle}>Zoho connection</h3>
          <pre style={pre}>{JSON.stringify(testing, null, 2)}</pre>
        </section>
      )}

      {st && (
        <section style={{ ...cardBox, marginTop: 16 }}>
          <h3 style={sectionTitle}>Last sync status</h3>
          <pre style={pre}>{JSON.stringify(st, null, 2)}</pre>
        </section>
      )}

      {result && (
        <section style={{ ...cardBox, marginTop: 16 }}>
          <h3 style={sectionTitle}>Latest sync result</h3>
          <pre style={pre}>{JSON.stringify(result, null, 2)}</pre>
        </section>
      )}

      <p style={{ marginTop: 24, fontSize: 12, color: T.muted }}>
        If Zoho reports "Invalid Agent Id", update <code>zoho-agent-name</code> in
        <code>.env</code> to the mailbox slug (the name shown in Zoho AgentInbox),
        then restart the dev server.
      </p>
    </main>
  )
}

const ghostBtn = {
  padding: '10px 18px',
  borderRadius: 999,
  border: `1px solid ${T.navyDark}`,
  background: '#fff',
  color: T.navyDark,
  fontWeight: 600,
  fontSize: 14,
  fontFamily: T.font,
  cursor: 'pointer',
}

const pre = {
  background: T.gray,
  color: T.text,
  border: `1px solid ${T.border}`,
  borderRadius: 10,
  padding: 12,
  overflow: 'auto',
  fontSize: 12,
  maxHeight: 300,
} as const
