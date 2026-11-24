import { describe, expect, test } from "bun:test";
import { gridMove, gridTarget } from "../src/lib/grid";

const key = (k: string, tag = "input", extra: Partial<Parameters<typeof gridMove>[0]> = {}) => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  defaultPrevented: false,
  tag,
  ...extra,
});

describe("gridMove", () => {
  test("Tab moves right and Shift+Tab left, from any control", () => {
    expect(gridMove(key("Tab"))).toBe("right");
    expect(gridMove(key("Tab", "button", { shiftKey: true }))).toBe("left");
    expect(gridMove(key("Tab", "textarea"))).toBe("right");
  });

  test("Enter moves down and Shift+Enter up, from a box of one line or a select", () => {
    expect(gridMove(key("Enter"))).toBe("down");
    expect(gridMove(key("Enter", "select", { shiftKey: true }))).toBe("up");
  });

  test("Enter is a box of several lines' own, and a button's", () => {
    expect(gridMove(key("Enter", "textarea"))).toBeNull();
    expect(gridMove(key("Enter", "button"))).toBeNull();
  });

  test("a key held with a modifier, or already handled, is left alone", () => {
    expect(gridMove(key("Tab", "input", { ctrlKey: true }))).toBeNull();
    expect(gridMove(key("Enter", "input", { altKey: true }))).toBeNull();
    expect(gridMove(key("Enter", "input", { metaKey: true }))).toBeNull();
    expect(gridMove(key("Enter", "input", { defaultPrevented: true }))).toBeNull();
  });

  test("other keys are the control's", () => {
    expect(gridMove(key("ArrowDown"))).toBeNull();
    expect(gridMove(key("Escape"))).toBeNull();
  });
});

describe("gridTarget", () => {
  // Three rows; the middle one is read-only but for its last cell.
  const grid = [
    [true, true, true],
    [false, false, true],
    [true, false, true],
  ];

  test("right goes to the next cell, and on to the next row's first", () => {
    expect(gridTarget(grid, 0, 0, "right")).toEqual([0, 1]);
    expect(gridTarget(grid, 0, 2, "right")).toEqual([1, 2]);
    expect(gridTarget(grid, 1, 2, "right")).toEqual([2, 0]);
  });

  test("left goes back, and on to the previous row's last", () => {
    expect(gridTarget(grid, 2, 0, "left")).toEqual([1, 2]);
    expect(gridTarget(grid, 2, 2, "left")).toEqual([2, 0]);
  });

  test("down and up keep the column and pass over cells that cannot be focused", () => {
    expect(gridTarget(grid, 0, 0, "down")).toEqual([2, 0]);
    expect(gridTarget(grid, 2, 0, "up")).toEqual([0, 0]);
    expect(gridTarget(grid, 0, 2, "down")).toEqual([1, 2]);
  });

  test("there is nothing past the grid's ends", () => {
    expect(gridTarget(grid, 2, 2, "right")).toBeNull();
    expect(gridTarget(grid, 0, 0, "left")).toBeNull();
    expect(gridTarget(grid, 2, 1, "down")).toBeNull();
    expect(gridTarget(grid, 0, 1, "up")).toBeNull();
    expect(gridTarget(grid, 2, 1, "up")).toEqual([0, 1]);
  });
});
