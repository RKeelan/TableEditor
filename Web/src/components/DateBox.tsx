// The box a date is typed into, in a table's cell and in a form, with a button
// beside it that opens the browser's own calendar.

import { useEffect, useRef, useState } from "react";
import {
  DATE_PLACEHOLDER,
  dateEdit,
  dateHint,
  openPicker,
  pickerDay,
} from "../lib/dates";
import { typedInto } from "./parts";

interface DateBoxProps {
  /** The stored value, whatever it is, which the calendar opens on where it
   *  is a day. */
  stored: unknown;
  /** What the box shows when it is not being typed into. */
  displayText: string;
  allowMonth?: boolean;
  /** The name of the field, which the calendar button's name is made from. */
  label: string;
  /** The text box's accessible name, where no `<label>` gives it one. */
  ariaLabel?: string;
  id?: string;
  /** What the box's tooltip says at displayText. */
  title?: string;
  /** Whether what the box reads at displayText is already marked by its cell. */
  marked?: boolean;
  /** The classes of the box and its button together: their width. */
  className?: string;
  /** The classes of the text box. */
  boxClassName: string;
  style?: React.CSSProperties;
  /** What the box now holds: what was typed, or the ISO day that was picked. */
  onEdit: (text: string) => void;
  /** Record a keystroke that left the box reading as it did. */
  onMark?: () => void;
}

/** A text box holding a date as it reads, and a button for the calendar.
 *
 *  While it is focused the box holds what is typed, so a date half typed stays
 *  in it until it is a whole date or nothing; a box held to the stored value
 *  would have it put back over the half-typed one with each keystroke. Focusing
 *  it selects all of it, so a new date is typed straight over the old. When it
 *  is left it reads `displayText` again, which puts what was typed in canonical form.
 *
 *  Text that is not a date is marked for as long as the box holds it, and fails
 *  the browser's own validation, which is what stops a form holding it from
 *  being saved. A box outside a form is not affected by that.
 *
 *  The calendar is a browser's own date box, hidden and laid over the button so
 *  that a browser opens the calendar there. Where the browser cannot open one,
 *  the button puts the focus in the text box instead, so that the date can be
 *  typed. */
export function DateBox({
  stored,
  displayText,
  allowMonth = false,
  label,
  ariaLabel,
  id,
  title,
  marked = false,
  className = "",
  boxClassName,
  style,
  onEdit,
  onMark = () => {},
}: DateBoxProps) {
  // What is being typed, shown in place of `displayText` until the box is left; null
  // at displayText.
  const [typed, setTyped] = useState<string | null>(null);
  const text = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const shown = typed ?? displayText;
  const notDate = dateEdit(shown, allowMonth).kind === "none";
  const flagged = notDate && (typed !== null || !marked);
  const hint = dateHint(allowMonth);

  useEffect(() => {
    text.current?.setCustomValidity(notDate ? hint : "");
  }, [notDate, hint]);

  return (
    <span className={"date-box " + className} style={style}>
      <input
        ref={text}
        id={id}
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder={DATE_PLACEHOLDER}
        value={shown}
        onFocus={(e) => {
          setTyped(displayText);
          // On the next tick, so the click that focused the box does not put
          // the caret where it landed and undo the selection.
          const box = e.currentTarget;
          setTimeout(() => {
            if (document.activeElement === box) box.select();
          }, 0);
        }}
        {...typedInto<HTMLInputElement>(
          shown,
          (box) => {
            setTyped(box.value);
            onEdit(box.value);
          },
          onMark,
        )}
        onBlur={() => setTyped(null)}
        aria-label={ariaLabel}
        aria-invalid={flagged || undefined}
        title={flagged ? hint : title}
        className={boxClassName + " min-w-0 flex-1" + (flagged ? " cell-error" : "")}
      />
      <button
        type="button"
        aria-label={`Choose ${label} from a calendar`}
        title="Choose from a calendar"
        className="date-button"
        onClick={() => {
          if (picker.current && !openPicker(picker.current)) text.current?.focus();
        }}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M3 3.5h10a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1ZM2 7h12M5 2v3M11 2v3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <input
        ref={picker}
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        className="date-picker"
        value={pickerDay(stored)}
        onChange={(e) => {
          setTyped(null);
          onEdit(e.currentTarget.value);
        }}
      />
    </span>
  );
}
