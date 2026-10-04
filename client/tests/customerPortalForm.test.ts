// Pure-logic test for the Management Customer form's portal-password handling.
// Same lightweight approach as orderDetailActions.test.ts (Node's built-in
// runner, outside src/). Run:
//   npx --prefix ../server tsx --test tests/customerPortalForm.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOMER_FORM_DEFAULTS,
  buildCustomerFormSchema,
  customerToFormValues,
  toCreateCustomerRequest,
  toUpdateCustomerRequest,
  type CustomerFormValues,
} from '../src/pages/management/customers/customerForm.schema';
import type { CustomerDetail } from '../src/services/domain.types';

function values(overrides: Partial<CustomerFormValues> = {}): CustomerFormValues {
  return {
    ...CUSTOMER_FORM_DEFAULTS,
    name: 'Acme',
    primaryPhone: '+96170000000',
    ...overrides,
  };
}

function issues(hasPortalAccount: boolean, v: CustomerFormValues) {
  const result = buildCustomerFormSchema(hasPortalAccount).safeParse(v);
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
}

describe('Customer form — portal password', () => {
  test('create without password: valid, portalPassword omitted from the request', () => {
    assert.deepEqual(issues(false, values()), []);
    assert.equal(toCreateCustomerRequest(values()).portalPassword, undefined);
  });

  test('create with password + email: valid, password sent exactly as typed', () => {
    const v = values({ email: 'a@example.com', portalPassword: ' Secret#123 ' });
    assert.deepEqual(issues(false, v), []);
    assert.equal(toCreateCustomerRequest(v).portalPassword, ' Secret#123 ');
  });

  test('password without email -> email error', () => {
    assert.deepEqual(issues(false, values({ portalPassword: 'Secret#123' })), ['email']);
  });

  test('short password -> portalPassword error', () => {
    assert.deepEqual(issues(false, values({ email: 'a@example.com', portalPassword: 'short' })), ['portalPassword']);
  });

  test('edit with an existing portal account: email required even without a new password', () => {
    assert.deepEqual(issues(true, values({ email: '' })), ['email']);
    assert.deepEqual(issues(true, values({ email: 'a@example.com' })), []);
  });

  test('edit: blank password is omitted (current password unchanged); a new one is sent', () => {
    const blank = toUpdateCustomerRequest(values({ email: 'a@example.com' }));
    assert.equal('portalPassword' in blank, false);
    const set = toUpdateCustomerRequest(values({ email: 'a@example.com', portalPassword: 'NewSecret#1' }));
    assert.equal(set.portalPassword, 'NewSecret#1');
  });

  test('edit form is never prefilled with a password', () => {
    const customer = {
      name: 'Acme',
      primaryPhone: '+96170000000',
      secondaryPhone: null,
      email: 'a@example.com',
      defaultAddress: null,
      area: null,
      notes: null,
      hasPortalAccount: true,
    } as unknown as CustomerDetail;
    assert.equal(customerToFormValues(customer).portalPassword, '');
  });
});
