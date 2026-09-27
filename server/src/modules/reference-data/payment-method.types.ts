export interface PaymentMethodSummary {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
  bypassDriverCash: boolean;
  createdAt: string;
  updatedAt: string;
}

// GET /api/v1/driver/payment-methods — active methods only, no Management
// metadata. Mirrors DriverFailedDeliveryReasonSummary's narrow-DTO
// convention (failed-delivery-reason.types.ts).
export interface DriverPaymentMethodSummary {
  id: string;
  code: string;
  name: string;
}
