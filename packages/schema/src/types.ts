// Not exported, so an id can only come from the checks in ids.ts.
declare const brand: unique symbol;

export type FieldId = string & { readonly [brand]: 'field' };
export type TypeId = string & { readonly [brand]: 'type' };

export type Scale = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export interface FieldBase {
  readonly id: FieldId;
  readonly apiName: string;
  readonly label: string;
  readonly required: boolean;
  readonly unique?: boolean;
  readonly filterable?: boolean;
  readonly sortable?: boolean;
  readonly localized?: boolean;
}

export type FieldDef = FieldBase &
  (
    | {
        readonly kind: 'text';
        // In UTF-8 bytes, so a declared field is known to fit its slot.
        readonly maxLength: number;
        readonly format?: 'plain' | 'slug' | 'email' | 'url';
      }
    // Stored as the shared AST, so it has no length and no string options.
    | { readonly kind: 'rich_text' }
    | { readonly kind: 'markdown'; readonly maxLength: number }
    // Values are integer units; bounds are decimal strings, so no float is ever read.
    | {
        readonly kind: 'number';
        readonly scale: Scale;
        readonly min?: string;
        readonly max?: string;
      }
    | { readonly kind: 'boolean' }
    | { readonly kind: 'date'; readonly withTime: boolean }
    | { readonly kind: 'asset'; readonly accept: readonly string[] }
    | { readonly kind: 'reference'; readonly to: readonly TypeId[]; readonly many: boolean }
    | { readonly kind: 'list'; readonly of: FieldDef; readonly maxItems: number }
    | { readonly kind: 'object'; readonly fields: readonly FieldDef[] }
  );

export interface ContentSchema {
  readonly typeId: TypeId;
  readonly apiName: string;
  readonly version: number;
  readonly fields: readonly FieldDef[];
  // Still served by both APIs, marked deprecated, until a person confirms removal.
  readonly deprecated: readonly FieldId[];
  // Every id ever removed. Kept in the definition because a diff only sees the version
  // before it, and slots and stored content can still carry the old meaning of an id.
  readonly retired: readonly FieldId[];
}

export const SCHEMA_ERROR_CODES = Object.freeze([
  'schema.name_reserved',
  'schema.name_invalid',
  'schema.name_collision',
  'schema.reference_unknown',
  'schema.too_deep',
  'schema.too_large',
  'schema.breaking_in_place',
  'schema.limit_reached',
  'schema.malformed',
] as const);
export type SchemaErrorCode = (typeof SCHEMA_ERROR_CODES)[number];

export type SchemaIssueReason =
  | 'text_slots'
  | 'integer_slots'
  | 'time_slots'
  | 'not_declarable'
  | 'nested_declaration'
  | 'removed'
  | 'removal_unconfirmed'
  | 'moved'
  | 'renamed'
  | 'retyped'
  | 'narrowed'
  | 'required_added'
  | 'required_dropped'
  | 'undeclared'
  | 'identity'
  | 'reused'
  | 'retired'
  | 'version';

// Paths hold schema keys and positions and ids hold checked uuids. Issues reach logs and
// clients, so no text a customer typed may appear here.
export interface SchemaIssue {
  readonly path: string;
  readonly code: SchemaErrorCode;
  readonly reason?: SchemaIssueReason;
  readonly fieldId?: FieldId;
}

export interface SchemaError {
  readonly code: SchemaErrorCode;
  readonly issues: readonly SchemaIssue[];
}

export interface SchemaDiff {
  readonly fromVersion: number | null;
  readonly toVersion: number;
  // True when nothing a consumer reads was deprecated or removed.
  readonly additive: boolean;
  readonly added: readonly FieldId[];
  readonly changed: readonly FieldId[];
  readonly deprecated: readonly FieldId[];
  readonly restored: readonly FieldId[];
  readonly removed: readonly FieldId[];
}

export interface ValidateOptions {
  // Other types in the project. A type may always reference itself.
  readonly knownTypes?: ReadonlySet<TypeId>;
  // A person's confirmed choice, which is why it never travels inside the schema a client
  // submits. The caller checks who may give it.
  readonly confirmedRemovals?: readonly FieldId[];
}

export type FilterOp = 'eq' | 'neq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'exists';

// No number form: numbers travel as decimal strings, so a float cannot get in.
export type FilterValue = string | boolean | readonly string[];

export type FilterNode =
  | { readonly and: readonly FilterNode[] }
  | { readonly or: readonly FilterNode[] }
  | { readonly not: FilterNode }
  | { readonly field: FieldId; readonly op: FilterOp; readonly value?: FilterValue };

export const FILTER_ERROR_CODES = Object.freeze([
  'filter.malformed',
  'filter.too_large',
  'filter.field_unknown',
  'filter.op_invalid',
  'filter.value_invalid',
  'filter.not_declared',
] as const);
export type FilterErrorCode = (typeof FILTER_ERROR_CODES)[number];

export interface FilterError {
  readonly code: FilterErrorCode;
  readonly path: string;
}

export interface FilterOptions {
  // Items of this type now, from the caller's own count.
  readonly itemCount: number;
  readonly undeclaredScanMaxItems?: number;
}

export interface FilterCheck {
  readonly filter: FilterNode;
  // Sorted. These fields have no slot, so the query must scan.
  readonly undeclared: readonly FieldId[];
}
