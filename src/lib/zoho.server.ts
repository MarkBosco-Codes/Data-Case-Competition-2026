// Server-only Zoho AgentInbox client.
import { isEmailProcessed, markEmailProcessed, getSyncState, setSyncState } from '~/lib/db'

export interface ZohoMessage {
  messageId: string
  subject: string
  sender: string
  fromAddress: string
  toAddress: string
  receivedTime: string
  status: string
  summary?: string
}

function zohoKey(): string {
  return (process.env['zoho-inbox-key'] ?? process.env['ZOHO_INBOX_KEY'] ?? '').trim()
}

function configuredAgent(): string {
  return (process.env['zoho-agent-name'] ?? process.env['ZOHO_AGENT_NAME'] ?? '').trim()
}

function mailboxName(): string {
  const explicit = (process.env['zoho-mailbox-name'] ?? process.env['ZOHO_MAILBOX_NAME'] ?? '').trim()
  if (explicit) return explicit
  const c = configuredAgent()
  if (c && !c.includes('@')) return c
  return ''
}

export function mailboxEmail(): string {
  const c = configuredAgent()
  if (c.includes('@')) return c
  const name = mailboxName()
  return name ? `${name}@agenzia.to` : ''
}

const BASE = 'https://api.zohoagentinbox.com/api/v0.9'

export function zohoConfig() {
  return { key: zohoKey(), agentName: mailboxName() || configuredAgent(), email: mailboxEmail() }
}

async function zohoFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: zohoKey(),
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { status: res.status, ok: res.ok, body: json, text }
}

// Resolve a working agent name slug. The .env may contain an email; try
// several candidates and cache the first that Zoho accepts.
const CANDIDATES = [
  mailboxName(),
  configuredAgent(),
  ... (configuredAgent().includes('@') ? [] : [configuredAgent()]),
  configuredAgent().split('@')[0],
  'datagent-mailbox',
  'datagent',
  'lgdatagent',
  'lifegroupdatagent',
  'lifegroup',
  'dataagent',
  'mdmagent',
  'lifeagent',
].filter(Boolean)

let resolvedAgent: string | null = getSyncState('zoho_agent_name')

export async function resolveAgentName(): Promise<{ name: string | null; tried: string[]; error?: string }> {
  if (resolvedAgent) return { name: resolvedAgent, tried: [resolvedAgent] }
  const tried: string[] = []
  for (const cand of CANDIDATES) {
    if (!cand) continue
    if (tried.includes(cand)) continue
    tried.push(cand)
    const r = await zohoFetch(`/agents/${cand}/messages?limit=1`)
    const code = r.body?.status?.code ?? r.status
    if (r.ok && (code === 200 || code === undefined)) {
      resolvedAgent = cand
      setSyncState('zoho_agent_name', cand)
      return { name: cand, tried }
    }
  }
  return { name: null, tried, error: 'No working agent name found; update zoho-agent-name in .env' }
}

export async function listUnreadMessages(limit = 50): Promise<{ ok: boolean; messages: ZohoMessage[]; error?: string; agentName?: string }> {
  const resolved = await resolveAgentName()
  if (!resolved.name) return { ok: false, messages: [], error: resolved.error, agentName: undefined }
  const r = await zohoFetch(`/agents/${resolved.name}/messages?status=unread&limit=${limit}`)
  const code = r.body?.status?.code ?? r.status
  if (!r.ok || code !== 200) {
    return { ok: false, messages: [], error: r.body?.status?.description ?? r.text, agentName: resolved.name }
  }
  const data = Array.isArray(r.body?.data) ? r.body.data : []
  const messages: ZohoMessage[] = data.map((m: any) => ({
    messageId: String(m.messageId ?? m.id ?? ''),
    subject: m.subject ?? '',
    sender: m.sender ?? '',
    fromAddress: m.fromAddress ?? '',
    toAddress: m.toAddress ?? '',
    receivedTime: m.receivedTime ?? '',
    status: m.status ?? '',
    summary: m.summary,
  }))
  return { ok: true, messages, agentName: resolved.name }
}

export async function getMessageContent(messageId: string): Promise<string> {
  const resolved = await resolveAgentName()
  if (!resolved.name) return ''
  const r = await zohoFetch(`/agents/${resolved.name}/messages/${messageId}/content`)
  return r.body?.data?.content ?? r.body?.content ?? ''
}

export async function sendMail(opts: {
  fromAddress: string
  toAddress: string
  subject: string
  content: string
  mailFormat?: 'html' | 'plaintext'
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const resolved = await resolveAgentName()
  if (!resolved.name) return { ok: false, error: resolved.error }
  const r = await zohoFetch(`/agents/${resolved.name}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      fromAddress: opts.fromAddress,
      toAddress: opts.toAddress,
      subject: opts.subject,
      content: opts.content,
      mailFormat: opts.mailFormat ?? 'plaintext',
    }),
  })
  const code = r.body?.status?.code ?? r.status
  if (!r.ok || code !== 200) {
    return { ok: false, error: r.body?.status?.description ?? r.text }
  }
  return { ok: true, messageId: r.body?.data?.messageId }
}

export async function sendReply(opts: {
  messageId: string
  fromAddress: string
  toAddress?: string
  subject: string
  content: string
  action?: 'reply' | 'replyall' | 'forward'
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const resolved = await resolveAgentName()
  if (!resolved.name) return { ok: false, error: resolved.error }
  const body: any = {
    action: opts.action ?? 'reply',
    fromAddress: opts.fromAddress,
    subject: opts.subject,
    content: opts.content,
    mailFormat: 'plaintext',
  }
  if (opts.toAddress) body.toAddress = opts.toAddress
  const r = await zohoFetch(`/agents/${resolved.name}/messages/${opts.messageId}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  const code = r.body?.status?.code ?? r.status
  if (!r.ok || code !== 200) {
    return { ok: false, error: r.body?.status?.description ?? r.text }
  }
  return { ok: true, messageId: r.body?.data?.messageId }
}

export { isEmailProcessed, markEmailProcessed }