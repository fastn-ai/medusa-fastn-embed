import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { FastnError, sendEvent } from "../lib/fastn"

/**
 * Sends Medusa's customer.created event to fastn, which runs the store's
 * integrations (e.g. HubSpot: create or update a contact). One direction only:
 * fastn never calls back into Medusa.
 */
export default async function fastnCustomerCreated({
  event,
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  try {
    const { data: stores } = await query.graph({ entity: "store", fields: ["id", "metadata"] })
    const store = stores[0]
    // The store becomes a fastn customer the first time an admin opens
    // Settings > Integrations. Before that it has no integrations to run.
    if (!store?.metadata?.fastn_registered_at) {
      logger.info("fastn: store not registered with fastn yet; customer.created not sent")
      return
    }

    const { data: customers } = await query.graph({
      entity: "customer",
      fields: [
        "id",
        "email",
        "first_name",
        "last_name",
        "phone",
        "company_name",
        "has_account",
        "metadata",
        "created_at",
        "updated_at",
      ],
      filters: { id: event.data.id },
    })
    const customer = customers[0]
    if (!customer) {
      logger.warn(`fastn: customer ${event.data.id} not found; customer.created not sent`)
      return
    }

    await sendEvent({
      orgId: store.id,
      event: "customer.created",
      data: { customer },
      idempotencyKey: `customer.created:${customer.id}`,
    })
    logger.info(`fastn: customer.created sent for ${customer.id}`)
  } catch (e) {
    const err = e as FastnError
    logger.error(
      `fastn: customer.created not delivered: ${err.message}${err.detail ? ` ${JSON.stringify(err.detail)}` : ""}`
    )
  }
}

export const config: SubscriberConfig = {
  event: "customer.created",
}
