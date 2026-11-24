import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { postAction } from "../src/lib/api";
import { NoAnswerError } from "../src/lib/errors";

const realFetch = globalThis.fetch;

beforeAll(() => {
  // The API root is worked out from the page's address.
  (globalThis as { window?: unknown }).window = {
    location: { pathname: "/" },
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A server that never answers, as a dropped connection looks to the page:
 *  the request fails only when its signal gives up on it. */
function neverAnswers() {
  globalThis.fetch = ((_: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(init.signal?.reason),
      );
    })) as typeof fetch;
}

describe("an action the server does not answer", () => {
  test("is given up on, saying to reload and look", async () => {
    neverAnswers();
    const posted = postAction("story", "submit", {}, {}, { timeoutMs: 20 });
    await expect(posted).rejects.toBeInstanceOf(NoAnswerError);
    await expect(posted).rejects.toThrow(
      "Reload the page to see whether this was saved.",
    );
  });

  test("stopped by its caller is not reported as unanswered", async () => {
    neverAnswers();
    const stop = new AbortController();
    const posted = postAction(
      "story",
      "submit",
      {},
      {},
      { signal: stop.signal, timeoutMs: 1000 },
    );
    stop.abort();
    await expect(posted).rejects.not.toBeInstanceOf(NoAnswerError);
  });
});

describe("an action the server answers", () => {
  test("resolves to what it said", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ confirmation: "Done." }), {
        status: 200,
      })) as unknown as typeof fetch;
    const answer = await postAction("story", "submit", {}, {});
    expect(answer.confirmation).toBe("Done.");
  });
});
