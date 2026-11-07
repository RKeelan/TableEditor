import { useEffect, useRef, useState } from "react";
import { noteColumns, noteFlagRaw, noteMarked, storedNote } from "../lib/cells";
import { selectOptions } from "../lib/rows";
import type { CellSettings, Column, Row, Schema } from "../lib/schema";
import { hideNote, isEditingNote, refreshNote, showNote } from "./NotePopover";

/** How long a finger rests on an unmarked cell before its note opens. */
const LONG_PRESS = 500;

/** What a table cell needs to carry a note: the mark in its corner, the
 *  handlers that show and open it, and the note itself while it is open for
 *  editing, which the cell draws.
 *
 *  The note shows read-only under a mouse: the derived note, each value drawn
 *  in it from another column by its label, then the text. A right-click, or
 *  Shift+F2 on the focused cell, opens it for editing: each of those columns
 *  as its control, then a box for the text, each edit written as it is typed.
 *  On a phone a tap on a marked cell opens it, a second tap goes to the cell,
 *  and a long press opens it on an unmarked one. Esc or a press outside shuts
 *  it, and the focus goes back to the cell. */
export function useCellNote({
  column,
  row,
  schema,
  settings,
  underlaid,
  onNote,
  onCell,
}: {
  column: Column;
  row: Row;
  schema: Schema | undefined;
  settings: CellSettings;
  /** Whether the cell is showing an underlay, whose tint is its mark. */
  underlaid: boolean;
  /** Write the cell's note; absent where notes cannot be written. */
  onNote: ((text: string) => void) | undefined;
  /** Write a column drawn in the note, as its own cell would be written. */
  onCell: (column: Column, raw: string) => void;
}): {
  className: string;
  props: React.TdHTMLAttributes<HTMLTableCellElement> & {
    ref: React.RefObject<HTMLTableCellElement | null>;
  };
} {
  const cell = useRef<HTMLTableCellElement | null>(null);
  const [editing, setEditing] = useState(false);
  const press = useRef<{ timer: ReturnType<typeof setTimeout> | null; opened: boolean }>({
    timer: null,
    opened: false,
  });
  useEffect(
    () => () => {
      clearTimeout(press.current.timer ?? undefined);
      // A note whose cell has gone is shut with it.
      if (cell.current && isEditingNote(cell.current)) hideNote(cell.current);
    },
    [],
  );

  const notesOf = schema?.notes_in !== undefined && column.notes === true ? schema : null;
  const takesNotes = notesOf !== null;
  const inNote = notesOf ? noteColumns(notesOf.columns, column.field) : [];
  const text = notesOf ? storedNote(notesOf, row, column.field) : "";
  const marked = takesNotes ? noteMarked(text, settings, underlaid) : settings.note !== undefined && !underlaid;
  const editable = takesNotes && onNote !== undefined;

  // What the note says, read-only. Nothing at all is no note to show.
  const facts = inNote.flatMap((other) => {
    const value = row[other.field];
    if (other.type === "boolean") return value === true ? [other.label] : [];
    if (value === undefined || value === null || value === "") return [];
    if (other.type === "select") {
      const option = selectOptions(other, row).find((o) => o.value === String(value));
      return [option?.label ?? String(value)];
    }
    return [String(value)];
  });
  const shown =
    settings.note !== undefined || facts.length > 0 || text.trim() !== "" ? (
      <>
        {settings.note !== undefined && <div className="note-derived">{settings.note}</div>}
        {facts.map((fact, i) => (
          <div key={i} className="note-fact">
            {fact}
          </div>
        ))}
        {text.trim() !== "" && <div className="note-text">{text}</div>}
      </>
    ) : null;

  // The note open for editing, as it reads now: given to the layer that draws
  // it each time the cell draws, so it follows what is typed.
  const editor = (
    <>
      {settings.note !== undefined && <div className="note-derived">{settings.note}</div>}
      {inNote.map((other) => (
        <NoteControl
          key={other.field}
          column={other}
          row={row}
          onCell={(raw) => onCell(other, raw)}
        />
      ))}
      <textarea
        aria-label={`Note, ${column.label}`}
        value={text}
        data-autofocus
        onChange={(e) => onNote?.(e.target.value)}
        className="note-box"
      />
    </>
  );
  useEffect(() => {
    if (editing && cell.current) refreshNote(cell.current, editor);
  });

  const closeEditor = () => {
    setEditing(false);
    // The focus goes back to the cell: to its control where it has one.
    const target =
      cell.current?.querySelector<HTMLElement>("input, select, textarea, button") ??
      cell.current;
    target?.focus();
  };
  const openEditor = () => {
    if (!editable || !cell.current) return;
    showNote({ anchor: cell.current, content: editor, via: "edit", onClose: closeEditor });
    setEditing(true);
  };

  const showReadOnly = (via: "hover" | "tap") => {
    if (shown !== null && cell.current) showNote({ anchor: cell.current, content: shown, via });
  };

  // Events from the note reach the cell through React, since the note is the
  // cell's child there though it is drawn on the body; only the cell's own
  // count.
  const inside = (e: React.SyntheticEvent) => e.currentTarget.contains(e.target as Node);

  const props: React.TdHTMLAttributes<HTMLTableCellElement> & {
    ref: React.RefObject<HTMLTableCellElement | null>;
  } = {
    ref: cell,
    onPointerEnter: (e) => {
      if (e.pointerType !== "mouse" || isEditingNote()) return;
      if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) showReadOnly("hover");
    },
    onPointerLeave: (e) => {
      if (!isEditingNote()) hideNote(e.currentTarget);
    },
  };
  if (editable) {
    props.tabIndex = -1;
    props.onContextMenu = (e) => {
      if (!inside(e)) return;
      e.preventDefault();
      if (press.current.timer) clearTimeout(press.current.timer);
      openEditor();
    };
    props.onKeyDown = (e) => {
      if (e.key === "F2" && e.shiftKey && inside(e)) {
        e.preventDefault();
        openEditor();
      }
    };
  }
  if (editable || shown !== null) {
    props.onTouchStart = (e) => {
      if (!inside(e)) return;
      press.current.opened = false;
      if (press.current.timer) clearTimeout(press.current.timer);
      if (marked || editing) return;
      press.current.timer = setTimeout(() => {
        press.current.timer = null;
        press.current.opened = true;
        if (editable) openEditor();
        else showReadOnly("tap");
      }, LONG_PRESS);
    };
    props.onTouchMove = () => {
      if (press.current.timer) clearTimeout(press.current.timer);
      press.current.timer = null;
    };
    props.onTouchEnd = (e) => {
      if (!inside(e)) return;
      if (press.current.timer) clearTimeout(press.current.timer);
      press.current.timer = null;
      // A long press that opened the note goes no further.
      if (press.current.opened) {
        e.preventDefault();
        press.current.opened = false;
        return;
      }
      // The first tap on a marked cell opens its note rather than the cell;
      // the second goes to the cell.
      if (!marked || editing || isEditingNote(e.currentTarget)) {
        if (editing) setEditing(false);
        hideNote(e.currentTarget);
        return;
      }
      e.preventDefault();
      if (editable) openEditor();
      else showReadOnly("tap");
    };
  }

  return { className: marked ? " has-note" : "", props };
}

/** A column drawn in another's note, as the control its cell would use: a
 *  select as a select, and a boolean as a checkbox with two states. Any other
 *  type is a line of text. */
function NoteControl({
  column,
  row,
  onCell,
}: {
  column: Column;
  row: Row;
  onCell: (raw: string) => void;
}) {
  const value = row[column.field];
  if (column.type === "boolean") {
    return (
      <label className="note-control">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onCell(noteFlagRaw(e.target.checked))}
        />
        {column.label}
      </label>
    );
  }
  if (column.type === "select") {
    const shown = value == null ? "" : String(value);
    return (
      <label className="note-control">
        {column.label}
        <select value={shown} onChange={(e) => onCell(e.target.value)} aria-label={column.label}>
          <option value="" />
          {selectOptions(column, row).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label ?? option.value}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="note-control">
      {column.label}
      <input
        type="text"
        value={value == null ? "" : String(value)}
        onChange={(e) => onCell(e.target.value)}
        aria-label={column.label}
      />
    </label>
  );
}
