import type { CustomerReceiverSuggestion } from '../../services/domain.types';
import { toAsciiDigits } from '../../lib/phoneFormat';

/**
 * Customer Receiver Memory — pure helpers shared by Create Order and Edit
 * Order. A suggestion only PREFILLS the form; every field stays editable and
 * the backend saves / refreshes the receiver when the order is saved.
 */

export const RECEIVER_FIELDS = [
  'receiverName',
  'receiverPhone',
  'receiverAltPhone',
  'receiverAreaId',
  'receiverAddress',
  'receiverBuildingFloor',
  'receiverMapLink',
  'receiverInstructions',
] as const;

export type ReceiverField = (typeof RECEIVER_FIELDS)[number];
export type ReceiverFormValues = Record<ReceiverField, string>;

/**
 * Form values for a chosen saved receiver. Phones get the same Arabic-Indic
 * digit conversion as typed input, and nothing else: a saved phone that breaks
 * the format rule is filled as-is so the form shows its validation error
 * (the caller validates every filled value) — never silently "repaired".
 * The area is left out (the field
 * keeps its current value) when the saved area is missing or inactive — an
 * inactive area can never be prefilled into a new order, and the backend
 * still rejects one if it is selected some other way.
 */
export function suggestionToReceiverValues(
  receiver: CustomerReceiverSuggestion,
): Partial<ReceiverFormValues> {
  const values: Partial<ReceiverFormValues> = {
    receiverName: receiver.name,
    receiverPhone: toAsciiDigits(receiver.phone),
    receiverAltPhone: toAsciiDigits(receiver.alternativePhone ?? ''),
    receiverAddress: receiver.address,
    receiverBuildingFloor: receiver.buildingFloor ?? '',
    receiverMapLink: receiver.mapLink ?? '',
    receiverInstructions: receiver.instructions ?? '',
  };
  if (receiver.area?.isActive) values.receiverAreaId = receiver.area.id;
  return values;
}

/**
 * The non-empty fields that still hold exactly what a suggestion filled in.
 * When the customer changes these are cleared, so one customer's receiver is
 * never silently carried into another customer's order; anything the
 * employee typed over is kept.
 */
export function fieldsStillFromSuggestion(
  applied: Partial<ReceiverFormValues>,
  current: ReceiverFormValues,
): ReceiverField[] {
  return RECEIVER_FIELDS.filter((field) => {
    const value = applied[field];
    return value !== undefined && value !== '' && current[field] === value;
  });
}

export function shortAddress(address: string, max = 48): string {
  const flat = address.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}
