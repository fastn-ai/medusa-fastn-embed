import crypto from "crypto"

/**
 * Server-side fastn client. Runs only in the Medusa backend: the API key and
 * identity secret are read from the environment and never leave this process.
 *
 * Contract (fastn API, identity verification "required"):
 *  - Auth:      Authorization: Bearer <FASTN_API_KEY>
 *  - Identity:  x-org-id / x-user-id, proven with
 *               x-identity-hmac = hex(HMAC-SHA256(secret, `${orgId}\n${userId}`)),
 *               where an absent header counts as "".
 *  - Customer:  POST /api/v1/orgs { name, orgId }  (orgId = our id, stored as external_ref)
 *               GET  /api/v1/orgs/:orgId           (accepts that same external id)
 *  - Token:     POST /api/v1/embed/token           -> { data: { token, expiresIn } }
 */

type FastnConfig = { apiKey: string; idvSecret: string; baseUrl: string }

/** User id we attest for backend-only provisioning calls (no end user involved). */
const PROVISIONER_USER_ID = "medusa-backend-provisioner"

export class FastnError extends Error {
  constructor(message: string, public status?: number, public detail?: unknown) {
    super(message)
    this.name = "FastnError"
  }
}

function config(): FastnConfig {
  const apiKey = process.env.FASTN_API_KEY
  const idvSecret = process.env.FASTN_IDV_SECRET
  const missing = [
    !apiKey && "FASTN_API_KEY",
    !idvSecret && "FASTN_IDV_SECRET",
  ].filter(Boolean)
  if (missing.length) {
    throw new FastnError(`Missing environment variable(s): ${missing.join(", ")}`)
  }
  return {
    apiKey: apiKey!,
    idvSecret: idvSecret!,
    baseUrl: (process.env.FASTN_BASE_URL || "https://api.fastn.dev").replace(/\/+$/, ""),
  }
}

/** The base URL the browser's embed SDK must use: tokens only work where they were minted. */
export function fastnBaseUrl(): string {
  return (process.env.FASTN_BASE_URL || "https://api.fastn.dev").replace(/\/+$/, "")
}

export function identityHmac(secret: string, orgId: string, userId: string): string {
  return crypto.createHmac("sha256", secret).update(`${orgId}\n${userId}`).digest("hex")
}

async function call(
  method: string,
  path: string,
  identity: { orgId?: string; userId?: string },
  body?: unknown
): Promise<{ status: number; payload: any }> {
  const cfg = config()
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey}`,
    "Content-Type": "application/json",
  }
  if (identity.orgId) headers["x-org-id"] = identity.orgId
  if (identity.userId) headers["x-user-id"] = identity.userId
  headers["x-identity-hmac"] = identityHmac(
    cfg.idvSecret,
    identity.orgId ?? "",
    identity.userId ?? ""
  )

  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await res.json().catch(() => null)
  return { status: res.status, payload }
}

/**
 * Make sure a fastn customer exists for `orgId`. Looks it up first (GET accepts
 * our external id), and creates it only on 404, so a re-run never depends on
 * how fastn answers a duplicate create.
 */
export async function ensureCustomer(orgId: string, name: string): Promise<void> {
  const who = { userId: PROVISIONER_USER_ID }
  const found = await call("GET", `/api/v1/orgs/${encodeURIComponent(orgId)}`, who)
  if (found.status === 200) return
  if (found.status !== 404) {
    throw new FastnError(`GET /orgs/${orgId} returned ${found.status}`, found.status, found.payload)
  }

  // slug must be unique across the account; derive it from our id, not the store name.
  const slug = `medusa-${orgId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
    .slice(0, 50)
    .replace(/-+$/, "")
  const created = await call("POST", "/api/v1/orgs", who, { name, orgId, slug })
  if (created.status !== 200 && created.status !== 201) {
    throw new FastnError(`POST /orgs returned ${created.status}`, created.status, created.payload)
  }
}

/**
 * Push one of our product's events to fastn (Medusa connector's ingest URL).
 * Authenticated with the fastn API key; the store is named by x-org-id and
 * proven with the identity HMAC, so fastn routes it to that customer only.
 */
export async function sendEvent(input: {
  orgId: string
  event: string
  data: Record<string, unknown>
  idempotencyKey?: string
}): Promise<{ status: number; payload: any }> {
  const cfg = config()
  const url = process.env.FASTN_EVENTS_URL
  if (!url) throw new FastnError("Missing environment variable(s): FASTN_EVENTS_URL")

  const userId = PROVISIONER_USER_ID
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-fastn-access-key": cfg.apiKey,
    "x-org-id": input.orgId,
    "x-user-id": userId,
    "x-identity-hmac": identityHmac(cfg.idvSecret, input.orgId, userId),
  }
  if (input.idempotencyKey) headers["idempotency-key"] = input.idempotencyKey

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      event: input.event,
      store_id: input.orgId,
      occurred_at: new Date().toISOString(),
      data: input.data,
    }),
  })
  const payload = await res.json().catch(() => null)
  if (res.status >= 300) {
    throw new FastnError(`event ${input.event} returned ${res.status}`, res.status, payload)
  }
  return { status: res.status, payload }
}

/** Mint a short-lived embed token scoped to one customer and one end user. */
export async function mintEmbedToken(input: {
  orgId: string
  userId: string
  userEmail?: string
  userName?: string
}): Promise<{ token: string; expiresIn?: number }> {
  const body: Record<string, string> = { orgId: input.orgId, userId: input.userId }
  if (input.userEmail) body.userEmail = input.userEmail
  if (input.userName) body.userName = input.userName.slice(0, 200)

  const res = await call(
    "POST",
    "/api/v1/embed/token",
    { orgId: input.orgId, userId: input.userId },
    body
  )
  const token = res.payload?.data?.token
  if (res.status !== 200 || !token) {
    throw new FastnError(`POST /embed/token returned ${res.status}`, res.status, res.payload)
  }
  return { token, expiresIn: res.payload.data.expiresIn }
}
