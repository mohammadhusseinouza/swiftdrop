export interface CustomerAreaSummary {
  id: string;
  name: string;
}

export interface CustomerSummary {
  id: string;
  customerNumber: string;
  name: string;
  primaryPhone: string;
  secondaryPhone: string | null;
  email: string | null;
  defaultAddress: string | null;
  area: CustomerAreaSummary | null;
  hasPortalAccount: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerWalletSummary {
  availableBalance: string;
}

export interface CustomerDetail extends CustomerSummary {
  notes: string | null;
  wallet: CustomerWalletSummary | null;
}
