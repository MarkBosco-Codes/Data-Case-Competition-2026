// Reset the DataGent database to a clean state:
// keeps user accounts (users), approver permissions (requester_approvers),
// master data (bonus_fields), and processed emails log (processed_emails).
// removes every request and its artifacts (approvals, audit, emails, bonus
// values, business partners, bank accounts, products, orders, magic links, api_requests).
import Database from 'better-sqlite3'
import path from 'node:path'
import process from 'node:process'

const DB_PATH = path.join(process.cwd(), '.datagent.db')
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

const isRemote = process.argv.includes('--remote')

const WIPE = [
  'request_approvals',
  'audit_events',
  'emails',
  'requests',
  'request_bonus_values',
  'business_partners',
  'bank_accounts',
  'products',
  'orders',
  'request_links',
  'api_requests',
  ...(isRemote ? ['processed_emails'] : []),
]

if (isRemote) {
  console.log('Clearing remote Zoho inbox...')
  try {
    const key = process.env['zoho-inbox-key'] ?? process.env['ZOHO_INBOX_KEY']
    const agent = (process.env['zoho-mailbox-name'] ?? process.env['ZOHO_MAILBOX_NAME'] ?? 'datagent-mailbox').trim()
    const BASE = 'https://api.zohoagentinbox.com/api/v0.9'
    let count = 0
    if (key) {
      while (true) {
        const res = await fetch(`${BASE}/agents/${agent}/messages?limit=100`, {
          headers: { Authorization: key },
        })
        const json = await res.json()
        const msgs = Array.isArray(json.data) ? json.data : []
        if (msgs.length === 0) break
        for (const m of msgs) {
          const id = m.messageId || m.id
          if (!id) continue
          const del = await fetch(`${BASE}/agents/${agent}/messages/${id}`, {
            method: 'DELETE',
            headers: { Authorization: key },
          })
          if (del.ok) count++
        }
      }
      console.log(`purged ${count} remote email(s) from Zoho AgentInbox`)
    } else {
      console.log('zoho-inbox-key not found in environment, skipped Zoho remote purge')
    }
  } catch (err) {
    console.error('Remote purge error:', err)
  }
}

const KEEP = [
  'users', // user accounts + roles (synced from users.yaml)
  'requester_approvers', // approver <-> requester permission links
  'bonus_fields', // configured bonus-field subclasses (master data, not requests)
  'processed_emails', // log of emails processed (retained)
  'sync_state', // cleared of request-specific keys below
]

const tx = db.transaction(() => {
  for (const table of WIPE) {
    try {
      const info = db.prepare(`DELETE FROM ${table}`).run()
      console.log(`cleared ${table}: ${info.changes} row(s)`)
    } catch {
      // table may not exist yet on a fresh DB
      console.log(`skipped ${table} (missing)`)
    }
  }
  try {
    db.prepare(
      "DELETE FROM sync_state WHERE key LIKE 'last_%'",
    ).run()
    console.log('cleared sync_state last_* keys')
  } catch {
    console.log('skipped sync_state (missing)')
  }
})

tx()

const kept = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  .all()
  .map((r) => r.name)
const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n
const linkCount = db.prepare('SELECT COUNT(*) AS n FROM requester_approvers').get().n
const emailCount = db.prepare('SELECT COUNT(*) AS n FROM processed_emails').get().n
console.log(`kept tables: ${kept.join(', ')}`)
console.log(`users retained: ${userCount}, approver links retained: ${linkCount}, processed emails retained: ${emailCount}`)
console.log('Database reset to a clean state.')

db.close()
