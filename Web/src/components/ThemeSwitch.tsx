import { useState } from "react";
import { type ThemeChoice, applyTheme, storedTheme } from "../lib/theme";

const CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Which palette to draw in. It is remembered per device and applied at once,
 *  so nothing is fetched and nothing is saved to a table.
 *
 *  The stored choice is read when the switch first draws rather than held in
 *  the shell, because the page has already acted on it: a script in the head
 *  sets the attribute before the first paint, and this only has to agree with
 *  what that found. */
export function ThemeSwitch() {
  const [choice, setChoice] = useState<ThemeChoice>(storedTheme);

  return (
    <div className="segmented" role="group" aria-label="Theme">
      {CHOICES.map((option) => (
        <label key={option.value} className="segment">
          <input
            type="radio"
            name="theme"
            value={option.value}
            checked={choice === option.value}
            onChange={() => {
              setChoice(option.value);
              applyTheme(option.value);
            }}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}
