import "../config/load-env";
import { prisma } from "../db/prisma";
import { hashPassword } from "../modules/auth/auth.utils";
import { AppError } from "../shared/errors/app-error";

/**
 * DEVELOPMENT-ONLY visual acceptance seed users.
 *
 * Creates deterministic, idempotent accounts so the SwiftDrop UI can be
 * reviewed under every role. Run with:  npm run seed:visual
 *
 * SAFETY:
 *   - refuses to run when NODE_ENV=production (explicit check — NOT just the
 *     .test email domain)
 *   - only ever touches the fixed *@swiftdrop.test fixtures below
 *   - re-running resets ONLY these fixtures' password / names / active flag to
 *     the documented values; it never edits any other user
 *   - permissions come from the existing approved role catalog (never assigned
 *     directly here); no schema changes, no migration, no data reset
 *
 * Common password for all fixtures:  VisualTest123!
 * These credentials are for developers/testers only — never surface them in
 * the product UI.
 */

const COMMON_PASSWORD = "VisualTest123!";
/** Clearly-fake development phone; fits users.phone / customers.primary_phone VarChar(30). */
const DEV_PHONE = "+15550000000";

interface VisualUserSpec {
  key: string;
  email: string;
  firstName: string;
  lastName: string;
  roleCode: string;
  isActive: boolean;
  /** Management roles get an employee record (mirrors admin:create). */
  employeeNumber?: string;
  /** DRIVER: linked drivers row + zero-balance driver_cash_accounts. */
  driverNumber?: string;
  /** CUSTOMER: linked customers row (portal_user_id) + zero-balance wallet. */
  customerNumber?: string;
}

const VISUAL_USERS: readonly VisualUserSpec[] = [
  { key: "admin", email: "admin@swiftdrop.test", firstName: "Visual", lastName: "Admin", roleCode: "ADMIN", isActive: true, employeeNumber: "EMP-VISUAL-ADMIN" },
  { key: "dispatcher", email: "dispatcher@swiftdrop.test", firstName: "Visual", lastName: "Dispatcher", roleCode: "DISPATCHER", isActive: true, employeeNumber: "EMP-VISUAL-DISPATCHER" },
  { key: "finance", email: "finance@swiftdrop.test", firstName: "Visual", lastName: "Finance", roleCode: "FINANCE", isActive: true, employeeNumber: "EMP-VISUAL-FINANCE" },
  { key: "driver", email: "driver@swiftdrop.test", firstName: "Visual", lastName: "Driver", roleCode: "DRIVER", isActive: true, driverNumber: "DRV-VISUAL-001" },
  { key: "customer", email: "customer@swiftdrop.test", firstName: "Visual", lastName: "Customer", roleCode: "CUSTOMER", isActive: true, customerNumber: "CUS-VISUAL-001" },
  { key: "inactive", email: "inactive@swiftdrop.test", firstName: "Visual", lastName: "Inactive", roleCode: "DISPATCHER", isActive: false, employeeNumber: "EMP-VISUAL-INACTIVE" },
];

interface SeededRow {
  email: string;
  role: string;
  active: boolean;
  linkedDriver: boolean;
  linkedCustomer: boolean;
  employee: boolean;
}

async function seedUser(
  spec: VisualUserSpec,
  passwordHash: string,
  adminUserId: string | null,
): Promise<SeededRow> {
  const role = await prisma.roles.findUnique({ where: { code: spec.roleCode } });
  if (!role) {
    throw new AppError({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: `Role "${spec.roleCode}" does not exist. Seed the roles/permissions catalog first.`,
    });
  }

  // User — idempotent by unique email. On reseed, reset the fixture's mutable
  // fields to the documented values (explicit development fixtures only).
  const user = await prisma.users.upsert({
    where: { email: spec.email },
    create: {
      email: spec.email,
      password_hash: passwordHash,
      first_name: spec.firstName,
      last_name: spec.lastName,
      phone: spec.driverNumber ? DEV_PHONE : null,
      role_id: role.id,
      is_active: spec.isActive,
    },
    update: {
      password_hash: passwordHash,
      first_name: spec.firstName,
      last_name: spec.lastName,
      role_id: role.id,
      is_active: spec.isActive,
    },
  });

  let linkedDriver = false;
  let linkedCustomer = false;
  let employee = false;

  if (spec.employeeNumber) {
    await prisma.employees.upsert({
      where: { user_id: user.id },
      create: { user_id: user.id, employee_number: spec.employeeNumber },
      update: {},
    });
    employee = true;
  }

  if (spec.driverNumber) {
    const driver = await prisma.drivers.upsert({
      where: { user_id: user.id },
      create: { user_id: user.id, driver_number: spec.driverNumber, is_active: true },
      update: { is_active: true },
    });
    // Every driver requires exactly one zero-balance cash account
    // (drivers.service.ts creates them together). Idempotent by driver_id.
    await prisma.driver_cash_accounts.upsert({
      where: { driver_id: driver.id },
      create: { driver_id: driver.id },
      update: {},
    });
    linkedDriver = true;
  }

  if (spec.customerNumber) {
    if (!adminUserId) {
      throw new AppError({
        statusCode: 500,
        code: "INTERNAL_ERROR",
        message: "The ADMIN visual user must be seeded before the CUSTOMER (needed for customers.created_by_id).",
      });
    }
    const customer = await prisma.customers.upsert({
      where: { portal_user_id: user.id },
      create: {
        portal_user_id: user.id,
        customer_number: spec.customerNumber,
        name: `${spec.firstName} ${spec.lastName}`,
        primary_phone: DEV_PHONE,
        email: spec.email,
        is_active: true,
        created_by_id: adminUserId,
      },
      update: { name: `${spec.firstName} ${spec.lastName}`, is_active: true },
    });
    // Every customer requires exactly one zero-balance wallet
    // (customers.service.ts creates them together). Idempotent by customer_id.
    await prisma.customer_wallets.upsert({
      where: { customer_id: customer.id },
      create: { customer_id: customer.id },
      update: {},
    });
    linkedCustomer = true;
  }

  return {
    email: spec.email,
    role: spec.roleCode,
    active: spec.isActive,
    linkedDriver,
    linkedCustomer,
    employee,
  };
}

async function main(): Promise<void> {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (nodeEnv === "production") {
    console.error(
      "[seed:visual] Refusing to run with NODE_ENV=production. " +
        "Visual acceptance users are for local development / testing only.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`[seed:visual] NODE_ENV=${nodeEnv} — seeding visual acceptance users…`);
  const passwordHash = await hashPassword(COMMON_PASSWORD);

  const rows: SeededRow[] = [];
  let adminUserId: string | null = null;

  for (const spec of VISUAL_USERS) {
    const row = await seedUser(spec, passwordHash, adminUserId);
    if (spec.key === "admin") {
      const admin = await prisma.users.findUniqueOrThrow({ where: { email: spec.email } });
      adminUserId = admin.id;
    }
    rows.push(row);
    console.log(
      `  ✓ ${spec.email.padEnd(30)} ${spec.roleCode.padEnd(11)} ${row.active ? "ACTIVE  " : "INACTIVE"}` +
        `${row.linkedDriver ? " +driver" : ""}${row.linkedCustomer ? " +customer" : ""}${row.employee ? " +employee" : ""}`,
    );
  }

  console.log("\n[seed:visual] Done. Common password for all fixtures: VisualTest123!");
  console.log("[seed:visual] LOCAL DEVELOPMENT / TESTING ONLY — never expose these in product UI.");
}

main()
  .catch((error) => {
    if (error instanceof AppError) {
      console.error(`[seed:visual] Failed: ${error.message}`);
    } else {
      console.error("[seed:visual] Failed with an unexpected error.");
      console.error(error);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
