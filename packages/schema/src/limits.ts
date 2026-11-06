// A generated API has to stay small enough to compile and cache, and a query depth of 8
// must still reach the bottom of a type through its references.
export const MAX_FIELD_DEPTH = 5;
export const MAX_FIELDS = 200;

export const MAX_LABEL_LENGTH = 200;
export const MAX_TEXT_BYTES = 1_048_576;
export const MAX_LIST_ITEMS = 1_000;
export const MAX_REFERENCE_TARGETS = 32;
export const MAX_ACCEPTED_TYPES = 32;

// Columns on the filter row. A field keeps its slot for life, so a removed field holds one
// until a person confirms the removal.
export const FILTER_SLOTS = Object.freeze({ text: 5, integer: 5, time: 2 } as const);
export const MAX_FILTER_FIELDS = FILTER_SLOTS.text + FILTER_SLOTS.integer + FILTER_SLOTS.time;

// Past this a value would not fit the btree tuple of the covering key.
export const MAX_FILTER_TEXT_BYTES = 256;
export const MAX_LIST_FILTER_ITEMS = 32;
export const MAX_LIST_FILTER_ITEM_BYTES = 32;

// The type size up to which an undeclared filter may read every item.
export const UNDECLARED_FILTER_MAX_ITEMS = 20_000;

export const MAX_FILTER_DEPTH = 8;
export const MAX_FILTER_NODES = 128;
export const MAX_FILTER_IN_VALUES = 100;

// Bounds a client facing error, however many fields are wrong.
export const MAX_ISSUES = 50;
