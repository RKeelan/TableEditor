// Moving between a grid's cells from the keyboard, as a spreadsheet does: Tab
// goes to the next cell to the right, and Enter to the next cell below.

/** Which way a key moves the focus. */
export type GridMove = "right" | "left" | "down" | "up";

/** What a keystroke in a cell's control asks for, or null where the key is
 *  the control's own. Tab and Shift+Tab move right and left from any control;
 *  Enter and Shift+Enter move down and up from a box of one line or a select,
 *  but not from a box of several lines, where Enter breaks the line, nor from
 *  a button, which Enter presses. A key held with Ctrl, Alt or Meta is left
 *  alone, as is one a control has already handled. */
export function gridMove(key: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  defaultPrevented: boolean;
  /** The tag of the focused control, lower case. */
  tag: string;
}): GridMove | null {
  if (key.defaultPrevented || key.ctrlKey || key.altKey || key.metaKey) return null;
  if (key.key === "Tab") return key.shiftKey ? "left" : "right";
  if (key.key === "Enter" && (key.tag === "input" || key.tag === "select")) {
    return key.shiftKey ? "up" : "down";
  }
  return null;
}

/** The cell a move lands on, as [row, column], or null where there is none.
 *  `editable[r][c]` says whether that cell can be focused. Right and left read
 *  the grid row by row, so the last cell of a row goes on to the first of the
 *  next; down and up keep the column. Cells that cannot be focused are passed
 *  over. */
export function gridTarget(
  editable: readonly (readonly boolean[])[],
  row: number,
  column: number,
  move: GridMove,
): [number, number] | null {
  if (move === "down" || move === "up") {
    const step = move === "down" ? 1 : -1;
    for (let r = row + step; r >= 0 && r < editable.length; r += step) {
      if (editable[r][column]) return [r, column];
    }
    return null;
  }
  const step = move === "right" ? 1 : -1;
  let r = row;
  let c = column + step;
  while (r >= 0 && r < editable.length) {
    while (c >= 0 && c < editable[r].length) {
      if (editable[r][c]) return [r, c];
      c += step;
    }
    r += step;
    if (r >= 0 && r < editable.length) c = step === 1 ? 0 : editable[r].length - 1;
  }
  return null;
}
