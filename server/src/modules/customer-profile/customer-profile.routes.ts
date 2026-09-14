import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { requirePortal } from "../../middleware/require-portal";
import { getCustomerProfileController } from "./customer-profile.controller";

// ============================================================
// Phase 13.7 — Customer Profile (self-scoped, read-only).
//
// Mounted at /api/v1/customer/me (see src/routes/index.ts) — the same
// own-scope namespace as the Phase 13.1 Dashboard / 13.2 Orders / 13.4
// Wallet / 13.6 Payouts routes.
//
// GUARD ORDER: authenticate -> requirePortal("customer") -> authorize(perm)
// -> (controller) self-scoped Customer lookup. requirePortal denies a
// Management/Driver role with a clean 403 BEFORE the Customer/profile/area
// lookup runs, so an ADMIN (who holds customer.profile.read_own in the full
// permission catalog) never reaches the profile lookup and never sees a
// misleading "no customer profile" message or any Prisma/relation text
// (task §7 / §8 / §47).
//
// PERMISSION: the existing catalog permission customer.profile.read_own
// (already assigned to the CUSTOMER role — see auth.me.test.ts). NO new
// permission was added — the catalog stays at 35 (task §6 / §71).
//
// READ-ONLY: there is deliberately NO PATCH/PUT/POST profile route. The
// permission catalog also contains `customer.profile.update_own`, but no
// approved V1 business rule in /docs defines what a Customer may self-edit
// or how (page_structure.md §39 explicitly says profile fields "may be
// editable later"). Adding a mutation would mean inventing that rule, which
// CLAUDE.md §62 forbids — flagged for human decision, not implemented here
// (task §4 / §27).
// ============================================================
export const customerProfileRouter = Router();

customerProfileRouter.get(
  "/profile",
  authenticate,
  requirePortal("customer"),
  authorize("customer.profile.read_own"),
  getCustomerProfileController
);
