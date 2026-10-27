// Server-only Agnes AI client (OpenAI-compatible).
const AGNES_BASE = 'https://apihub.agnes-ai.com/v1'

function agnesKeys(): string[] {
  const raw = process.env['AGNES_AI_KEY'] ?? process.env['agnes_ai_key'] ?? ''
  return raw
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
}

function agnesModel(): string {
  return (process.env['AGNES_MODEL_NAME'] ?? process.env['agnes_model_name'] ?? 'agnes-2.5-flash').trim()
}

const MAX_ATTEMPTS = 8
const BASE_TIMEOUT_MS = 8000

let keyCursor = 0

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function agnesChat(
  messages: { role: string; content: string }[],
  opts?: { json?: boolean },
): Promise<string> {
  const keys = agnesKeys()
  if (keys.length === 0) throw new Error('AGNES_AI_KEY not configured')

  const input = messages.map((m) => `[${m.role}] ${m.content}`).join('\n\n')
  let lastErr: any = null

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const key = keys[(keyCursor + attempt) % keys.length]
    const timeoutMs = Math.min(BASE_TIMEOUT_MS * Math.pow(2, attempt), 60000)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const res = await fetch(`${AGNES_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: agnesModel(),
          messages,
          ...(opts?.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
      })
      clearTimeout(timer)

      const text = await res.text()
      let json: any
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error(`Agnes non-JSON response: ${text.slice(0, 200)}`)
      }
      if (!res.ok) {
        lastErr = new Error(json?.error?.message ?? text.slice(0, 200))
        await sleep(Math.min(500 * Math.pow(2, attempt), 8000))
        continue
      }

      const content = json?.choices?.[0]?.message?.content ?? ''
      if (content.trim() === '') {
        // empty response -> retry with next key
        lastErr = new Error('Agnes returned empty content')
        keyCursor = (keyCursor + 1) % keys.length
        await sleep(Math.min(500 * Math.pow(2, attempt), 8000))
        continue
      }

      keyCursor = (keyCursor + 1) % keys.length
      return content
    } catch (e: any) {
      clearTimeout(timer)
      lastErr = e?.name === 'AbortError' ? new Error(`Agnes request timed out after ${timeoutMs}ms`) : e
      await sleep(Math.min(500 * Math.pow(2, attempt), 8000))
    }
  }

  throw lastErr ?? new Error('Agnes request failed after retries')
}

export async function parseEmailToIntake(email: { subject: string; content: string; from: string }): Promise<{
  parsed: any
  input: string
  output: string
}> {
  const system = `You are an MDM email agent. Classify the email request into one of:
- BUSINESS_PARTNER: adding a customer or supplier/vendor business partner
- PRODUCT: adding a new product
- ORDER: creating a new order (sales/purchase)
- UNKNOWN: cannot determine

Return ONLY a JSON object. Common fields: "type" (one of above), "intent" ("create" | "modify" | "delete" — default "create"; use "modify"/"delete" only when the email is a reply changing an already-approved record), "requestReason" (MANDATORY concise justification of why this request is needed; only null if the email truly does not state one), "notes" (free text / bonus requirements / custom fields or null).

IMPORTANT: "notes" MUST capture any new/custom fields, extra attributes, or specifications requested in the email (e.g. "Add a field colour: green" -> notes: "colour: green"). NEVER set notes to null if the email mentions extra fields, new fields, or custom attributes.

If type is BUSINESS_PARTNER, also include:
  "name", "contactName" (required), "contactEmail" (required company email, not the requester), "contactPhone" (required),
  "partnerClass" ("Customer" or "Supplier"), "country" (Singapore/Malaysia/Thailand/Vietnam/Indonesia or null, required),
  "countryOfOrigin", "addresses" (single string — the full address, required). Note: creditTerms and bankAccountNumber are filled in later by the user via form; ignore if missing in email.

If type is PRODUCT, also include:
  "code" (A/B/C or a new code), "name" (REQUIRED full product name, e.g. "MedicalScanner V2").

If type is ORDER, also include:
  "orderNumber", "productCode", "partnerName" (customer or vendor name),
  "qty" (number), "paymentDate" (ISO date or null), "deliveryDate" (ISO date or null).

Map "supplier/vendor" -> "Supplier", "customer" -> "Customer". Infer country from context. notes captures any free-text bonus requirements.`
  const user = `From: ${email.from}\nSubject: ${email.subject}\n\n${email.content}`
  const input = `[system] ${system}\n\n[user] ${user}`
  let output = ''
  try {
    output = await agnesChat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { json: true },
    )
  } catch (e: any) {
    output = `ERROR: ${e?.message ?? String(e)}`
    return { parsed: null, input, output }
  }
  let parsed: any = null
  try {
    parsed = JSON.parse(output)
  } catch {
    const m = output.match(/\{[\s\S]*\}/)
    if (m) {
      try {
        parsed = JSON.parse(m[0])
      } catch {
        parsed = null
      }
    }
  }
  return { parsed, input, output }
}