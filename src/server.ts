import {
  createStartHandler,
  defaultStreamHandler,
  createServerEntry as createCoreServerEntry,
} from '@tanstack/react-start/server'
import type { Register } from '@tanstack/react-router'
import type { RequestHandler } from '@tanstack/react-start/server'
import { syncInbox } from '~/lib/ingest.server'

const fetch = createStartHandler(defaultStreamHandler)

export type ServerEntry = { fetch: RequestHandler<Register> }

export const createServerEntry: (entry: ServerEntry) => ServerEntry =
  createCoreServerEntry<Register>

// Server-side polling: run sync every 5 seconds regardless of client connections.
if (typeof setInterval !== 'undefined') {
  const run = () => {
    syncInbox()
      .then((r) => console.log('[datagent] scheduled sync:', r.processed, 'processed,', r.skipped, 'skipped', r.errors.length ? r.errors : ''))
      .catch((e) => console.error('[datagent] scheduled sync error:', e?.message ?? e))
  }
  // initial run after a short delay to let the server boot
  setTimeout(run, 2000)
  setInterval(run, 5000)
}

export default createServerEntry({ fetch })