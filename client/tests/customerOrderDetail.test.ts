// Customer Portal Redesign Step 4 — Order Detail: copy fallback, journey
// order + state text, optional-field hiding, map-link safety and the
// no-driver guardrail. Pure logic + source checks, Node's built-in runner. Run:
//   npx --prefix ../server tsx --test tests/customerOrderDetail.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  copyText,
  getCopyMessage,
  getJourneyLead,
  getPackageRows,
  getReceiverAddressParts,
  getTrackingStateWord,
  isSafeHttpUrl,
} from '../src/components/customer/customerOrderDetailPresentation';
import type { CustomerOrderReceiver } from '../src/services/domain.types';

describe('copy tracking code', () => {
  test('copies through the clipboard', async () => {
    const written: string[] = [];
    const result = await copyText('TRK-ABC', { writeText: async (t) => void written.push(t) });
    assert.equal(result, 'copied');
    assert.deepEqual(written, ['TRK-ABC']);
    assert.equal(getCopyMessage(result), 'Copied');
  });

  test('no Clipboard API → unavailable, never throws', async () => {
    assert.equal(await copyText('TRK-ABC', undefined), 'unavailable');
    assert.equal(await copyText('TRK-ABC', null), 'unavailable');
    assert.equal(await copyText('TRK-ABC', {} as never), 'unavailable');
  });

  test('rejected write → failed, never throws', async () => {
    const result = await copyText('TRK-ABC', {
      writeText: async () => {
        throw new Error('NotAllowedError');
      },
    });
    assert.equal(result, 'failed');
    assert.match(getCopyMessage(result), /Couldn.t copy/);
    assert.match(getCopyMessage('unavailable'), /Couldn.t copy/);
  });
});

describe('journey', () => {
  test('state words are text for every server state', () => {
    assert.equal(getTrackingStateWord('done'), 'Done');
    assert.equal(getTrackingStateWord('current'), 'In progress');
    assert.equal(getTrackingStateWord('upcoming'), 'Upcoming');
  });

  test('lead comes from the customer-safe status only', () => {
    assert.equal(getJourneyLead('RECEIVED'), 'Your order has been received.');
    assert.equal(getJourneyLead('PICKED_UP'), 'Your order is ready for delivery.');
    assert.equal(getJourneyLead('OUT_FOR_DELIVERY'), 'Your parcel is on its way.');
    assert.equal(getJourneyLead('DELIVERED'), 'Your parcel has been delivered.');
    assert.equal(getJourneyLead('FAILED_DELIVERY'), 'Current status: Delivery Attempt Unsuccessful.');
    assert.equal(getJourneyLead('CANCELLED'), 'Current status: Cancelled.');
  });

  test('stages render in server order, unfiltered, with no ETA', () => {
    const src = readFileSync(new URL('../src/components/customer/CustomerJourney.tsx', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(code.includes('const stages = tracking.stages;'));
    assert.ok(code.includes('stages.map('));
    assert.ok(!/\.(sort|filter|reverse|slice|splice|concat)\(/.test(code), 'no reordering / adding / removing');
    assert.ok(!/\beta\b|\bexpected|estimat/i.test(code));
    assert.ok(code.includes('tracking.exception.message'));
  });
});

describe('optional fields', () => {
  const receiver: CustomerOrderReceiver = {
    name: 'R',
    phone: '+1',
    altPhone: null,
    area: 'Hamra',
    address: 'Main St',
    buildingFloor: null,
    instructions: null,
    mapLink: null,
  };

  test('address line skips blank parts', () => {
    assert.deepEqual(getReceiverAddressParts(receiver), ['Hamra', 'Main St']);
    assert.deepEqual(getReceiverAddressParts({ ...receiver, buildingFloor: ' Bldg 4, 2nd ' }), [
      'Hamra',
      'Main St',
      'Bldg 4, 2nd',
    ]);
    assert.deepEqual(getReceiverAddressParts({ ...receiver, buildingFloor: '   ' }), ['Hamra', 'Main St']);
  });

  test('package: quantity / weight only when present', () => {
    const base = { description: 'Shoes', packageCount: 2, quantity: null, weightKg: null };
    assert.deepEqual(getPackageRows(base).map((r) => r.label), ['Contents', 'Pieces']);
    assert.deepEqual(
      getPackageRows({ ...base, quantity: 0, weightKg: '1.5' }).map((r) => `${r.label}=${r.value}`),
      ['Contents=Shoes', 'Pieces=2', 'Quantity=0', 'Weight=1.5 kg'],
    );
    assert.deepEqual(getPackageRows({ ...base, weightKg: '  ' }).map((r) => r.label), ['Contents', 'Pieces']);
  });

  test('map link: only http(s) is linkable', () => {
    assert.equal(isSafeHttpUrl('https://maps.google.com/?q=1'), true);
    assert.equal(isSafeHttpUrl('http://example.test/map'), true);
    assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);
    assert.equal(isSafeHttpUrl('data:text/html,hi'), false);
    assert.equal(isSafeHttpUrl('maps here'), false);
    assert.equal(isSafeHttpUrl(''), false);
    assert.equal(isSafeHttpUrl(null), false);
  });
});

describe('Order Detail page guardrails', () => {
  const src = readFileSync(new URL('../src/pages/customer/CustomerOrderDetailPage.tsx', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  test('no driver identity, attempts, assignments, notes, ETAs or review amounts', () => {
    assert.ok(!/driver|attempt|assignment|internalNote|notes|eta\b|expected|review/i.test(code));
  });

  test('optional receiver fields are conditional; map link is safe', () => {
    assert.ok(code.includes('{r.altPhone && <PhoneLink'));
    assert.ok(code.includes('{isSafeHttpUrl(r.mapLink) && ('));
    assert.ok(code.includes('rel="noopener noreferrer"'));
    assert.ok(code.includes("{r.instructions && r.instructions.trim() !== '' && ("));
    assert.ok(code.includes('{order.deliveredAt && ('));
    assert.ok(code.includes('{order.collectionStage && ('));
  });

  test('copy button: accessible name, polite live region, focus style', () => {
    assert.ok(code.includes('aria-label="Copy tracking code"'));
    assert.ok(code.includes('aria-live="polite"'));
    assert.ok(code.includes('focus-visible:outline-2'));
    assert.ok(code.includes('copyText(code, clipboard)'));
  });

  test('keeps the existing not-available copy; money via formatMoney only', () => {
    assert.ok(code.includes("'Order not available'"));
    assert.ok(code.includes("'This order is not available.'"));
    assert.ok(!/parseFloat|Number\(|toFixed/.test(code));
  });
});

describe('Public tracking keeps its timeline', () => {
  test('PublicTrackingPage still uses the unchanged CustomerOrderTimeline', () => {
    const pub = readFileSync(new URL('../src/pages/public/PublicTrackingPage.tsx', import.meta.url), 'utf8');
    assert.ok(pub.includes("from '../../components/customer/CustomerOrderTimeline'"));
  });
});
