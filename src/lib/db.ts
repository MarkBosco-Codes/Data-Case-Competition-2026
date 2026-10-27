import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { parse as parseYaml } from 'yaml'

const DB_PATH = path.join(process.cwd(), '.datagent.db')

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

// ---- Sprint 1: Agentic MDM request tracking, database schemas ---------------

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  roles TEXT NOT NULL,             -- JSON array: requester | approver | commercial
  name TEXT,
  title TEXT,
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS request_approvals (
  requestId TEXT NOT NULL,
  approverEmail TEXT NOT NULL,
  decision TEXT NOT NULL,          -- APPROVED | REJECTED
  reason TEXT,                     -- approver's reason (required on reject)
  decidedAt TEXT NOT NULL,
  PRIMARY KEY (requestId, approverEmail)
);
CREATE TABLE IF NOT EXISTS audit_events (
  requestId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (requestId, seq)
);
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  requestId TEXT NOT NULL,
  toEmail TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requester_approvers (
  requesterUserId TEXT NOT NULL,
  approverUserId TEXT NOT NULL,
  PRIMARY KEY (requesterUserId, approverUserId)
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  threadId TEXT,                   -- 1 email thread = 1 conversation context = 1 request
  type TEXT NOT NULL,              -- BUSINESS_PARTNER | PRODUCT | ORDER
  bpClass TEXT,                    -- for BUSINESS_PARTNER: CUSTOMER (cash inflow) | VENDOR (cash outflow)
  requesterEmail TEXT NOT NULL,
  status TEXT NOT NULL,            -- NEW | PENDING_APPROVAL | APPROVED | REJECTED | CREATED_IN_MDM
  payload TEXT NOT NULL,           -- JSON request payload (schema-validated for BP)
  requestReason TEXT,            -- mandatory justification for the request
  needsItConfig INTEGER NOT NULL DEFAULT 0, -- new datafields not covered by bonus fields
  bonusText TEXT,                  -- requester free-text used by agent to match/add bonus fields
  decidedBy TEXT,
  decisionNote TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
-- Bonus fields: nullable extension attributes per main data type; agent picks the
-- best match for requester free-text or creates a new subclass.
CREATE TABLE IF NOT EXISTS bonus_fields (
  id TEXT PRIMARY KEY,
  parentType TEXT NOT NULL,        -- businessPartner | product | order
  name TEXT NOT NULL,
  nullable INTEGER NOT NULL DEFAULT 1,
  UNIQUE (parentType, name)
);
CREATE TABLE IF NOT EXISTS request_bonus_values (
  requestId TEXT NOT NULL,
  fieldId TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (requestId, fieldId)
);
CREATE TABLE IF NOT EXISTS business_partners (
  id TEXT PRIMARY KEY,
  requestId TEXT,
  processStatus TEXT NOT NULL,     -- PENDING | VALIDATED | PUSHED_TO_SAP | REJECTED
  customData TEXT NOT NULL DEFAULT '{}',
  name TEXT NOT NULL,
  creditTerms TEXT NOT NULL,
  bankAccountNumber TEXT NOT NULL,
  contactName TEXT NOT NULL,
  contactEmail TEXT NOT NULL,
  contactPhone TEXT NOT NULL,
  partnerClass TEXT NOT NULL,      -- CUSTOMER (inflow) | VENDOR (outflow)
  country TEXT NOT NULL,
  countryOfOrigin TEXT,
  countrySynced INTEGER NOT NULL DEFAULT 0,
  addresses TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY,
  bpId TEXT NOT NULL,
  iban TEXT NOT NULL,
  beneficiaryName TEXT NOT NULL,
  ibanValid INTEGER NOT NULL,
  beneficiaryMatch INTEGER NOT NULL,
  taxFormatValid INTEGER NOT NULL,
  approval1By TEXT,
  approval2By TEXT,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,       -- A | B | C (extensible)
  name TEXT NOT NULL,
  tracksCogs INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  orderNumber TEXT NOT NULL,
  productCode TEXT NOT NULL,
  partnerId TEXT NOT NULL,         -- customer (cash inflow) or vendor (cash outflow)
  qty INTEGER NOT NULL,
  paymentDate TEXT,
  deliveryDate TEXT,
  createdAt TEXT NOT NULL
);
`)

// Migration: magic-link tokens (no-logins access by unique request URL) —
// added column for DBs created before this feature.
try {
  db.exec('ALTER TABLE requests ADD COLUMN token TEXT')
} catch {
  /* column already exists */
}
// Migration: remove redundant `direction` column from orders (derived from partner class).
try {
  db.exec('ALTER TABLE orders DROP COLUMN direction')
} catch {
  /* column already absent or unsupported */
}
// Migration: approver reason on request_approvals (required on reject)
try {
  db.exec('ALTER TABLE request_approvals ADD COLUMN reason TEXT')
} catch {
  /* column already exists */
}
// Migration: rename mandatory request reason column (reason -> requestReason)
try {
  db.exec('ALTER TABLE requests RENAME COLUMN reason TO requestReason')
} catch {
  /* column already renamed or absent */
}
// Migration: mandatory request reason
try {
  db.exec('ALTER TABLE requests ADD COLUMN requestReason TEXT')
} catch {
  /* column already exists */
}
// Migration: user directory name/title from users.yaml
try {
  db.exec('ALTER TABLE users ADD COLUMN name TEXT')
} catch {
  /* column already exists */
}
try {
  db.exec('ALTER TABLE users ADD COLUMN title TEXT')
} catch {
  /* column already exists */
}
{
  const upd = db.prepare('UPDATE requests SET token = ? WHERE id = ?')
  for (const r of db
    .prepare('SELECT id FROM requests WHERE token IS NULL')
    .all() as any[]) {
    upd.run(crypto.randomUUID(), r.id)
  }
}

// ---- Seed -------------------------------------------------------------------

export function syncUsersFromConfig(): { synced: number; assignments: number } {
  const file = path.join(process.cwd(), 'users.yaml')
  let doc: any = null
  try {
    doc = parseYaml(fs.readFileSync(file, 'utf8'))
  } catch {
    return { synced: 0, assignments: 0 }
  }
  let synced = 0
  const now = new Date().toISOString()
  for (const u of doc?.users ?? []) {
    if (!u?.email) continue
    const roles = Array.isArray(u.roles) ? u.roles.map(String) : ['requester']
    upsertUserFull(String(u.email), roles, u.name ? String(u.name) : undefined, u.title ? String(u.title) : undefined, now)
    synced++
  }
  let assignments = 0
  for (const a of doc?.assignments ?? []) {
    if (!a?.requester || !a?.approver) continue
    if (setLinks(String(a.requester), String(a.approver))) assignments++
  }
  return { synced, assignments }
}

function upsertUserFull(
  email: string,
  roles: string[],
  name: string | undefined,
  title: string | undefined,
  now: string,
): UserRow {
  const norm = email.trim().toLowerCase()
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(norm) as
    | any
    | undefined
  if (existing) {
    db.prepare('UPDATE users SET roles = ?, name = ?, title = ? WHERE id = ?').run(
      JSON.stringify(roles),
      name ?? existing.name ?? null,
      title ?? existing.title ?? null,
      existing.id,
    )
    return { ...existing, roles, name: name ?? existing.name ?? null, title: title ?? existing.title ?? null }
  }
  const id = crypto.randomUUID()
  db.prepare(
    'INSERT INTO users (id, email, roles, name, title, createdAt) VALUES (?,?,?,?,?,?)',
  ).run(id, norm, JSON.stringify(roles), name ?? null, title ?? null, now)
  return { id, email: norm, roles, name: name ?? null, title: title ?? null, createdAt: now }
}

function seed() {
  const now = new Date().toISOString()

  // Sync the users table from users.yaml on every run (roles, names, links).
  syncUsersFromConfig()

  const pc = db.prepare('SELECT COUNT(*) AS c FROM products').get() as { c: number }
  if (pc.c === 0) {
    const ins = db.prepare(
      'INSERT INTO products (id, code, name, tracksCogs, createdAt) VALUES (?,?,?,?,?)',
    )
    for (const code of ['A', 'B', 'C']) {
      ins.run(crypto.randomUUID(), code, `Product ${code}`, 1, now)
    }
  }
  const bc = db
    .prepare('SELECT COUNT(*) AS c FROM bonus_fields')
    .get() as { c: number }
  if (bc.c === 0) {
    const ins = db.prepare(
      'INSERT INTO bonus_fields (id, parentType, name, nullable) VALUES (?,?,?,1)',
    )
    ins.run(crypto.randomUUID(), 'businessPartner', 'preferredPaymentCurrency')
    ins.run(crypto.randomUUID(), 'businessPartner', 'incoterms')
    ins.run(crypto.randomUUID(), 'product', 'storageCondition')
    ins.run(crypto.randomUUID(), 'order', 'rushDeliveryFlag')
  }

  // One-time import from the earlier JSON file store, if present.
  const legacy = path.join(process.cwd(), '.datagent-store.json')
  if (fs.existsSync(legacy)) {
    try {
      const data = JSON.parse(fs.readFileSync(legacy, 'utf8'))
      if (Array.isArray(data.partners) && data.partners.length > 0) {
        const ins = db.prepare(`INSERT OR IGNORE INTO business_partners
          (id, requestId, processStatus, customData, name, creditTerms, bankAccountNumber,
           contactName, contactEmail, contactPhone, partnerClass, country, countryOfOrigin,
           countrySynced, addresses, createdAt)
          VALUES (@id,@requestId,@processStatus,@customData,@name,@creditTerms,@bankAccountNumber,
                  @contactName,@contactEmail,@contactPhone,@partnerClass,@country,@countryOfOrigin,
                  @countrySynced,@addresses,@createdAt)`)
        for (const p of data.partners) {
          ins.run({
            countryOfOrigin: null,
            ...p,
            countrySynced: p.countrySynced ? 1 : 0,
            customData: JSON.stringify(p.customData ?? {}),
            addresses: JSON.stringify(p.addresses ?? {}),
          })
        }
      }
      if (Array.isArray(data.bankAccounts)) {
        const ins = db.prepare(`INSERT OR IGNORE INTO bank_accounts
          (id, bpId, iban, beneficiaryName, ibanValid, beneficiaryMatch, taxFormatValid,
           approval1By, approval2By, status) VALUES (@id,@bpId,@iban,@beneficiaryName,
          @ibanValid,@beneficiaryMatch,@taxFormatValid,@approval1By,@approval2By,@status)`)
        for (const a of data.bankAccounts) ins.run({ ...a, approval1By: a.approval1By ?? null, approval2By: a.approval2By ?? null })
      }
      fs.renameSync(legacy, `${legacy}.migrated`)
    } catch {
      /* keep app running if legacy import fails */
    }
  }
}
seed()

// Migration: processed_emails + sync_state for Zoho AgentInbox ingestion
db.exec(`
CREATE TABLE IF NOT EXISTS processed_emails (
  messageId TEXT PRIMARY KEY,
  requestId TEXT,
  fromEmail TEXT,
  subject TEXT,
  processedAt TEXT NOT NULL,
  error TEXT
);
CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS request_links (
  requestId TEXT NOT NULL,
  email TEXT NOT NULL,
  secret TEXT NOT NULL UNIQUE,
  canApprove INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (requestId, email)
);
CREATE TABLE IF NOT EXISTS api_requests (
  id TEXT PRIMARY KEY,
  requestId TEXT NOT NULL,
  content TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
`)

// ---- Per-recipient magic links ----------------------------------------------
// Every request participant gets their own secret link: requestors view-only,
// approvers (matched to the link's own email) get decision rights, so neither
// side ever has to type an email address.

export interface RequestLinkRow {
  requestId: string
  email: string
  secret: string
  canApprove: boolean
  createdAt: string
}

export function ensureRequestLink(requestId: string, email: string, canApprove: boolean): RequestLinkRow {
  const norm = email.trim().toLowerCase()
  const existing = db
    .prepare('SELECT * FROM request_links WHERE requestId = ? AND email = ?')
    .get(requestId, norm) as any | undefined
  if (existing) return { ...existing, canApprove: !!existing.canApprove }
  try {
    db.prepare(
      'INSERT INTO request_links (requestId, email, secret, canApprove, createdAt) VALUES (?,?,?,?,?)',
    ).run(requestId, norm, crypto.randomUUID(), canApprove ? 1 : 0, new Date().toISOString())
  } catch {
    /* race — fall through to select */
  }
  const row = db
    .prepare('SELECT * FROM request_links WHERE requestId = ? AND email = ?')
    .get(requestId, norm) as any
  return { ...row, canApprove: !!row.canApprove }
}

export function getRequestLink(requestId: string, secret: string): RequestLinkRow | undefined {
  const row = db
    .prepare('SELECT * FROM request_links WHERE requestId = ? AND secret = ?')
    .get(requestId, secret) as any | undefined
  return row ? { ...row, canApprove: !!row.canApprove } : undefined
}


export interface UserRow {
  id: string
  email: string
  roles: string[]
  name: string | null
  title: string | null
  createdAt: string
}

export function listUsers(): UserRow[] {
  return (
    db.prepare('SELECT * FROM users ORDER BY createdAt').all() as any[]
  ).map((u) => ({ ...u, roles: JSON.parse(u.roles) as string[] }))
}

export function upsertUser(email: string, roles: string[]): UserRow {
  const norm = email.trim().toLowerCase()
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(norm) as
    | any
    | undefined
  if (existing) {
    db.prepare('UPDATE users SET roles = ? WHERE id = ?').run(
      JSON.stringify(roles),
      existing.id,
    )
    return { ...existing, roles, name: existing.name ?? null, title: existing.title ?? null }
  }
  const id = crypto.randomUUID()
  db.prepare('INSERT INTO users (id, email, roles, createdAt) VALUES (?,?,?,?)').run(
    id,
    norm,
    JSON.stringify(roles),
    new Date().toISOString(),
  )
  return { id, email: norm, roles, name: null, title: null, createdAt: new Date().toISOString() }
}

export function setLinks(requesterEmail: string, approverEmail: string) {
  const r = db.prepare('SELECT id FROM users WHERE email = ?').get(requesterEmail.trim().toLowerCase()) as any
  const a = db.prepare('SELECT id FROM users WHERE email = ?').get(approverEmail.trim().toLowerCase()) as any
  if (!r || !a) return false
  db.prepare(
    'INSERT OR IGNORE INTO requester_approvers (requesterUserId, approverUserId) VALUES (?,?)',
  ).run(r.id, a.id)
  return true
}

export function listLinks(): { requester: string; approver: string }[] {
  return db
    .prepare(
      `SELECT ru.email AS requester, au.email AS approver
       FROM requester_approvers ra
       JOIN users ru ON ru.id = ra.requesterUserId
       JOIN users au ON au.id = ra.approverUserId`,
    )
    .all() as { requester: string; approver: string }[]
}

export function userRoles(email: string): string[] {
  const u = db
    .prepare('SELECT roles FROM users WHERE email = ?')
    .get(email.trim().toLowerCase()) as any | undefined
  return u ? (JSON.parse(u.roles) as string[]) : []
}

export function approverAssignedTo(requesterEmail: string, approverEmail: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM requester_approvers ra
       JOIN users r ON r.id = ra.requesterUserId
       JOIN users a ON a.id = ra.approverUserId
       WHERE r.email = ? AND a.email = ?`,
    )
    .get(requesterEmail.trim().toLowerCase(), approverEmail.trim().toLowerCase())
}

// ---- Requests ---------------------------------------------------------------

export interface RequestRow {
  id: string
  threadId: string | null
  token: string | null
  type: string
  bpClass: string | null
  requesterEmail: string
  status: string
  payload: any
  requestReason: string | null
  needsItConfig: boolean
  bonusText: string | null
  decidedBy: string | null
  decisionNote: string | null
  createdAt: string
  updatedAt: string
}

export function listRequests(): RequestRow[] {
  return (db.prepare('SELECT * FROM requests ORDER BY createdAt DESC').all() as any[]).map(hydrateRequest)
}

export function getRequest(id: string): RequestRow | undefined {
  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as any
  return row ? hydrateRequest(row) : undefined
}

export function getRequestByToken(token: string): RequestRow | undefined {
  const row = db
    .prepare('SELECT * FROM requests WHERE token = ?')
    .get(token) as any
  return row ? hydrateRequest(row) : undefined
}

export function getLatestPendingRequest(requesterEmail: string): RequestRow | undefined {
  const row = db
    .prepare('SELECT * FROM requests WHERE requesterEmail = ? AND status = ? ORDER BY createdAt DESC LIMIT 1')
    .get(requesterEmail.trim().toLowerCase(), 'PENDING_APPROVAL') as any
  return row ? hydrateRequest(row) : undefined
}

export function getLatestRequest(requesterEmail: string): RequestRow | undefined {
  const row = db
    .prepare('SELECT * FROM requests WHERE requesterEmail = ? ORDER BY createdAt DESC LIMIT 1')
    .get(requesterEmail.trim().toLowerCase()) as any
  return row ? hydrateRequest(row) : undefined
}

export function updateRequestPayload(id: string, payload: any) {
  db.prepare('UPDATE requests SET payload = ?, updatedAt = ? WHERE id = ?').run(
    JSON.stringify(payload),
    new Date().toISOString(),
    id,
  )
  return getRequest(id)!
}

export function updateRequestReason(id: string, reason: string) {
  db.prepare('UPDATE requests SET requestReason = ?, updatedAt = ? WHERE id = ?').run(reason, new Date().toISOString(), id)
}

function hydrateRequest(row: any): RequestRow {
  return {
    ...row,
    payload: JSON.parse(row.payload ?? '{}'),
    needsItConfig: !!row.needsItConfig,
  }
}

export function insertRequest(r: {
  threadId?: string
  type: string
  bpClass?: string
  requesterEmail: string
  status: string
  payload: any
  needsItConfig?: boolean
  requestReason?: string | null
  bonusText?: string | null
}): RequestRow {
  const id = crypto.randomUUID()
  const token = crypto.randomUUID()
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO requests
    (id, threadId, type, bpClass, requesterEmail, status, payload, needsItConfig, requestReason, bonusText, token, createdAt, updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id,
    r.threadId ?? null,
    r.type,
    r.bpClass ?? null,
    r.requesterEmail.trim().toLowerCase(),
    r.status,
    JSON.stringify(r.payload),
    r.needsItConfig ? 1 : 0,
    r.requestReason ?? null,
    r.bonusText ?? null,
    token,
    now,
    now,
  )
  return getRequest(id)!
}

export function updateRequestStatus(
  id: string,
  status: string,
  decidedBy?: string | null,
  decisionNote?: string | null,
) {
  db.prepare(
    'UPDATE requests SET status = ?, decidedBy = COALESCE(?, decidedBy), decisionNote = COALESCE(?, decisionNote), updatedAt = ? WHERE id = ?',
  ).run(status, decidedBy ?? null, decisionNote ?? null, new Date().toISOString(), id)
}

export function recordApproval(
  requestId: string,
  approverEmail: string,
  decision: 'APPROVED' | 'REJECTED',
  reason?: string | null,
) {
  db.prepare(
    'INSERT OR REPLACE INTO request_approvals (requestId, approverEmail, decision, reason, decidedAt) VALUES (?,?,?,?,?)',
  ).run(requestId, approverEmail.trim().toLowerCase(), decision, reason ?? null, new Date().toISOString())
}

export function listApprovals(requestId: string): { approverEmail: string; decision: string; decidedAt: string }[] {
  return db
    .prepare('SELECT approverEmail, decision, reason, decidedAt FROM request_approvals WHERE requestId = ? ORDER BY decidedAt')
    .all(requestId) as any
}

export function appendAudit(requestId: string, actor: string, action: string, detail?: string) {
  const seqRow = db
    .prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM audit_events WHERE requestId = ?')
    .get(requestId) as any
  db.prepare(
    'INSERT INTO audit_events (requestId, seq, actor, action, detail, createdAt) VALUES (?,?,?,?,?,?)',
  ).run(requestId, seqRow.n, actor, action, detail ?? null, new Date().toISOString())
}

export function listAudit(requestId: string): { seq: number; actor: string; action: string; detail: string | null; createdAt: string }[] {
  return db
    .prepare('SELECT seq, actor, action, detail, createdAt FROM audit_events WHERE requestId = ? ORDER BY seq')
    .all(requestId) as any
}

export function recordEmail(requestId: string, toEmail: string, subject: string, body: string) {
  db.prepare(
    'INSERT INTO emails (id, requestId, toEmail, subject, body, createdAt) VALUES (?,?,?,?,?,?)',
  ).run(crypto.randomUUID(), requestId, toEmail.trim().toLowerCase(), subject, body, new Date().toISOString())
}

export function listEmails(requestId: string): { toEmail: string; subject: string; body: string; createdAt: string }[] {
  return db
    .prepare('SELECT toEmail, subject, body, createdAt FROM emails WHERE requestId = ? ORDER BY createdAt')
    .all(requestId) as any
}

export function insertApiRequest(requestId: string, content: string) {
  db.prepare('INSERT INTO api_requests (id, requestId, content, createdAt) VALUES (?,?,?,?)').run(
    crypto.randomUUID(),
    requestId,
    content,
    new Date().toISOString(),
  )
}

export function listApiRequests(requestId: string): { content: string; createdAt: string }[] {
  return db
    .prepare('SELECT content, createdAt FROM api_requests WHERE requestId = ? ORDER BY createdAt')
    .all(requestId) as any
}
export function listBonusFields(parentType?: string) {
  const rows = parentType
    ? db.prepare('SELECT * FROM bonus_fields WHERE parentType = ?').all(parentType)
    : db.prepare('SELECT * FROM bonus_fields').all()
  return (rows as any[]).map((r) => ({ ...r, nullable: !!r.nullable }))
}

export function addBonusField(parentType: string, name: string) {
  const id = crypto.randomUUID()
  db.prepare(
    'INSERT OR IGNORE INTO bonus_fields (id, parentType, name, nullable) VALUES (?,?,?,1)',
  ).run(id, parentType, name.trim())
  return getBonusFieldByName(parentType, name.trim())
}

export function getBonusFieldByName(parentType: string, name: string) {
  const row = db
    .prepare('SELECT * FROM bonus_fields WHERE parentType = ? AND name = ?')
    .get(parentType, name.trim()) as any
  return row ? { ...row, nullable: !!row.nullable } : undefined
}

export function setBonusValue(requestId: string, fieldId: string, value: string | null) {
  db.prepare(
    'INSERT OR REPLACE INTO request_bonus_values (requestId, fieldId, value) VALUES (?,?,?)',
  ).run(requestId, fieldId, value)
}

export function listBonusValues(requestId: string) {
  return db
    .prepare('SELECT fieldId, value FROM request_bonus_values WHERE requestId = ?')
    .all(requestId) as { fieldId: string; value: string }[]
}

// ---- Business partners / bank accounts --------------------------------------

export function listPartners() {
  return (db.prepare('SELECT * FROM business_partners ORDER BY createdAt DESC').all() as any[]).map(
    (p) => ({
      ...p,
      customData: JSON.parse(p.customData ?? '{}'),
      addresses: JSON.parse(p.addresses ?? '{}'),
      countrySynced: !!p.countrySynced,
    }),
  )
}

export function insertPartner(p: any) {
  db.prepare(`INSERT INTO business_partners
    (id, requestId, processStatus, customData, name, creditTerms, bankAccountNumber,
     contactName, contactEmail, contactPhone, partnerClass, country, countryOfOrigin,
     countrySynced, addresses, createdAt)
    VALUES (@id,@requestId,@processStatus,@customData,@name,@creditTerms,@bankAccountNumber,
            @contactName,@contactEmail,@contactPhone,@partnerClass,@country,@countryOfOrigin,
            @countrySynced,@addresses,@createdAt)`)
    .run({ ...p, countrySynced: p.countrySynced ? 1 : 0, customData: JSON.stringify(p.customData ?? {}), addresses: JSON.stringify(p.addresses ?? {}) })
}

export function updatePartnerStatus(id: string, processStatus: string) {
  db.prepare('UPDATE business_partners SET processStatus = ? WHERE id = ?').run(processStatus, id)
}

export function updatePartnerRecord(id: string, patch: Record<string, any>) {
  const p: any = { id }
  for (const k of [
    'name',
    'partnerClass',
    'creditTerms',
    'bankAccountNumber',
    'contactName',
    'contactEmail',
    'contactPhone',
    'country',
    'countryOfOrigin',
  ] as const) {
    if (patch[k] !== undefined && patch[k] !== null && String(patch[k]).trim() !== '') p[k] = patch[k]
  }
  if (patch.addresses !== undefined) p.addresses = JSON.stringify(patch.addresses)
  const keys = Object.keys(p).filter((k) => k !== 'id')
  if (!keys.length) return
  db.prepare(`UPDATE business_partners SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run(p)
}

export function markPartnersPushed(ids: string[], requestIdById: Record<string, string>) {
  const upd = db.prepare(
    "UPDATE business_partners SET processStatus = 'PUSHED_TO_SAP', requestId = ? WHERE id = ?",
  )
  const tx = db.transaction((list: string[]) => {
    for (const id of list) upd.run(requestIdById[id] ?? id, id)
  })
  tx(ids)
}

export function listBankAccounts() {
  return (db.prepare('SELECT * FROM bank_accounts ORDER BY rowid DESC').all() as any[]).map(
    (a) => ({ ...a, ibanValid: !!a.ibanValid, beneficiaryMatch: !!a.beneficiaryMatch, taxFormatValid: !!a.taxFormatValid }),
  )
}

export function insertBankAccount(a: any) {
  db.prepare(`INSERT INTO bank_accounts
    (id, bpId, iban, beneficiaryName, ibanValid, beneficiaryMatch, taxFormatValid,
     approval1By, approval2By, status)
    VALUES (@id,@bpId,@iban,@beneficiaryName,@ibanValid,@beneficiaryMatch,@taxFormatValid,
            @approval1By,@approval2By,@status)`)
    .run(a)
}

export function getBankAccount(id: string): any | undefined {
  return db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(id)
}

export function updateBankAccount(id: string, patch: {
  approval1By?: string | null
  approval2By?: string | null
  status: string
}) {
  db.prepare('UPDATE bank_accounts SET approval1By = ?, approval2By = ?, status = ? WHERE id = ?').run(
    patch.approval1By ?? null,
    patch.approval2By ?? null,
    patch.status,
    id,
  )
}

// ---- Products / orders ------------------------------------------------------

export function listProducts() {
  return db.prepare('SELECT * FROM products ORDER BY code').all()
}

export function listOrders() {
  return db.prepare('SELECT * FROM orders ORDER BY createdAt DESC').all()
}

export function insertProduct(p: { id: string; code: string; name: string; tracksCogs: number; createdAt: string }) {
  db.prepare(`INSERT INTO products (id, code, name, tracksCogs, createdAt) VALUES (@id,@code,@name,@tracksCogs,@createdAt)`).run(p)
}

export function insertOrder(o: any) {
  db.prepare(`INSERT INTO orders
    (id, orderNumber, productCode, partnerId, qty, paymentDate, deliveryDate, createdAt)
    VALUES (@id,@orderNumber,@productCode,@partnerId,@qty,@paymentDate,@deliveryDate,@createdAt)`)
    .run({ ...o, paymentDate: o.paymentDate ?? null, deliveryDate: o.deliveryDate ?? null })
}

// ---- Zoho AgentInbox ingestion helpers --------------------------------------

export function isEmailProcessed(messageId: string): boolean {
  return !!db.prepare('SELECT 1 FROM processed_emails WHERE messageId = ?').get(messageId)
}

export function markEmailProcessed(
  messageId: string,
  requestId: string | null,
  fromEmail: string | null,
  subject: string | null,
  error: string | null = null,
) {
  db.prepare(
    `INSERT OR REPLACE INTO processed_emails (messageId, requestId, fromEmail, subject, processedAt, error)
     VALUES (?,?,?,?,?,?)`,
  ).run(messageId, requestId, fromEmail, subject, new Date().toISOString(), error)
}

export function listProcessedEmails(limit = 50) {
  return db
    .prepare('SELECT * FROM processed_emails ORDER BY processedAt DESC LIMIT ?')
    .all(limit) as any[]
}

export function getSyncState(key: string): string | null {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as any
  return row ? row.value : null
}

export function setSyncState(key: string, value: string) {
  db.prepare('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?,?)').run(key, value)
}

export default db
