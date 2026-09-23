// The schema a table sends with its rows, mirroring the crate's `Schema` field
// for field. The server rebuilds it on every GET, so everything the editor
// needs to render a table is data here and nothing is held in the browser.

/** One choice in a select, a map key, or a map value. */
export interface SelectOption {
  value: string;
  label?: string;
}

/** A select whose options depend on another column: look the row's value of
 *  `field` up in `options`. A value with no entry offers no choices. */
export interface OptionsBy {
  field: string;
  options: Record<string, SelectOption[]>;
}

/** Where a cell's play button sends its value. */
export interface Speak {
  url: string;
  storage_key: string;
}

export type ColumnType =
  | "string"
  | "text"
  | "spaced-string"
  | "multiline"
  | "number"
  | "boolean"
  | "select"
  | "computed"
  | "map";

/** One column. The `map` fields are flattened into the column by the server,
 *  so they are present together or not at all. */
export interface Column {
  field: string;
  label: string;
  type: ColumnType;
  allow_empty?: boolean;
  wide?: boolean;
  width_ch?: number;
  options?: SelectOption[];
  options_by?: OptionsBy;
  cascades_to?: string[];
  numeric_value?: boolean;
  int_only?: boolean;
  datalist?: string;
  from?: string;
  speak?: Speak;
  /** The field of the same row holding this cell's link target. Honoured where
   *  a cell is read rather than edited: a computed column, and every column of
   *  a view. */
  href?: string;
  key_label?: string;
  value_label?: string;
  key_options?: SelectOption[];
  value_options?: SelectOption[];
  allow_new_keys?: boolean;
  allow_new_values?: boolean;
  /** What a chip shows before the value. Absent means the key's label. */
  chip?: "label" | "key";
}

/** How a new row starts: take `defaults`, then carry each named field forward
 *  from the rows already there. */
export interface NewRowSpec {
  defaults: Record<string, unknown>;
  carry_forward: string[];
}

/** A completion list, in one of the two forms the server sends: a fixed list it
 *  computed, or one built live from the rows on screen. */
export type Datalist =
  | { options: string[] }
  | { from_rows: { fields: string[]; separator: string } };

/** A link from each row into one of the app's views: `args` pairs each of
 *  the view's parameters the link answers with the field of the row that
 *  answers it. */
export interface RowLink {
  view: string;
  args: Record<string, string>;
}

export interface Schema {
  table: string;
  title: string;
  sortable?: boolean;
  /** The field whose value `true` draws a row muted. */
  muted_by?: string;
  columns: Column[];
  new_row: NewRowSpec;
  datalists: Record<string, Datalist>;
  link?: RowLink;
}

/** A row as the editor handles it: the object the server sent, untouched but
 *  for the cells that were edited. Fields no column names are carried through. */
export type Row = Record<string, unknown>;

/** What one row's derivation holds, keyed by the `from` of a computed column. */
export type Derived = Record<string, unknown> | null | undefined;

export interface ValidationError {
  line: number;
  field: string | null;
  message: string;
}

export function isFixedDatalist(
  list: Datalist,
): list is { options: string[] } {
  return "options" in list;
}

/** The label to show for a value, falling back to the value itself. */
export function optionLabel(
  options: readonly SelectOption[] | undefined,
  value: string,
): string {
  const found = options?.find((o) => o.value === value);
  return found?.label ?? value;
}

/** The options a select offers this row: its fixed list, or the list its parent
 *  column's current value maps to. */
export function optionsForRow(
  column: Column,
  row: Row,
): readonly SelectOption[] {
  if (column.options_by) {
    const parent = row[column.options_by.field];
    const key = parent == null ? "" : String(parent);
    return column.options_by.options[key] ?? [];
  }
  return column.options ?? [];
}
