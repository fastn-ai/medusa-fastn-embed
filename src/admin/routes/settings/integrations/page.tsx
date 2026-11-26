import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Container, Heading, Text, Button } from "@medusajs/ui"
import { FastnHub } from "@fastn-ai/embed/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { sdk } from "../../../lib/sdk"

type TokenResponse = { token: string; orgId: string; baseUrl: string; expiresIn?: number }

/** Ask our own backend for a token. The fastn API key never reaches the browser. */
async function fetchSession(): Promise<TokenResponse> {
  return sdk.client.fetch<TokenResponse>("/admin/fastn/embed-token", { method: "POST" })
}

const IntegrationsPage = () => {
  const [session, setSession] = useState<TokenResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const first = useRef(true)

  const load = useCallback(async () => {
    setError(null)
    setSession(null)
    try {
      setSession(await fetchSession())
    } catch (e) {
      setError((e as Error).message || "Could not start the integrations session.")
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // The hub calls this at mount and whenever its session expires. The first
  // call reuses the token we already fetched (to learn baseUrl/orgId).
  const getToken = useCallback(async () => {
    if (first.current && session) {
      first.current = false
      return session.token
    }
    return (await fetchSession()).token
  }, [session])

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h1">Integrations</Heading>
        <Text size="small" className="text-ui-fg-subtle">
          Connect the apps your store uses. Powered by fastn.
        </Text>
      </div>
      <div className="px-6 py-4">
        {error && (
          <div className="flex flex-col items-start gap-y-2">
            <Text className="text-ui-fg-error">{error}</Text>
            <Button size="small" variant="secondary" onClick={load}>
              Retry
            </Button>
          </div>
        )}
        {!error && !session && <Text className="text-ui-fg-subtle">Loading integrations…</Text>}
        {session && (
          <FastnHub
            baseUrl={session.baseUrl}
            orgId={session.orgId}
            getToken={getToken}
            height={720}
            fallback={<Text className="text-ui-fg-subtle">Loading integrations…</Text>}
            renderError={(message: string, retry: () => void) => (
              <div className="flex flex-col items-start gap-y-2">
                <Text className="text-ui-fg-error">The integrations hub failed to load: {message}</Text>
                <Button size="small" variant="secondary" onClick={retry}>
                  Retry
                </Button>
              </div>
            )}
          />
        )}
      </div>
    </Container>
  )
}

export const config = defineRouteConfig({
  label: "Integrations",
})

export default IntegrationsPage
