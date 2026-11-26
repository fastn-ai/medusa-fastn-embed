import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { ensureCustomer, fastnBaseUrl, FastnError, mintEmbedToken } from "../../../../lib/fastn"

/**
 * POST /admin/fastn/embed-token
 *
 * Admin-only (Medusa protects /admin/* by default). Each Medusa store is one
 * fastn customer; each signed-in admin user is one fastn end user. The store is
 * registered with fastn on first use, then a fresh embed token is minted.
 * Only the token (and the base URL it is valid for) reach the browser.
 */
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  if (req.auth_context?.actor_type !== "user") {
    return res.status(403).json({ message: "Only signed-in admin users can open integrations." })
  }
  const userId = req.auth_context.actor_id

  try {
    const { data: stores } = await query.graph({
      entity: "store",
      fields: ["id", "name", "metadata"],
    })
    const store = stores[0]
    if (!store) return res.status(500).json({ message: "No store found." })

    const { data: users } = await query.graph({
      entity: "user",
      fields: ["id", "email", "first_name", "last_name"],
      filters: { id: userId },
    })
    const user = users[0]

    // Customer mapping: one fastn customer per Medusa store.
    const orgId = store.id
    const orgName = store.name || "Medusa Store"

    if (!store.metadata?.fastn_registered_at) {
      await ensureCustomer(orgId, orgName)
      const storeService = req.scope.resolve(Modules.STORE)
      await storeService.updateStores(store.id, {
        metadata: { ...(store.metadata ?? {}), fastn_registered_at: new Date().toISOString() },
      })
    }

    const userName = [user?.first_name, user?.last_name].filter(Boolean).join(" ")
    const { token, expiresIn } = await mintEmbedToken({
      orgId,
      userId,
      userEmail: user?.email,
      userName: userName || undefined,
    })

    res.setHeader("Cache-Control", "no-store")
    return res.json({ token, expiresIn, orgId, baseUrl: fastnBaseUrl() })
  } catch (e) {
    const err = e as FastnError
    logger.error(
      `fastn: ${err.message}${err.detail ? ` ${JSON.stringify(err.detail)}` : ""}`
    )
    return res.status(502).json({ message: "Could not start the integrations session." })
  }
}
