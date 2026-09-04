import { Prisma } from "../../generated/prisma/client";
import type { system_settings, users } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { createAuditLog } from "../../shared/audit/audit.service";
import type { UpdateSettingInput } from "./setting.schema";
import type { SettingSummary } from "./setting.types";

const REDACTED = "[redacted]";

type SettingWithUpdatedBy = system_settings & { users: users | null };

// No approved sensitive-setting catalog exists (the table is currently
// empty). This is a defensive classifier only, so a future secret-like key
// (e.g. "smtp_password", "jwt_secret", "payment_gateway_api_key") is never
// casually exposed through this generic API before an approved handling
// policy exists for it.
const SENSITIVE_KEY_PATTERN = /password|secret|token|api[_-]?key|database[_-]?url|credential/i;

export function isSensitiveSettingKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function toSettingSummary(setting: SettingWithUpdatedBy): SettingSummary {
  const sensitive = isSensitiveSettingKey(setting.key);

  return {
    id: setting.id,
    key: setting.key,
    value: sensitive ? null : setting.value,
    isSensitive: sensitive,
    description: setting.description,
    updatedBy: setting.users
      ? { id: setting.users.id, firstName: setting.users.first_name, lastName: setting.users.last_name }
      : null,
    createdAt: setting.created_at.toISOString(),
    updatedAt: setting.updated_at.toISOString(),
  };
}

function handleKnownSettingError(error: unknown, fallbackMessage: string): never {
  if (error instanceof AppError) {
    throw error;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2025") {
      throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Setting not found" });
    }
  }

  throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: fallbackMessage });
}

export async function listSettings(): Promise<SettingSummary[]> {
  const rows = await prisma.system_settings.findMany({
    include: { users: true },
    orderBy: { key: "asc" },
  });

  return rows.map(toSettingSummary);
}

export async function getSettingByKey(key: string): Promise<SettingSummary> {
  const setting = await prisma.system_settings.findUnique({
    where: { key },
    include: { users: true },
  });

  if (!setting) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Setting not found" });
  }

  return toSettingSummary(setting);
}

// Updates an EXISTING setting only — there is no approved creation workflow
// or key catalog, so this never upserts a new row (CLAUDE.md §62/§29:
// no undocumented business identifiers invented as a side effect).
export async function updateSettingByKey(
  key: string,
  input: UpdateSettingInput,
  actorUserId: string
): Promise<SettingSummary> {
  try {
    const setting = await prisma.$transaction(async (tx) => {
      const existing = await tx.system_settings.findUnique({ where: { key } });
      if (!existing) {
        throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Setting not found" });
      }

      const updated = await tx.system_settings.update({
        where: { key },
        data: {
          ...(input.value !== undefined
            ? { value: (input.value === null ? Prisma.JsonNull : input.value) as Prisma.InputJsonValue }
            : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          updated_by_id: actorUserId,
          updated_at: new Date(),
        },
        include: { users: true },
      });

      // Traceable configuration change (Phase 11.16). A sensitive-looking key
      // NEVER has its real previous/new value recorded in audit — only a
      // "[redacted]" marker (§39). Non-sensitive values are recorded verbatim
      // so the change is reviewable.
      const sensitive = isSensitiveSettingKey(key);
      const previousValues: Record<string, unknown> = {};
      const newValues: Record<string, unknown> = {};
      if (input.value !== undefined) {
        previousValues.value = sensitive ? REDACTED : (existing.value as unknown);
        newValues.value = sensitive ? REDACTED : (input.value as unknown);
      }
      if (input.description !== undefined && input.description !== existing.description) {
        previousValues.description = existing.description;
        newValues.description = input.description;
      }

      if (Object.keys(newValues).length > 0) {
        await createAuditLog(tx, {
          actorUserId,
          action: "SYSTEM_SETTING_UPDATED",
          entityType: "SYSTEM_SETTING",
          entityId: key,
          previousValues: previousValues as Prisma.InputJsonValue,
          newValues: newValues as Prisma.InputJsonValue,
          metadata: { key, isSensitive: sensitive },
        });
      }

      return updated;
    });

    return toSettingSummary(setting as SettingWithUpdatedBy);
  } catch (error) {
    handleKnownSettingError(error, "Failed to update setting");
  }
}
