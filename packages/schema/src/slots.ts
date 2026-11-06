import {
  type FILTER_SLOTS,
  MAX_FILTER_TEXT_BYTES,
  MAX_LIST_FILTER_ITEM_BYTES,
  MAX_LIST_FILTER_ITEMS,
} from './limits.ts';
import type { FieldDef } from './types.ts';

export type SlotClass = keyof typeof FILTER_SLOTS;

// Which filter row column a field can take, or null when it can never take one.
export function slotClassOf(field: FieldDef): SlotClass | null {
  switch (field.kind) {
    case 'text':
      return field.maxLength <= MAX_FILTER_TEXT_BYTES ? 'text' : null;
    case 'number':
    case 'boolean':
      return 'integer';
    case 'date':
      return 'time';
    case 'reference':
      return field.many ? null : 'text';
    case 'list':
      return field.of.kind === 'text' &&
        field.of.maxLength <= MAX_LIST_FILTER_ITEM_BYTES &&
        field.maxItems <= MAX_LIST_FILTER_ITEMS
        ? 'text'
        : null;
    default:
      return null;
  }
}
