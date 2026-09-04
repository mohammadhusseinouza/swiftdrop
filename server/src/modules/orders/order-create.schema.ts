import { z } from "zod";
import { OrderTypeSchema, PaymentTypeSchema, moneySchema, optionalMoneySchema } from "./order-financial.schema";
import { projectAmountToCollect } from "./order-financial.service";

// Reusable foundation for the future POST /api/v1/orders body (Phase 6.2).
// NOT wired to any route yet — no HTTP layer exists for Orders in this
// phase, and this schema alone does not create anything.
//
// Only real orders.* columns are represented. Deliberately EXCLUDED because
// they are always server-derived and must never be accepted as client
// input, regardless of what a request body contains (Zod's default "strip
// unknown keys" behavior already protects against this, same as every
// other Phase 5 create/update schema):
//   id, order_number, tracking_code, status, financial_status,
//   remaining_order_amount, remaining_delivery_fee, amount_to_collect,
//   actual_amount_collected, collection_difference_reason,
//   needs_financial_review, current_driver_id, assigned_at/picked_up_at/
//   out_for_delivery_at/delivered_at/cancelled_at, created_by_id (from
//   req.actor, not the body), created_at, updated_at.
//
// APPROVED (Phase 6.1 cleanup) identifier-generation convention for
// order_number / tracking_code — documented here for Phase 6.2, NOT
// implemented yet (no generator/persistence in this phase):
//   order_number:  ORD-YYYYMMDD-XXXXXX   (<= varchar(50))
//   tracking_code: TRK-XXXXXXXXXXXX      (<= varchar(100))
//   where X is cryptographically-random uppercase alphanumeric data.
//   Both are server-generated only — never client input. The database
//   unique constraint remains the authoritative guard; a generation
//   collision must be handled by retrying with a fresh random suffix, never
//   by SELECT MAX(...) + 1 (which is unsafe under concurrent inserts).
//
// APPROVED (Phase 6.1 cleanup) receiver-area design for Phase 6.2:
//   receiverAreaId is REQUIRED client input. orders.receiver_area (the
//   NOT NULL free-text snapshot column) is NOT independently accepted from
//   the client here — Phase 6.2's service must load the selected Area by
//   receiverAreaId and derive receiver_area_id / receiver_area from that
//   loaded row (id + name snapshot) itself, never trust client-supplied
//   free text for it.
//
// APPROVED (Phase 6.1 cleanup) active-reference rule for Phase 6.2: a new
// Order may reference only an ACTIVE Area (receiverAreaId) and ACTIVE
// Payment Methods (prepaidPaymentMethodId, collectionPaymentMethodId) —
// this schema only validates UUID format (it has no DB access); Phase 6.2's
// service must perform the existence + is_active check. Deactivating an
// Area/Payment Method later must NOT affect any historical Order that
// already referenced it.
//
// Field length limits below match the real varchar(N) constraints in
// prisma/schema.prisma exactly — no limit is invented for description,
// receiver_instructions, or package_notes, which are unbounded `text`
// columns in the approved schema.
export const OrderCreateFoundationSchema = z
  .object({
    customerId: z.string().uuid(),
    orderType: OrderTypeSchema,
    paymentType: PaymentTypeSchema,

    // Receiver snapshot — NOT a Customer relationship (CLAUDE.md §11).
    receiverName: z.string().trim().min(1, "Receiver name is required").max(200),
    receiverPhone: z.string().trim().min(1, "Receiver phone is required").max(30),
    receiverAltPhone: z.string().trim().min(1).max(30).optional(),
    receiverAreaId: z.string().uuid("Receiver area is required"),
    receiverAddress: z.string().trim().min(1, "Receiver address is required").max(500),
    receiverBuildingFloor: z.string().trim().min(1).max(200).optional(),
    receiverMapLink: z.string().trim().min(1).max(1000).optional(),
    receiverInstructions: z.string().trim().min(1).optional(),

    // Package information (orders.description is required; weight/size are
    // explicitly optional for V1 per requirements.md §6.4).
    description: z.string().trim().min(1, "Description is required"),
    packageCount: z.number().int().min(1).optional(),
    quantity: z.number().int().min(0).optional(),
    weightKg: z.coerce.number().min(0).optional(),
    packageNotes: z.string().trim().min(1).optional(),

    // Financial input — see order-financial.schema.ts for the money
    // parsing/validation rules. remainingOrderAmount/remainingDeliveryFee/
    // amountToCollect are always derived server-side
    // (order-financial.service.ts), never accepted here.
    orderAmount: moneySchema,
    deliveryFee: moneySchema,
    prepaidOrderAmount: optionalMoneySchema,
    prepaidDeliveryFee: optionalMoneySchema,

    // Payment methods. prepaidPaymentMethodId covers money already paid at
    // creation time; collectionPaymentMethodId is the EXPECTED/PLANNED
    // delivery-time collection method — the Driver Workflow phase may later
    // confirm or change it to the actual method used. Both are independent
    // per requirements.md §9 ("the pre-paid amount and the delivery-time
    // payment [may] use different payment methods"). See the superRefine
    // below for the required/absent rules tied to each amount.
    prepaidPaymentMethodId: z.string().uuid().nullable().optional(),
    collectionPaymentMethodId: z.string().uuid().nullable().optional(),

    // ---- Parcel Intake (Phase 11.17.4) ----
    // parcelIntakeMethod is OPTIONAL only for temporary backward compatibility
    // with the not-yet-updated frontend: the SERVICE resolves an omitted value
    // to ALREADY_AT_COMPANY (never DRIVER_COLLECTION). Phase 11.17.5 makes the
    // frontend send it explicitly.
    parcelIntakeMethod: z.enum(["ALREADY_AT_COMPANY", "DRIVER_COLLECTION"]).optional(),

    // The Parcel Collection driver (DRIVER_COLLECTION only). A DISTINCT field
    // from deliveryDriverId — the two are never conflated. Requires orders.assign
    // in addition to orders.create (enforced in the controller).
    parcelCollectionDriverId: z.string().uuid().nullable().optional(),

    // The final Delivery driver ("Create & Assign"). Allowed only when the
    // parcel is already at the company (DRIVER_COLLECTION -> rejected — the
    // parcel has not reached the company yet). Also requires orders.assign.
    deliveryDriverId: z.string().uuid().nullable().optional(),

    // Optional Parcel Collection snapshot overrides (DRIVER_COLLECTION only).
    // Anything omitted is derived from the selected Customer's saved data.
    // Lengths match the orders.* varchar(N) columns.
    parcelCollectionContactName: z.string().trim().min(1).max(200).optional(),
    parcelCollectionPhone: z.string().trim().min(1).max(30).optional(),
    parcelCollectionAltPhone: z.string().trim().min(1).max(30).optional(),
    parcelCollectionAreaId: z.string().uuid().optional(),
    parcelCollectionAddress: z.string().trim().min(1).max(500).optional(),
    parcelCollectionNotes: z.string().trim().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    // ---- Parcel Intake combination rules (Phase 11.17.4) ----
    const intake = data.parcelIntakeMethod ?? "ALREADY_AT_COMPANY";
    const hasCollectionDriver = data.parcelCollectionDriverId !== undefined && data.parcelCollectionDriverId !== null;
    const hasDeliveryDriver = data.deliveryDriverId !== undefined && data.deliveryDriverId !== null;
    const snapshotKeys = [
      "parcelCollectionContactName",
      "parcelCollectionPhone",
      "parcelCollectionAltPhone",
      "parcelCollectionAreaId",
      "parcelCollectionAddress",
      "parcelCollectionNotes",
    ] as const;

    if (intake === "ALREADY_AT_COMPANY") {
      if (hasCollectionDriver) {
        ctx.addIssue({
          code: "custom",
          path: ["parcelCollectionDriverId"],
          message: "A collection driver cannot be set when the parcel is already at the company",
        });
      }
      for (const key of snapshotKeys) {
        if (data[key] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "Parcel collection details apply only to DRIVER_COLLECTION orders",
          });
        }
      }
    }

    if (intake === "DRIVER_COLLECTION" && hasDeliveryDriver) {
      ctx.addIssue({
        code: "custom",
        path: ["deliveryDriverId"],
        message: "A delivery driver cannot be assigned until the parcel has been received at the company",
      });
    }
    const hasPrepaidMethod = data.prepaidPaymentMethodId !== undefined && data.prepaidPaymentMethodId !== null;
    const prepaidTotal = data.prepaidOrderAmount.plus(data.prepaidDeliveryFee);

    if (prepaidTotal.greaterThan(0) && !hasPrepaidMethod) {
      ctx.addIssue({
        code: "custom",
        path: ["prepaidPaymentMethodId"],
        message: "prepaidPaymentMethodId is required when a prepaid amount is provided",
      });
    }
    if (prepaidTotal.isZero() && hasPrepaidMethod) {
      ctx.addIssue({
        code: "custom",
        path: ["prepaidPaymentMethodId"],
        message: "prepaidPaymentMethodId must not be provided when nothing is prepaid",
      });
    }

    // Derived, never trusted from client input — see projectAmountToCollect.
    const amountToCollect = projectAmountToCollect(
      data.orderAmount,
      data.deliveryFee,
      data.prepaidOrderAmount,
      data.prepaidDeliveryFee
    );
    const hasCollectionMethod = data.collectionPaymentMethodId !== undefined && data.collectionPaymentMethodId !== null;

    if (amountToCollect.greaterThan(0) && !hasCollectionMethod) {
      ctx.addIssue({
        code: "custom",
        path: ["collectionPaymentMethodId"],
        message: "collectionPaymentMethodId is required when an amount remains to be collected",
      });
    }
    if (amountToCollect.lessThanOrEqualTo(0) && hasCollectionMethod) {
      ctx.addIssue({
        code: "custom",
        path: ["collectionPaymentMethodId"],
        message: "collectionPaymentMethodId must not be provided when nothing remains to be collected",
      });
    }
  });

export type OrderCreateFoundationInput = z.infer<typeof OrderCreateFoundationSchema>;
