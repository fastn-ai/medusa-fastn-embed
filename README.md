# Medusa + fastn embed

A [Medusa v2](https://docs.medusajs.com) store with [fastn](https://fastn.ai) embedded, acting as a SaaS product that offers integrations to its merchants. It is Medusa's open-source [medusa-starter-default](https://github.com/medusajs/medusa-starter-default) (v2.18, full history kept) plus the changes listed below. Medusa's own packages are not modified.

It adds two things:

1. **The fastn widget in the Medusa admin.** Settings > Integrations shows fastn's integrations hub, where a merchant connects apps such as HubSpot and Slack, configures field mappings and sees runs.
2. **Medusa events pushed to fastn.** When a customer is created in Medusa, the backend sends a `customer.created` event to fastn, which runs the merchant's integrations, for example creating or updating the contact in the merchant's own HubSpot.

Data flows one way: Medusa to fastn to the third-party app. fastn never calls back into Medusa, so the store does not need to be reachable from the internet.

## How it works

### Widget (Settings > Integrations)

```
Browser (Medusa admin)                 Medusa backend                          fastn
------------------------------        ------------------------------         ------------------------
Integrations page  --POST /admin/fastn/embed-token-->  route.ts
                                       first use: register the store  --->  POST /api/v1/orgs
                                       every load: mint a token       --->  POST /api/v1/embed/token
                   <-- { token, baseUrl } --
FastnHub (iframe) ---------------------------------------------------->  /v1/embed/iframe?token=...
```

- Each **Medusa store** is one fastn customer. Its fastn id (`orgId`) is the store id, and the store name is the customer name.
- Each **signed-in admin user** gets their own embed session (a short-lived token, 8 hours).
- The API key and the identity verification secret stay on the backend. The browser only ever receives the embed token.

### Events (customer.created)

```
Medusa  customer.created  -->  src/subscribers/fastn-customer-created.ts
                               POST FASTN_EVENTS_URL
                               headers: x-fastn-access-key, x-org-id (store id), x-user-id, x-identity-hmac
                               body:    { event, store_id, occurred_at, data: { customer } }
                                        |
fastn   Medusa connector (APP webhook config: eventKey "event", require API key, end-org routing)
        --> the store's trigger --> workflow "Medusa customer to HubSpot contact"
        --> HubSpot batch upsert by email, on the store's own HubSpot connection
```

fastn only accepts these events from callers holding the account's fastn API key, and routes each one to the merchant named by the identity-verified `x-org-id`. An event for a store that is not a fastn customer of the account is refused.

## What changed

### New files

| File | What it does |
|---|---|
| `src/lib/fastn.ts` | Backend-only fastn client. Reads `FASTN_API_KEY` and `FASTN_IDV_SECRET` from the environment, signs every call with the identity headers, registers a store as a fastn customer (looks it up first and creates it only if missing), mints embed tokens, and sends Medusa events to fastn (`sendEvent`). |
| `src/api/admin/fastn/embed-token/route.ts` | `POST /admin/fastn/embed-token`, for signed-in admin users only. Registers the store with fastn on first use, records `fastn_registered_at` in the store's metadata, mints a token for the signed-in admin, and returns only `{ token, expiresIn, orgId, baseUrl }`. fastn errors are logged on the server (`fastn:` lines) and never sent to the browser. |
| `src/admin/routes/settings/integrations/page.tsx` | Adds **Settings > Integrations** to the Medusa admin. Gets a token from the route above and renders the hub with `FastnHub` from `@fastn-ai/embed/react` (an iframe), with loading and retry states. The hub's `getToken` reuses the first token, then fetches a fresh one when the session expires. |
| `src/admin/lib/sdk.ts` | Medusa JS SDK client with session auth, used by the page to call the backend. |
| `src/subscribers/fastn-customer-created.ts` | Subscribes to Medusa's `customer.created`, loads the customer and sends it to fastn with `sendEvent`. Skips stores that have not been registered with fastn yet (an admin has not opened Settings > Integrations). Uses `customer.created:<customer id>` as the idempotency key. |

### Changed files

| File | Change |
|---|---|
| `package.json` | Adds `@fastn-ai/embed` (^0.8.0), `@medusajs/js-sdk` (2.18.0), `@medusajs/ui` (4.2.0) and `@medusajs/icons` (2.18.0), pinned to the versions Medusa's admin uses. |
| `package-lock.json` | New: the npm lock file for the install above. |
| `.env.template` | Adds `FASTN_API_KEY`, `FASTN_IDV_SECRET`, `FASTN_BASE_URL` and `FASTN_EVENTS_URL`. |
| `README.md` | This file. |

`yarn.lock` is Medusa's original and does not include the new packages. Install with npm (below).

## fastn API details the code relies on

These differ from some earlier guidance, so they are worth knowing if you port the code:

- Authenticate with `Authorization: Bearer <FASTN_API_KEY>`.
- When the key requires identity verification, every call carries `x-user-id` and `x-identity-hmac`, and `x-org-id` when acting for a customer. The HMAC is the hex HMAC-SHA256 of `"<x-org-id>\n<x-user-id>"` signed with the identity secret; an absent header counts as an empty string. That includes the customer registration call, which has no `x-org-id` yet.
- Register a customer with `POST /api/v1/orgs { name, orgId, slug }`. The code checks `GET /api/v1/orgs/<orgId>` first, so it never depends on how a duplicate create answers.
- Mint the embed token with `POST /api/v1/embed/token`; the token is at `data.token`.
- The hub iframe is served from `/v1/embed/iframe`. `@fastn-ai/embed` builds the URL, so the page never assembles it by hand.

## Setup

### 1. fastn

In the fastn dashboard:

1. Create a live API key with identity verification (the "Add the widget" screen, or Settings > API keys). Keep the key and its identity secret.
2. Add `localhost:9100` (and later your admin's real domain) to the widget's Allowed Origins.
3. For the events: a **Medusa** connector registered as your product, with an APP webhook config for `customer.created` (`eventKey: event`, require API key, end-org routing on `store_id`), a workflow bound to it with an app-event trigger, and both attached to your widget. Its ingest URL has the form:

   ```
   https://webhooks.fastn.dev/prod/triggers/<your org id>/webhooks/<Medusa connector id>/none
   ```

   Use this connector-wide URL. It is the one that enforces the API key; the per-trigger URL fastn shows when a trigger is created does not.

### 2. Medusa

Requirements: Node 20+, PostgreSQL.

```bash
cp .env.template .env        # then fill in the values below
npm install
npx medusa db:migrate
npm run seed                 # optional demo data
npx medusa user -e admin@example.com -p <password>
npm run dev                  # http://localhost:9100/app
```

`.env` values used by this project:

| Variable | Value |
|---|---|
| `PORT` | `9100` (any free port; 9000 is Medusa's default) |
| `DATABASE_URL` | Your Postgres URL |
| `ADMIN_CORS`, `AUTH_CORS` | Include `http://localhost:9100` |
| `FASTN_API_KEY` | The fastn API key. Backend only: never prefix it with `VITE_`. |
| `FASTN_IDV_SECRET` | The key's identity verification secret. Backend only. |
| `FASTN_BASE_URL` | `https://api.fastn.dev` |
| `FASTN_EVENTS_URL` | The Medusa connector's ingest URL from step 1.3 |

`.env` is git-ignored. Restart the server after changing it.

## Try it

1. Open http://localhost:9100/app, sign in, and go to **Settings > Integrations**. The first visit registers the store with fastn.
2. Connect HubSpot in the hub.
3. Go to **Customers > Create** and create a customer with an email you will recognise.
4. In HubSpot, search Contacts for that email: one contact with the same first name, last name, phone and company. Creating another Medusa customer with an email that already exists in HubSpot updates that contact instead of duplicating it.
5. The run shows in the hub under the HubSpot integration (Activity), and in the fastn dashboard under the workflow's executions.

If nothing arrives, the Medusa log has a `fastn: customer.created sent for cus_...` or `fastn: customer.created not delivered: ...` line with the reason.

## Notes

- Rotate the API key and identity secret before going live if they were ever pasted anywhere outside the backend environment. Only `.env` changes; no code changes are needed.
- Merchants change the HubSpot field mapping in the hub (HubSpot > Manage > Installations > Configuration). The workflow reads the merchant's own copy at run time, falling back to the default mapping.
- Deleting a customer in Medusa does not delete the HubSpot contact; only `customer.created` is sent.
- The original Medusa starter README is in [medusajs/medusa-starter-default](https://github.com/medusajs/medusa-starter-default).
