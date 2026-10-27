// Reset the DataGent database to a clean state:
// keeps user accounts (users) and approver permissions (requester_approvers),
// removes every request and its artifacts (approvals, audit, emails, bonus
// values, business partners, bank accounts, products, orders, magic links)
// plus ingestion state so old agent-inbox emails are not re-ingested.
import Database from 'better-sqlite3'
import path from 'node:path'
import process from 'node:process'

const DB_PATH = path.join(process.cwd(), '.datagent.db')
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

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
  'processed_emails',
]

const KEEP = [
  'users', // user accounts + roles (synced from users.yaml)
  'requester_approvers', // approver <-> requester permission links
  'bonus_fields', // configured bonus-field subclasses (master data, not requests)
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
console.log(`kept tables: ${kept.join(', ')}`)
console.log(`users retained: ${userCount}, approver links retained: ${linkCount}`)
console.log('Database reset to a clean state.')

db.close()
