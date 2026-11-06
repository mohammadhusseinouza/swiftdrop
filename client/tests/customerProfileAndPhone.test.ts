// Customer Portal Redesign Step 6 — Transactions phone layout (shared row
// view), Profile initials / missing values and the Profile read-only
// guardrail. Pure logic + source checks, Node's built-in runner. Run:
//   npx --prefix ../server tsx --test tests/customerProfileAndPhone.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getTransactionRowView } from '../src/components/customer/customerWalletPresentation';
import { getProfileInitials, isMissingValue } from '../src/components/customer/customerProfilePresentation';
import { formatMoney } from '../src/lib/format';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('Transactions row view (shared by table and phone rows)', () => {
  test('credit row', () => {
    const v = getTransactionRowView(
      { type: 'ORDER_CREDIT', direction: 'CREDIT', amount: '70', balanceAfter: '150', reference: { label: 'PH141-VIS-01' } },
      formatMoney,
    );
    assert.deepEqual(v, {
      description: 'PH141-VIS-01',
      balanceAfter: 'Balance after $150.00',
      amount: '+$70.00',
      directionWord: 'Added',
      amountClass: 'text-success-700',
      typeLabel: 'Order Credit',
      typeTone: 'success',
    });
  });

  test('debit row is ink, not red; reversal without reference falls back to type label', () => {
    const v = getTransactionRowView(
      { type: 'REVERSAL', direction: 'DEBIT', amount: '50', balanceAfter: '120', reference: null },
      formatMoney,
    );
    assert.equal(v.description, 'Reversal');
    assert.equal(v.amount, '-$50.00');
    assert.equal(v.directionWord, 'Deducted');
    assert.equal(v.amountClass, 'text-ink');
    assert.equal(v.typeTone, 'neutral');
  });

  test('NONE direction: no sign, no word', () => {
    const v = getTransactionRowView(
      { type: 'ADJUSTMENT', direction: 'NONE', amount: '0', balanceAfter: '10', reference: null },
      formatMoney,
    );
    assert.equal(v.amount, '$0.00');
    assert.equal(v.directionWord, '');
  });

  const page = strip(read('../src/pages/customer/CustomerTransactionsPage.tsx'));

  test('phone rows below sm, table from sm up; one implementation of the row logic', () => {
    assert.ok(page.includes('<ul className="divide-y divide-line-subtle sm:hidden">'));
    assert.ok(page.includes('hidden overflow-x-auto rounded-[14px] border border-line-subtle sm:block'));
    assert.equal(page.match(/getTransactionRowView\(tx, formatMoney\)/g)?.length, 2);
    assert.ok(!/getDirectionPresentation|getTransactionDescription|getWalletTransactionTypeTone|getWalletTransactionTypeLabel/.test(page));
  });

  test('phone row shows date and type badge on the second line', () => {
    const stacked = page.slice(page.indexOf('function TransactionStackedRow'));
    assert.ok(stacked.includes('<time dateTime={tx.occurredAt}>{formatDateTime(tx.occurredAt)}</time>'));
    assert.ok(stacked.includes('<Badge tone={view.typeTone}>{view.typeLabel}</Badge>'));
  });
});

describe('Profile', () => {
  test('initials: max 2 letters; empty name → null (icon)', () => {
    assert.equal(getProfileInitials('Visual Customer'), 'VC');
    assert.equal(getProfileInitials('Nour Al Haddad'), 'NH');
    assert.equal(getProfileInitials('acme'), 'AC');
    assert.equal(getProfileInitials('X'), 'X');
    assert.equal(getProfileInitials(''), null);
    assert.equal(getProfileInitials('   '), null);
    assert.equal(getProfileInitials(null), null);
  });

  test('missing values', () => {
    assert.equal(isMissingValue(null), true);
    assert.equal(isMissingValue(undefined), true);
    assert.equal(isMissingValue(''), true);
    assert.equal(isMissingValue('  '), true);
    assert.equal(isMissingValue('Hamra'), false);
  });

  const page = strip(read('../src/pages/customer/CustomerProfilePage.tsx'));

  test('optional rows render "—" when missing; links for phone / email', () => {
    assert.ok(page.includes('<span aria-hidden="true">—</span>'));
    assert.ok(page.includes('isMissingValue(data.secondaryPhone)'));
    assert.ok(page.includes('isMissingValue(data.email)'));
    assert.ok(page.includes('isMissingValue(data.defaultArea?.name)'));
    assert.ok(page.includes('isMissingValue(data.defaultAddress)'));
    assert.ok(page.includes('href={`tel:${phone}`}'));
    assert.ok(page.includes('href={`mailto:${data.email}`}'));
    assert.ok(page.includes('{initials ?? <UserRound'));
  });

  test('read-only: no edit / password / mutation control', () => {
    assert.ok(!/<button|<form|<input|onSubmit|useMutation|Mutation\b|edit profile|change password|password/i.test(page));
    assert.ok(!/withdraw|request payout/i.test(page));
    assert.ok(page.includes('Need to change something? Contact Spring Delivery and we will update your details for you.'));
  });
});
