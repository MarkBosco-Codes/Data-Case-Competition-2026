// Server-only store: persists the BP records + staged bank approvals in a JSON
// file so both createServerFn handlers and /api server routes share one source.
import nodeFs from 'node:fs'
import path from 'node:path'
import type { BankAccount, BusinessPartner } from './types'

const DB_FILE = path.join(process.cwd(), '.datagent-store.json')

type Store = {
  partners: BusinessPartner[]
  bankAccounts: BankAccount[]
}

function emptyStore(): Store {
  return { partners: [], bankAccounts: [] }
}

export function readStore(): Store {
  try {
    const raw = nodeFs.readFileSync(DB_FILE, 'utf-8')
    return JSON.parse(raw) as Store
  } catch {
    return emptyStore()
  }
}

export function writeStore(store: Store): void {
  nodeFs.writeFileSync(DB_FILE, JSON.stringify(store, null, 2), 'utf-8')
}

export function listPartners(): BusinessPartner[] {
  return readStore().partners
}

export function listBankAccounts(): BankAccount[] {
  return readStore().bankAccounts
}
