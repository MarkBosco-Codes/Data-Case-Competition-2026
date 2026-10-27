# LifeGroup DataGent

TanStack Start app (React 19) that polls a Zoho AgentInbox mailbox, classifies incoming emails with the **Agnes** AI, creates MDM requests (business partner / product / order), emails per-recipient magic links, and lets approvers approve or reject — with a full audit trail per request.

## npm scripts

| Script | Command | Purpose |
|---|---|---|
| `dev` | `vite dev` | Dev server on `:3000` (auto-regenerates route tree) |
| `build` | `vite build` | Production build |
| `start` | `node .output/server/index.mjs` | Run built server |
| `typecheck` | `tsc --noEmit` | TypeScript check |
| `reset` | `node scripts/reset-db.mjs` | Wipe transactional data, keep users/permissions/master data |

## Integrations

- **Zoho AgentInbox** — email polling (every 5s) via `src/lib/zoho` (mailbox read + reply). Env: Zoho credentials.
- **Agnes AI** — OpenAI-compatible classifier at `apihub.agnes-ai.com`. Env: `AGNES_AI_KEY`, `AGNES_MODEL_NAME`. Prompt mirror: `_prompt.txt`.
- **SQLite** — `better-sqlite3`, file `.datagent.db` (WAL mode).
- **users.yaml** — drives users + roles + requester↔approver links, synced on load via `syncUsersFromConfig`.
- **Magic links** — no-login access via `/r/<requestId>/<secret>` (one secret per recipient per request; approvers' links carry approve rights).

## Application flow

1. `syncInbox()` polls unread Zoho messages.
2. Skip self-replies / missing sender; classify via Agnes (`parseEmailToIntake`).
3. `reason` is mandatory — missing → reply asking for reason, mark `MISSING_REASON`, skip.
4. Business partner requests require name, bank account number, contact name, contact phone, and a single address — missing → reply listing them, mark `MISSING_DETAILS`, skip. Credit terms default `NET30`, contact email defaults to sender, country of origin collected at KYC.
5. Dupe check (name + country + partner class); if duplicate, reply and skip.
6. Otherwise stage `business_partners`/`products`/`orders`, insert `requests` (PENDING_APPROVAL), audit `SUBMITTED`, reply requester with track link, notify approvers with per-recipient approve links.
7. Human `Re:` replies update the latest pending request (fields merged, missing re-checked); `STILL_MISSING` / `FOLLOW_UP` / `FOLLOW_UP_NOOP` outcomes.
8. Approver opens `/r/<id>/<secret>`, identity auto-filled from link; `decideRequest` resolves approver from link secret, runs role/assignment checks, records approval + audit, pushes to mock SAP B1 on approve, emails requester.
9. Requestor magic links are view-only.

## DB schema (SQLite)

- `users` (id, email, roles JSON, name, title, createdAt)
- `requests` (id, threadId, type, bpClass, requesterEmail, status, payload JSON, reason, needsItConfig, bonusText, decidedBy, decisionNote, createdAt, updatedAt, token legacy)
- `request_approvals` (requestId, approverEmail, decision, decidedAt) PK
- `audit_events` (requestId, seq, actor, action, detail, createdAt) PK
- `emails` (id, requestId, toEmail, subject, body, createdAt)
- `requester_approvers` (requesterUserId, approverUserId) PK
- `bonus_fields` (id, parentType, name, nullable) UNIQUE(parentType,name)
- `request_bonus_values` (requestId, fieldId, value) PK
- `business_partners` (id, requestId, processStatus, customData, name, creditTerms, bankAccountNumber, contactName, contactEmail, contactPhone, partnerClass, country, countryOfOrigin, countrySynced, addresses, createdAt)
- `bank_accounts` (id, bpId, iban, beneficiaryName, ibanValid, beneficiaryMatch, taxFormatValid, approval1By, approval2By, status)
- `products` (id, code UNIQUE, name, tracksCogs, createdAt)
- `orders` (id, orderNumber, productCode, partnerId, direction, qty, paymentDate, deliveryDate, createdAt)
- `processed_emails` (messageId PK, requestId, fromEmail, subject, processedAt, error)
- `sync_state` (key PK, value)
- `request_links` (requestId, email, secret UNIQUE, canApprove, createdAt) PK(requestId,email)
