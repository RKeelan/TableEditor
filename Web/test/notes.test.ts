import { describe, expect, test } from "bun:test";
import { placeNote } from "../src/lib/notes";

const cell = (left: number, top: number, width = 100, height = 30) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});
const size = { width: 200, height: 80 };
const viewport = { width: 1000 };

describe("where a cell's note goes", () => {
  test("beside the cell, level with it, where there is room", () => {
    expect(placeNote(cell(100, 300), size, viewport, 900)).toEqual({
      left: 204,
      top: 300,
    });
  });

  test("under the cell where there is no room beside it", () => {
    expect(placeNote(cell(750, 300), size, viewport, 900)).toEqual({
      left: 750,
      top: 334,
    });
  });

  test("held inside the window when the cell is near its right-hand edge", () => {
    expect(placeNote(cell(880, 300), size, viewport, 900).left).toBe(792);
  });

  test("over the cell where there is no room under it above the floor", () => {
    // The floor is the top of the docked cards: a note under the cell would
    // reach 334 + 80, past it.
    expect(placeNote(cell(750, 300), size, viewport, 400)).toEqual({
      left: 750,
      top: 216,
    });
  });

  test("never behind the docked cards, even beside its cell", () => {
    const placed = placeNote(cell(100, 650), size, viewport, 700);
    expect(placed.left).toBe(204);
    expect(placed.top + size.height).toBeLessThanOrEqual(700 - 4);
  });

  test("never above the top of the window", () => {
    expect(placeNote(cell(750, 20), size, viewport, 100).top).toBe(8);
  });
});
