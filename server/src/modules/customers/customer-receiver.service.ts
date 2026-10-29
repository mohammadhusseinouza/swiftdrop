import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { normalizeReceiverPhone, receiverPhoneSearchDigits } from "../../shared/phone/receiver-phone";
import type { ListCustomerReceiversQuery } from "./customer.schema";
import type { CustomerReceiverSuggestion } from "./customer.types";

// Customer Receiver Memory. A saved receiver is identified by
// (customer_id, normalized_phone) and only ever written through
// rememberCustomerReceiverTx() from inside the order create / edit
// transactions — there is no receiver CRUD API. Orders never read from
// customer_receivers: their receiver_* snapshot columns stay authoritative.

/** Optional receiver fields a deliberate edit may clear on the saved receiver. */
export interface ClearedReceiverFields {
  alternativePhone: boolean;
  buildingFloor: boolean;
  mapLink: boolean;
  instructions: boolean;
}

export interface RememberCustomerReceiverInput {
  customerId: string;
  name: string;
  phone: string;
  alternativePhone: string | null;
  areaId: string | null;
  address: string;
  buildingFloor: string | null;
  mapLink: string | null;
  instructions: string | null;
  /**
   * Update rule for the optional fields of an EXISTING saved receiver:
   *   value present  -> replaces the saved value;
   *   value null     -> keeps the saved value, unless the field is flagged
   *                     here as deliberately cleared, which sets it to NULL.
   * Name, phone and address are required and always take the latest value.
   * The area is never cleared (a blank area is not a valid order).
   */
  cleared?: Partial<ClearedReceiverFields>;
}

/**
 * Create or update the saved receiver for (customer, normalized phone).
 *
 * A single INSERT ... ON CONFLICT statement on the unique
 * (customer_id, normalized_phone) index: concurrent order creations for the
 * same receiver can never produce duplicates or a P2002, and because it runs
 * on the caller's transaction it is rolled back with a failed order write.
 *
 * Returns false (and writes nothing) when the phone cannot be normalized
 * safely — receiver memory is skipped rather than risking a false match.
 */
export async function rememberCustomerReceiverTx(
  tx: Prisma.TransactionClient,
  input: RememberCustomerReceiverInput
): Promise<boolean> {
  const normalizedPhone = normalizeReceiverPhone(input.phone);
  if (!normalizedPhone) return false;

  const cleared = input.cleared ?? {};
  await tx.$executeRaw`
    INSERT INTO customer_receivers (
      customer_id, name, phone, normalized_phone, alternative_phone, area_id,
      address, building_floor, map_link, instructions
    ) VALUES (
      ${input.customerId}::uuid, ${input.name}, ${input.phone}, ${normalizedPhone},
      ${input.alternativePhone}, ${input.areaId}::uuid, ${input.address},
      ${input.buildingFloor}, ${input.mapLink}, ${input.instructions}
    )
    ON CONFLICT (customer_id, normalized_phone) DO UPDATE SET
      name = EXCLUDED.name,
      phone = EXCLUDED.phone,
      address = EXCLUDED.address,
      area_id = COALESCE(EXCLUDED.area_id, customer_receivers.area_id),
      alternative_phone = CASE WHEN ${cleared.alternativePhone === true}::boolean THEN NULL
        ELSE COALESCE(EXCLUDED.alternative_phone, customer_receivers.alternative_phone) END,
      building_floor = CASE WHEN ${cleared.buildingFloor === true}::boolean THEN NULL
        ELSE COALESCE(EXCLUDED.building_floor, customer_receivers.building_floor) END,
      map_link = CASE WHEN ${cleared.mapLink === true}::boolean THEN NULL
        ELSE COALESCE(EXCLUDED.map_link, customer_receivers.map_link) END,
      instructions = CASE WHEN ${cleared.instructions === true}::boolean THEN NULL
        ELSE COALESCE(EXCLUDED.instructions, customer_receivers.instructions) END,
      updated_at = CURRENT_TIMESTAMP
  `;
  return true;
}

function toSuggestion(
  row: Prisma.customer_receiversGetPayload<{ include: { areas: { select: { id: true; name: true; is_active: true } } } }>
): CustomerReceiverSuggestion {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    alternativePhone: row.alternative_phone,
    area: row.areas ? { id: row.areas.id, name: row.areas.name, isActive: row.areas.is_active } : null,
    address: row.address,
    buildingFloor: row.building_floor,
    mapLink: row.map_link,
    instructions: row.instructions,
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface ListCustomerReceiversResult {
  items: CustomerReceiverSuggestion[];
  total: number;
}

/**
 * Autocomplete lookup — always scoped to ONE customer on the server, bounded
 * by `limit`, most recently used first. Matches a partial name, the phone as
 * typed, or the phone digits against the normalized key (so "03 123" finds a
 * receiver saved as "+961 3 123456").
 */
export async function listCustomerReceivers(
  customerId: string,
  query: ListCustomerReceiversQuery
): Promise<ListCustomerReceiversResult> {
  const customer = await prisma.customers.findUnique({ where: { id: customerId }, select: { id: true } });
  if (!customer) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Customer not found" });
  }

  const where: Prisma.customer_receiversWhereInput = { customer_id: customerId };
  if (query.search) {
    const or: Prisma.customer_receiversWhereInput[] = [
      { name: { contains: query.search, mode: "insensitive" } },
      { phone: { contains: query.search } },
    ];
    const digits = receiverPhoneSearchDigits(query.search);
    if (digits) or.push({ normalized_phone: { contains: digits } });
    where.OR = or;
  }

  const [rows, total] = await Promise.all([
    prisma.customer_receivers.findMany({
      where,
      include: { areas: { select: { id: true, name: true, is_active: true } } },
      orderBy: [{ updated_at: "desc" }, { id: "asc" }],
      take: query.limit,
    }),
    prisma.customer_receivers.count({ where }),
  ]);

  return { items: rows.map(toSuggestion), total };
}
