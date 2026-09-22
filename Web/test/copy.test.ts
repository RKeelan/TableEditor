import { describe, expect, test } from "bun:test";
import {
  type Clipboard,
  clipboardFor,
  copyKeysFor,
  copyMessage,
  copyText,
} from "../src/lib/copy";

/** A clipboard that records what it was given, or refuses. */
function clipboard(refuse = false): Clipboard & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    writeText: async (text: string) => {
      if (refuse) throw new Error("not allowed");
      written.push(text);
    },
  };
}

describe("copying a field's text", () => {
  test("uses the Clipboard API on a secure origin", async () => {
    const api = clipboard();
    let selected = 0;
    const outcome = await copyText("Dear editor,", {
      clipboard: clipboardFor(true, api),
      copySelection: () => {
        selected++;
        return true;
      },
    });
    expect(outcome).toBe("copied");
    expect(api.written).toEqual(["Dear editor,"]);
    expect(selected).toBe(0);
  });

  test("copies the selection on an insecure origin, without trying the API", async () => {
    const api = clipboard();
    let selected = 0;
    const outcome = await copyText("Dear editor,", {
      clipboard: clipboardFor(false, api),
      copySelection: () => {
        selected++;
        return true;
      },
    });
    expect(outcome).toBe("copied");
    expect(api.written).toEqual([]);
    expect(selected).toBe(1);
  });

  test("copies the selection when the API refuses", async () => {
    const outcome = await copyText("Dear editor,", {
      clipboard: clipboard(true),
      copySelection: () => true,
    });
    expect(outcome).toBe("copied");
  });

  test("leaves the text selected when the browser will not copy it", async () => {
    expect(
      await copyText("Dear editor,", {
        clipboard: undefined,
        copySelection: () => false,
      }),
    ).toBe("selected");
    expect(
      await copyText("Dear editor,", {
        clipboard: clipboard(true),
        copySelection: () => {
          throw new Error("no such command");
        },
      }),
    ).toBe("selected");
  });

  test("gives up on a Clipboard API that does not answer", async () => {
    let selected = 0;
    const outcome = await copyText("Dear editor,", {
      clipboard: { writeText: () => new Promise<void>(() => {}) },
      copySelection: () => {
        selected++;
        return true;
      },
      patienceMs: 10,
    });
    expect(outcome).toBe("copied");
    expect(selected).toBe(1);
  });

  test("says what happened, naming the way to copy a selection", () => {
    expect(copyMessage("copied", "ctrl")).toBe("Copied");
    expect(copyMessage("selected", "ctrl")).toBe(
      "Selected; press Ctrl+C to copy",
    );
    expect(copyMessage("selected", "command")).toBe(
      "Selected; press ⌘C to copy",
    );
    expect(copyMessage("selected", "touch")).toBe(
      "Selected; copy it from the selection menu",
    );
  });
});

describe("how a reader copies a selection by hand", () => {
  const windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0";
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1";
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)";
  const android = "Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140.0";
  const keys = (userAgent: string, maxTouchPoints: number, coarse: boolean) =>
    copyKeysFor({ userAgent, maxTouchPoints, coarse });

  test("is Ctrl+C on Windows and Linux, and ⌘C on a Mac", () => {
    expect(keys(windows, 0, false)).toBe("ctrl");
    expect(keys(mac, 0, false)).toBe("command");
  });

  test("is the selection's menu on an iPhone, an iPad, or any phone", () => {
    expect(keys(iphone, 5, true)).toBe("touch");
    // An iPad asking for the desktop site says it is a Mac.
    expect(keys(mac, 5, false)).toBe("touch");
    expect(keys(android, 5, true)).toBe("touch");
  });

  test("is still a key on a laptop with a touch screen and a mouse", () => {
    expect(keys(windows, 10, false)).toBe("ctrl");
  });
});
