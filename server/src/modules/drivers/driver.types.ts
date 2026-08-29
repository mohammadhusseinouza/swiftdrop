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

// Current-balance-only summary. The transaction ledger is out of scope for
// Phase 5.2 (deferred to Phase 8 — Financial Engine).
export interface DriverCashAccountSummary {
  currentBalance: string;
}

export interface DriverSummary {
  id: string;
  driverNumber: string;
  isActive: boolean;
  user: DriverUserSummary;
  createdAt: string;
  updatedAt: string;
}

export interface DriverDetail extends DriverSummary {
  cashAccount: DriverCashAccountSummary | null;
}
