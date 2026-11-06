/**
 * /customer/wallet — the Wallet's default view (handoff §3.4, decision D1-B).
 *
 * The balance panels, the History panel and its Transactions / Payouts tabs
 * live in CustomerWalletLayout (a layout route around /wallet, /transactions
 * and /payouts). At /customer/wallet the History panel shows Transactions —
 * the same component as /customer/transactions, so there is one
 * implementation of the ledger view.
 */
export { default } from './CustomerTransactionsPage';
