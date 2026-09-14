import { z } from "zod";

// GET /api/v1/customer/me/orders (Phase 13.2).
//
// `view` is the only filter (task §19) — the three Customer-meaningful
// buckets that mirror the Phase 13.1 Dashboard's own metrics:
//   all       — every order this Customer owns
//   active    — status ∈ ORDER_ACTIVE_STATUSES (the shared non-terminal set)
//   delivered — status = DELIVERED
// No Management-style advanced filters (status/driver/area/date/…) — not in
// docs/page_structure.md §34 for this page.
//
// page / limit follow the repository convention (default 20, max 100 —
// identical to ListDriverJobsQuerySchema).
export const CustomerOrderViewSchema = z.enum(["all", "active", "delivered"]);

export const ListCustomerOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  view: CustomerOrderViewSchema.optional().default("all"),
});

export type CustomerOrderView = z.infer<typeof CustomerOrderViewSchema>;
export type ListCustomerOrdersQuery = z.infer<typeof ListCustomerOrdersQuerySchema>;

// GET /api/v1/customer/me/orders/:id (Phase 13.3). A non-UUID id fails here
// and reaches the client as the standard 400 VALIDATION_ERROR — it never
// touches the database.
export const CustomerOrderIdParamSchema = z.object({
  id: z.string().uuid(),
});

export type CustomerOrderIdParam = z.infer<typeof CustomerOrderIdParamSchema>;
