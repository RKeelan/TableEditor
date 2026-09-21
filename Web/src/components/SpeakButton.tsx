import { useState } from "react";
import type { Speak } from "../lib/schema";
import { speakUrl } from "../lib/rows";

/** Read a stored override for a speak column's origin. Storage is unavailable
 *  in some browsers' private modes, where the column's own URL stands. */
function storedOverride(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Plays a cell's value through the service the column names. Disabled while
 *  the cell is empty, and tinted after a failed play until one succeeds. */
export function SpeakButton({
  speak,
  value,
  label,
}: {
  speak: Speak;
  value: string;
  label: string;
}) {
  const [failed, setFailed] = useState(false);
  const trimmed = value.trim();
  const disabled = trimmed === "";

  const onClick = () => {
    const audio = new Audio(
      speakUrl(speak, trimmed, storedOverride(speak.storage_key)),
    );
    audio.addEventListener("error", () => setFailed(true));
    audio
      .play()
      .then(() => setFailed(false))
      .catch(() => setFailed(true));
  };

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={`Play ${label.toLowerCase()}`}
      title={failed ? "The service did not answer" : "Play this value"}
      className={
        "flex h-8 w-8 shrink-0 select-none items-center justify-center rounded text-xs leading-none disabled:cursor-default disabled:opacity-30 " +
        (failed ? "text-bad" : "text-muted hover:text-accent")
      }
    >
      ▶
    </button>
  );
}
