import { useEffect, useId, useRef, useState } from "react";
import {
  THEME_CHOICES,
  type ThemeChoice,
  applyTheme,
  storedTheme,
  themeLabel,
} from "../lib/theme";

/** Which palette to draw in: one round button showing the choice in force,
 *  which opens the three. The choice is remembered per device and applied at
 *  once, so nothing is fetched and nothing is saved to a table.
 *
 *  The stored choice is read when the menu first draws rather than held in
 *  the shell, because the page has already acted on it: a script in the head
 *  sets the attribute before the first paint, and this only has to agree with
 *  what that found.
 *
 *  Opening puts the focus on the choice in force, and choosing one or Escape
 *  puts it back on the button. A click elsewhere shuts the options, and so
 *  does tabbing out of them, so options that are still open never sit behind
 *  a keyboard reader who has moved on. */
export function ThemeMenu() {
  const [choice, setChoice] = useState<ThemeChoice>(storedTheme);
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const inForce = useRef<HTMLButtonElement>(null);
  const options = useId();

  // The options are hidden until the render that opens them, so the focus
  // moves once they are there to take it.
  useEffect(() => {
    if (open) inForce.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const click = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("click", click);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("click", click);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const choose = (value: ThemeChoice) => {
    applyTheme(value);
    setChoice(value);
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div
      ref={menu}
      className="theme-menu"
      onBlur={(event) => {
        // Only a move to something else on the page shuts it here. Focus that
        // goes nowhere is a click on something that takes none, which the
        // click rule answers, and some browsers do that for a click on a
        // button, the button itself included.
        const next = event.relatedTarget;
        if (next instanceof Node && !event.currentTarget.contains(next)) {
          setOpen(false);
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="theme-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={options}
        aria-label={themeLabel(choice)}
        onClick={() => setOpen((was) => !was)}
      >
        <ThemeIcon choice={choice} />
      </button>
      <div
        id={options}
        className="theme-options"
        role="group"
        aria-label="Theme"
        hidden={!open}
      >
        {THEME_CHOICES.map((option) => {
          const on = option.value === choice;
          return (
            <button
              key={option.value}
              ref={on ? inForce : undefined}
              type="button"
              className="theme-option"
              aria-label={option.label}
              aria-pressed={on}
              title={option.title}
              onClick={() => choose(option.value)}
            >
              <ThemeIcon choice={option.value} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A monitor for the system's choice, a sun for the light theme, and a moon
 *  for the dark one. */
function ThemeIcon({ choice }: { choice: ThemeChoice }) {
  switch (choice) {
    case "system":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="4" y="5" width="16" height="11" rx="2"></rect>
          <path d="M10 19h4"></path>
          <path d="M12 16v3"></path>
        </svg>
      );
    case "light":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="4.5"></circle>
          <path d="M12 2.5v2.25"></path>
          <path d="M12 19.25v2.25"></path>
          <path d="M21.5 12h-2.25"></path>
          <path d="M4.75 12H2.5"></path>
          <path d="M18.72 5.28l-1.59 1.59"></path>
          <path d="M6.87 17.13l-1.59 1.59"></path>
          <path d="M18.72 18.72l-1.59-1.59"></path>
          <path d="M6.87 6.87L5.28 5.28"></path>
        </svg>
      );
    case "dark":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M 20.948 19.016 L 19.997 19.845 L 19.370 20.270 L 18.622 20.695 L 17.644 21.145 L 16.444 21.570 L 16.091 21.645 L 14.673 21.870 L 13.475 21.925 L 12.294 21.850 L 11.384 21.695 L 10.256 21.395 L 9.206 20.995 L 8.330 20.570 L 7.403 19.995 L 6.559 19.347 L 5.655 18.497 L 4.805 17.472 L 4.080 16.347 L 3.555 15.270 L 3.180 14.295 L 2.955 13.441 L 2.780 12.331 L 2.700 11.431 L 2.700 10.594 L 2.750 10.406 L 2.750 9.909 L 2.955 8.684 L 3.202 7.764 L 3.680 6.505 L 4.130 5.628 L 4.580 4.903 L 5.303 3.959 L 6.034 3.178 L 7.053 2.305 L 8.078 1.655 L 8.125 1.669 L 7.680 2.430 L 7.230 3.355 L 6.830 4.381 L 6.580 5.233 L 6.352 6.378 L 6.255 7.228 L 6.250 9.056 L 6.430 10.316 L 6.630 11.094 L 6.880 11.944 L 7.205 12.744 L 7.605 13.545 L 8.130 14.422 L 9.127 15.695 L 10.153 16.695 L 11.478 17.670 L 12.255 18.120 L 13.330 18.623 L 14.633 19.045 L 15.634 19.273 L 16.359 19.375 L 16.909 19.425 L 18.297 19.425 L 19.161 19.348 L 20.909 18.977 Z"></path>
        </svg>
      );
  }
}
