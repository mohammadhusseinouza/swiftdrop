-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CompanyFinancialTransactionType" AS ENUM ('DELIVERY_FEE_REVENUE', 'COMPANY_ORDER_PRODUCT_REVENUE', 'ADJUSTMENT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "DeliveryAttemptOutcome" AS ENUM ('DELIVERED', 'FAILED', 'RETURNED');

-- CreateEnum
CREATE TYPE "DriverCashTransactionType" AS ENUM ('COLLECTION', 'SETTLEMENT', 'ADJUSTMENT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "OrderFinancialStatus" AS ENUM ('PENDING', 'FINALIZED', 'REVIEW_REQUIRED', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('RECEIVED', 'READY_FOR_PICKUP', 'ASSIGNED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED_DELIVERY', 'RESCHEDULED', 'RETURNED_TO_COMPANY', 'RETURNED_TO_CUSTOMER', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('COMPANY_ORDER', 'DELIVERY_ONLY');

-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('CASH_ON_DELIVERY', 'ALREADY_PAID', 'PARTIALLY_PAID');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('COMPLETED', 'REVERSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WalletTransactionType" AS ENUM ('ORDER_CREDIT', 'PAYOUT', 'ADJUSTMENT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "ParcelIntakeMethod" AS ENUM ('ALREADY_AT_COMPANY', 'DRIVER_COLLECTION');

-- CreateEnum
CREATE TYPE "ParcelCollectionStatus" AS ENUM ('AWAITING_ASSIGNMENT', 'ASSIGNED', 'COLLECTED_FROM_SENDER', 'FAILED', 'RESCHEDULED', 'RECEIVED_AT_COMPANY');

-- CreateEnum
CREATE TYPE "ParcelCollectionAttemptOutcome" AS ENUM ('COLLECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "ParcelCollectionAssignmentEndReason" AS ENUM ('REASSIGNED', 'FAILED', 'RECEIVED_AT_COMPANY', 'ORDER_CANCELLED');

-- CreateTable
CREATE TABLE "areas" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(150) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_user_id" UUID,
    "action" VARCHAR(100) NOT NULL,
    "entity_type" VARCHAR(100) NOT NULL,
    "entity_id" VARCHAR(100) NOT NULL,
    "previous_values" JSONB,
    "new_values" JSONB,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_financial_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID,
    "type" "CompanyFinancialTransactionType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "payment_method_id" UUID,
    "created_by_id" UUID,
    "notes" TEXT,
    "reversal_of_id" UUID,
    "idempotency_key" VARCHAR(200),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_financial_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_payouts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payout_number" VARCHAR(50) NOT NULL,
    "customer_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "payment_method_id" UUID NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'COMPLETED',
    "processed_by_id" UUID NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_wallets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "available_balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "portal_user_id" UUID,
    "customer_number" VARCHAR(50) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "primary_phone" VARCHAR(30) NOT NULL,
    "secondary_phone" VARCHAR(30),
    "email" VARCHAR(255),
    "default_address" VARCHAR(500),
    "default_area_id" UUID,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "expected_collection" DECIMAL(14,2) NOT NULL,
    "actual_collection" DECIMAL(14,2),
    "outcome" "DeliveryAttemptOutcome" NOT NULL,
    "failed_reason_id" UUID,
    "notes" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_cash_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "driver_id" UUID NOT NULL,
    "current_balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_cash_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_cash_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "order_id" UUID,
    "settlement_id" UUID,
    "type" "DriverCashTransactionType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "balance_before" DECIMAL(14,2) NOT NULL,
    "balance_after" DECIMAL(14,2) NOT NULL,
    "created_by_id" UUID,
    "notes" TEXT,
    "reversal_of_id" UUID,
    "idempotency_key" VARCHAR(200),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_cash_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_settlements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "settlement_number" VARCHAR(50) NOT NULL,
    "driver_id" UUID NOT NULL,
    "balance_before" DECIMAL(14,2) NOT NULL,
    "amount_received" DECIMAL(14,2) NOT NULL,
    "balance_after" DECIMAL(14,2) NOT NULL,
    "payment_method_id" UUID NOT NULL,
    "received_by_id" UUID NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drivers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "driver_number" VARCHAR(50) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "employee_number" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "failed_delivery_reasons" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(150) NOT NULL,
    "requires_notes" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "failed_delivery_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "failed_collection_reasons" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(150) NOT NULL,
    "requires_notes" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "failed_collection_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parcel_collection_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "assigned_by_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),
    "end_reason" "ParcelCollectionAssignmentEndReason",
    "is_current" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "parcel_collection_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parcel_collection_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "outcome" "ParcelCollectionAttemptOutcome" NOT NULL,
    "failed_collection_reason_id" UUID,
    "notes" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parcel_collection_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "assigned_by_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),
    "end_reason" VARCHAR(500),
    "is_current" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "order_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "from_status" "OrderStatus",
    "to_status" "OrderStatus" NOT NULL,
    "changed_by_id" UUID NOT NULL,
    "reason" VARCHAR(500),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_number" VARCHAR(50) NOT NULL,
    "tracking_code" VARCHAR(100) NOT NULL,
    "customer_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "order_type" "OrderType" NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'RECEIVED',
    "financial_status" "OrderFinancialStatus" NOT NULL DEFAULT 'PENDING',
    "receiver_name" VARCHAR(200) NOT NULL,
    "receiver_phone" VARCHAR(30) NOT NULL,
    "receiver_alt_phone" VARCHAR(30),
    "receiver_area_id" UUID,
    "receiver_area" VARCHAR(150) NOT NULL,
    "receiver_address" VARCHAR(500) NOT NULL,
    "receiver_building_floor" VARCHAR(200),
    "receiver_map_link" VARCHAR(1000),
    "receiver_instructions" TEXT,
    "description" TEXT NOT NULL,
    "package_count" INTEGER NOT NULL DEFAULT 1,
    "quantity" INTEGER,
    "weight_kg" DECIMAL(10,3),
    "package_notes" TEXT,
    "order_amount" DECIMAL(14,2) NOT NULL,
    "delivery_fee" DECIMAL(14,2) NOT NULL,
    "payment_type" "PaymentType" NOT NULL,
    "prepaid_order_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "prepaid_delivery_fee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "remaining_order_amount" DECIMAL(14,2) NOT NULL,
    "remaining_delivery_fee" DECIMAL(14,2) NOT NULL,
    "amount_to_collect" DECIMAL(14,2) NOT NULL,
    "actual_amount_collected" DECIMAL(14,2),
    "prepaid_payment_method_id" UUID,
    "collection_payment_method_id" UUID,
    "collection_difference_reason" TEXT,
    "needs_financial_review" BOOLEAN NOT NULL DEFAULT false,
    "current_driver_id" UUID,
    "assigned_at" TIMESTAMPTZ(3),
    "picked_up_at" TIMESTAMPTZ(3),
    "out_for_delivery_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "parcel_intake_method" "ParcelIntakeMethod" NOT NULL,
    "parcel_collection_status" "ParcelCollectionStatus" NOT NULL,
    "current_parcel_collection_driver_id" UUID,
    "parcel_collection_contact_name" VARCHAR(200),
    "parcel_collection_phone" VARCHAR(30),
    "parcel_collection_alt_phone" VARCHAR(30),
    "parcel_collection_area_id" UUID,
    "parcel_collection_area" VARCHAR(150),
    "parcel_collection_address" VARCHAR(500),
    "parcel_collection_notes" TEXT,
    "parcel_collected_from_sender_at" TIMESTAMPTZ(3),
    "received_at_company_at" TIMESTAMPTZ(3),
    "received_at_company_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(100) NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "description" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(100) NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "description" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" VARCHAR(150) NOT NULL,
    "value" JSONB NOT NULL,
    "description" VARCHAR(500),
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100) NOT NULL,
    "phone" VARCHAR(30),
    "role_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "wallet_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "order_id" UUID,
    "payout_id" UUID,
    "type" "WalletTransactionType" NOT NULL,
    "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "balance_before" DECIMAL(14,2) NOT NULL,
    "balance_after" DECIMAL(14,2) NOT NULL,
    "payment_method_id" UUID,
    "processed_by_id" UUID,
    "notes" TEXT,
    "reversal_of_id" UUID,
    "idempotency_key" VARCHAR(200),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "refresh_token_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "areas_name_key" ON "areas"("name");

-- CreateIndex
CREATE INDEX "areas_is_active_sort_order_idx" ON "areas"("is_active", "sort_order");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_created_at_idx" ON "audit_logs"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_created_at_idx" ON "audit_logs"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "company_financial_transactions_idempotency_key_key" ON "company_financial_transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "company_financial_transactions_created_at_idx" ON "company_financial_transactions"("created_at");

-- CreateIndex
CREATE INDEX "company_financial_transactions_order_id_idx" ON "company_financial_transactions"("order_id");

-- CreateIndex
CREATE INDEX "company_financial_transactions_type_created_at_idx" ON "company_financial_transactions"("type", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "customer_payouts_payout_number_key" ON "customer_payouts"("payout_number");

-- CreateIndex
CREATE INDEX "customer_payouts_customer_id_created_at_idx" ON "customer_payouts"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "customer_payouts_status_created_at_idx" ON "customer_payouts"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "customer_wallets_customer_id_key" ON "customer_wallets"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_portal_user_id_key" ON "customers"("portal_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_customer_number_key" ON "customers"("customer_number");

-- CreateIndex
CREATE INDEX "customers_default_area_id_idx" ON "customers"("default_area_id");

-- CreateIndex
CREATE INDEX "customers_is_active_idx" ON "customers"("is_active");

-- CreateIndex
CREATE INDEX "customers_name_idx" ON "customers"("name");

-- CreateIndex
CREATE INDEX "customers_primary_phone_idx" ON "customers"("primary_phone");

-- CreateIndex
CREATE INDEX "delivery_attempts_driver_id_started_at_idx" ON "delivery_attempts"("driver_id", "started_at");

-- CreateIndex
CREATE INDEX "delivery_attempts_outcome_completed_at_idx" ON "delivery_attempts"("outcome", "completed_at");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_attempts_order_id_attempt_number_key" ON "delivery_attempts"("order_id", "attempt_number");

-- CreateIndex
CREATE UNIQUE INDEX "driver_cash_accounts_driver_id_key" ON "driver_cash_accounts"("driver_id");

-- CreateIndex
CREATE UNIQUE INDEX "driver_cash_transactions_settlement_id_key" ON "driver_cash_transactions"("settlement_id");

-- CreateIndex
CREATE UNIQUE INDEX "driver_cash_transactions_idempotency_key_key" ON "driver_cash_transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "driver_cash_transactions_account_id_created_at_idx" ON "driver_cash_transactions"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "driver_cash_transactions_driver_id_created_at_idx" ON "driver_cash_transactions"("driver_id", "created_at");

-- CreateIndex
CREATE INDEX "driver_cash_transactions_order_id_idx" ON "driver_cash_transactions"("order_id");

-- CreateIndex
CREATE INDEX "driver_cash_transactions_type_created_at_idx" ON "driver_cash_transactions"("type", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "driver_settlements_settlement_number_key" ON "driver_settlements"("settlement_number");

-- CreateIndex
CREATE INDEX "driver_settlements_driver_id_created_at_idx" ON "driver_settlements"("driver_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_user_id_key" ON "drivers"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_driver_number_key" ON "drivers"("driver_number");

-- CreateIndex
CREATE INDEX "drivers_is_active_idx" ON "drivers"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "employees_user_id_key" ON "employees"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "employees_employee_number_key" ON "employees"("employee_number");

-- CreateIndex
CREATE UNIQUE INDEX "failed_delivery_reasons_name_key" ON "failed_delivery_reasons"("name");

-- CreateIndex
CREATE INDEX "failed_delivery_reasons_is_active_sort_order_idx" ON "failed_delivery_reasons"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "failed_collection_reasons_name_key" ON "failed_collection_reasons"("name");

-- CreateIndex
CREATE INDEX "failed_collection_reasons_is_active_sort_order_idx" ON "failed_collection_reasons"("is_active", "sort_order");

-- CreateIndex
CREATE INDEX "parcel_collection_assignments_order_id_is_current_idx" ON "parcel_collection_assignments"("order_id", "is_current");

-- CreateIndex
CREATE INDEX "parcel_collection_assignments_driver_id_is_current_idx" ON "parcel_collection_assignments"("driver_id", "is_current");

-- CreateIndex
CREATE INDEX "parcel_collection_assignments_assigned_at_idx" ON "parcel_collection_assignments"("assigned_at");

-- CreateIndex
CREATE INDEX "parcel_collection_attempts_driver_id_started_at_idx" ON "parcel_collection_attempts"("driver_id", "started_at");

-- CreateIndex
CREATE INDEX "parcel_collection_attempts_outcome_completed_at_idx" ON "parcel_collection_attempts"("outcome", "completed_at");

-- CreateIndex
CREATE UNIQUE INDEX "parcel_collection_attempts_order_id_attempt_number_key" ON "parcel_collection_attempts"("order_id", "attempt_number");

-- CreateIndex
CREATE INDEX "order_assignments_assigned_at_idx" ON "order_assignments"("assigned_at");

-- CreateIndex
CREATE INDEX "order_assignments_driver_id_is_current_idx" ON "order_assignments"("driver_id", "is_current");

-- CreateIndex
CREATE INDEX "order_assignments_order_id_is_current_idx" ON "order_assignments"("order_id", "is_current");

-- CreateIndex
CREATE INDEX "order_status_history_order_id_created_at_idx" ON "order_status_history"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "order_status_history_to_status_created_at_idx" ON "order_status_history"("to_status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");

-- CreateIndex
CREATE UNIQUE INDEX "orders_tracking_code_key" ON "orders"("tracking_code");

-- CreateIndex
CREATE INDEX "orders_created_at_idx" ON "orders"("created_at");

-- CreateIndex
CREATE INDEX "orders_customer_id_status_idx" ON "orders"("customer_id", "status");

-- CreateIndex
CREATE INDEX "orders_delivered_at_idx" ON "orders"("delivered_at");

-- CreateIndex
CREATE INDEX "orders_financial_status_idx" ON "orders"("financial_status");

-- CreateIndex
CREATE INDEX "orders_order_type_status_idx" ON "orders"("order_type", "status");

-- CreateIndex
CREATE INDEX "orders_receiver_area_idx" ON "orders"("receiver_area");

-- CreateIndex
CREATE INDEX "orders_receiver_phone_idx" ON "orders"("receiver_phone");

-- CreateIndex
CREATE INDEX "orders_status_current_driver_id_idx" ON "orders"("status", "current_driver_id");

-- CreateIndex
CREATE INDEX "orders_parcel_collection_status_idx" ON "orders"("parcel_collection_status");

-- CreateIndex
CREATE INDEX "orders_parcel_intake_method_idx" ON "orders"("parcel_intake_method");

-- CreateIndex
CREATE INDEX "orders_current_parcel_collection_driver_id_idx" ON "orders"("current_parcel_collection_driver_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_methods_code_key" ON "payment_methods"("code");

-- CreateIndex
CREATE INDEX "payment_methods_is_active_sort_order_idx" ON "payment_methods"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions"("permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_key_key" ON "system_settings"("key");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_is_active_idx" ON "users"("is_active");

-- CreateIndex
CREATE INDEX "users_role_id_idx" ON "users"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_payout_id_key" ON "wallet_transactions"("payout_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_idempotency_key_key" ON "wallet_transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "wallet_transactions_customer_id_created_at_idx" ON "wallet_transactions"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "wallet_transactions_order_id_idx" ON "wallet_transactions"("order_id");

-- CreateIndex
CREATE INDEX "wallet_transactions_type_created_at_idx" ON "wallet_transactions"("type", "created_at");

-- CreateIndex
CREATE INDEX "wallet_transactions_wallet_id_created_at_idx" ON "wallet_transactions"("wallet_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_refresh_token_hash_key" ON "auth_sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions"("user_id");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_financial_transactions" ADD CONSTRAINT "company_financial_transactions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_financial_transactions" ADD CONSTRAINT "company_financial_transactions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_financial_transactions" ADD CONSTRAINT "company_financial_transactions_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_financial_transactions" ADD CONSTRAINT "company_financial_transactions_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "company_financial_transactions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "customer_payouts" ADD CONSTRAINT "customer_payouts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "customer_payouts" ADD CONSTRAINT "customer_payouts_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "customer_payouts" ADD CONSTRAINT "customer_payouts_processed_by_id_fkey" FOREIGN KEY ("processed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "customer_wallets" ADD CONSTRAINT "customer_wallets_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_default_area_id_fkey" FOREIGN KEY ("default_area_id") REFERENCES "areas"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_portal_user_id_fkey" FOREIGN KEY ("portal_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_failed_reason_id_fkey" FOREIGN KEY ("failed_reason_id") REFERENCES "failed_delivery_reasons"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "driver_cash_accounts" ADD CONSTRAINT "driver_cash_accounts_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "driver_cash_transactions" ADD CONSTRAINT "driver_cash_transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "driver_cash_accounts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "driver_cash_transactions" ADD CONSTRAINT "driver_cash_transactions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "driver_cash_transactions" ADD CONSTRAINT "driver_cash_transactions_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "driver_cash_transactions" ADD CONSTRAINT "driver_cash_transactions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "driver_cash_transactions" ADD CONSTRAINT "driver_cash_transactions_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "driver_cash_transactions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "driver_cash_transactions" ADD CONSTRAINT "driver_cash_transactions_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "driver_settlements"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "driver_settlements" ADD CONSTRAINT "driver_settlements_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "driver_settlements" ADD CONSTRAINT "driver_settlements_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "driver_settlements" ADD CONSTRAINT "driver_settlements_received_by_id_fkey" FOREIGN KEY ("received_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "parcel_collection_assignments" ADD CONSTRAINT "parcel_collection_assignments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "parcel_collection_assignments" ADD CONSTRAINT "parcel_collection_assignments_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "parcel_collection_assignments" ADD CONSTRAINT "parcel_collection_assignments_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "parcel_collection_attempts" ADD CONSTRAINT "parcel_collection_attempts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "parcel_collection_attempts" ADD CONSTRAINT "parcel_collection_attempts_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "parcel_collection_attempts" ADD CONSTRAINT "parcel_collection_attempts_failed_collection_reason_id_fkey" FOREIGN KEY ("failed_collection_reason_id") REFERENCES "failed_collection_reasons"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "order_assignments" ADD CONSTRAINT "order_assignments_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "order_assignments" ADD CONSTRAINT "order_assignments_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "order_assignments" ADD CONSTRAINT "order_assignments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_collection_payment_method_id_fkey" FOREIGN KEY ("collection_payment_method_id") REFERENCES "payment_methods"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_received_at_company_by_id_fkey" FOREIGN KEY ("received_at_company_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_current_driver_id_fkey" FOREIGN KEY ("current_driver_id") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_current_parcel_collection_driver_id_fkey" FOREIGN KEY ("current_parcel_collection_driver_id") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_prepaid_payment_method_id_fkey" FOREIGN KEY ("prepaid_payment_method_id") REFERENCES "payment_methods"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_receiver_area_id_fkey" FOREIGN KEY ("receiver_area_id") REFERENCES "areas"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_parcel_collection_area_id_fkey" FOREIGN KEY ("parcel_collection_area_id") REFERENCES "areas"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "customer_payouts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_processed_by_id_fkey" FOREIGN KEY ("processed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "wallet_transactions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "customer_wallets"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
