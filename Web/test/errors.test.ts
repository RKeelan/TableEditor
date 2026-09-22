import { describe, expect, test } from "bun:test";
import { ApiError, changedOnDisk, describeError } from "../src/lib/errors";

describe("a request the server refused", () => {
  test("carries the status as well as what the server said", () => {
    const err = new ApiError(409, "the table changed on disk");
    expect(err.status).toBe(409);
    expect(describeError(err)).toBe("the table changed on disk");
  });
});

describe("telling a refused write from any other failure", () => {
  test("is the status, not the words the server used", () => {
    expect(changedOnDisk(new ApiError(409, "anything at all"))).toBe(true);
    expect(changedOnDisk(new ApiError(500, "the table changed on disk"))).toBe(
      false,
    );
  });

  test("is false for a failure that never reached the server", () => {
    expect(changedOnDisk(new Error("Failed to fetch"))).toBe(false);
    expect(changedOnDisk("409")).toBe(false);
    expect(changedOnDisk(undefined)).toBe(false);
  });
});
