export interface SettingUpdatedBySummary {
  id: string;
  firstName: string;
  lastName: string;
}

export interface SettingSummary {
  id: string;
  key: string;
  // Redacted (null) when the key matches a sensitive-looking pattern — see
  // isSensitiveSettingKey in setting.service.ts. This API must never be a
  // path through which a secret-like value leaks, even if one is ever
  // stored here.
  value: unknown;
  isSensitive: boolean;
  description: string | null;
  updatedBy: SettingUpdatedBySummary | null;
  createdAt: string;
  updatedAt: string;
}
