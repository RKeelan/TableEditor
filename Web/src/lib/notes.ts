// Where a cell's note is drawn. The note is a box over the page, placed
// against its cell when it opens: the rule is here, where it can be tested
// without a browser, and the component measures and applies it.

/** A box on the screen, in the viewport's own pixels. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** How far a note keeps from its cell, and from the edges it may not cross. */
const GAP = 4;
const MARGIN = 8;

/** Where a note `width` by `height` goes for a cell at `cell`, in a window
 *  `viewport` wide, above a `floor` it may not cross: the window's foot, or
 *  the top of a band of docked cards.
 *
 *  Beside the cell, level with it, where there is room to the right. Otherwise
 *  under it, its left edge with the cell's as far as the window allows, or
 *  over it where there is no room under it above the floor. Wherever it goes,
 *  it is held inside the window and above the floor, so it never sits behind
 *  the docked cards. */
export function placeNote(
  cell: Rect,
  size: { width: number; height: number },
  viewport: { width: number },
  floor: number,
): { left: number; top: number } {
  const { width, height } = size;
  let left: number;
  let top: number;
  if (cell.right + GAP + width <= viewport.width - MARGIN) {
    left = cell.right + GAP;
    top = cell.top;
  } else {
    left = Math.max(MARGIN, Math.min(cell.left, viewport.width - width - MARGIN));
    top =
      cell.bottom + GAP + height <= floor
        ? cell.bottom + GAP
        : cell.top - height - GAP;
  }
  top = Math.max(MARGIN, Math.min(top, floor - height - GAP));
  return { left, top };
}
