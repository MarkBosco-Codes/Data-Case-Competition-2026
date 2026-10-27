import { createFileRoute, notFound } from '@tanstack/react-router'
import { loadBySecret, RequestPage } from '~/components/RequestPage'

export const Route = createFileRoute('/r/$id/$secret')({
  loader: async ({ params }) => {
    const res = await loadBySecret({ data: { id: params.id, secret: params.secret } })
    if (!res.request) throw notFound()
    return res
  },
  component: () => {
    const { id, secret } = Route.useParams()
    const initial = Route.useLoaderData()
    return <RequestPage initial={initial} requestId={id} secret={secret} />
  },
})
