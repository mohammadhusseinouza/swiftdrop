// Safe subset of the linked User's identity fields — never password_hash,
// role, sessions, or tokens. A Driver record has no name/phone/vehicle
// columns of its own in the approved schema; that contact information lives
// entirely on the linked User.
export interface DriverUserSummary {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  isActive: boolean;
}

// ============================================================
// Operational summary (Phase 11.7 correction) — authoritative server-side
// counts, identical semantics in the list and the detail DTO. The client
// never counts orders.
//
//   activeOrders    current_driver_id = driver  AND  status IN
//                   ORDER_ACTIVE_STATUSES  (CURRENT held work only — a
//                   historical assignment that was later reassigned away
//                   does not count).
//   outForDelivery  current_driver_id = driver  AND  status =
//                   OUT_FOR_DELIVERY.
//   completedToday  successful delivery ATTEMPTS (delivery_attempts.
//                   driver_id, outcome DELIVERED) with completed_at in the
//                   current UTC day — historical attribution, so a later
//                   reassignment can never move the credit.
// ============================================================
export interface DriverOperationalSummary {
  activeOrders: number;
  outForDelivery: number;
  completedToday: number;
}

export interface DriverSummary {
  id: string;
  driverNumber: string;
  isActive: boolean;
  user: DriverUserSummary;
  operationalSummary: DriverOperationalSummary;
  createdAt: string;
  updatedAt: string;
}

// The generic Driver detail DTO carries management-safe operational/profile
// data ONLY. Cash balance and the cash ledger were removed here in the Phase
// 11.7 correction — they now live behind finance.read at
// GET /api/v1/finance/driver-cash/:driverId(/transactions). drivers.read is
// never a bypass around finance permissions.
export type DriverDetail = DriverSummary;
