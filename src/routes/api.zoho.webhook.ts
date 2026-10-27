import { createFileRoute } from '@tanstack/react-router'
import { syncInbox } from '~/lib/ingest.server'

export const Route = createFileRoute('/api/zoho/webhook')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const result = await syncInbox()
          return Response.json(result)
        } catch (e: any) {
          return Response.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 })
        }
      },
      GET: async () => {
        const result = await syncInbox()
        return Response.json(result)
      },
    },
  },
})