import { useEffect, useState } from "react";
import type { ViewParam } from "../lib/view";

/** One of a page's parameters: a select, or a box to type into. A view draws
 *  its parameters stacked under their labels above the page; a table draws
 *  them `inline` in its toolbar, each label beside its control, so the toolbar
 *  stays one line high. */
export function ParamControl({
  param,
  value,
  onAsk,
  inline = false,
}: {
  param: ViewParam;
  value: string;
  onAsk: (key: string, value: string) => void;
  inline?: boolean;
}) {
  // Typed text asks when it is finished rather than on every keystroke, since
  // each question is a fetch and an entry in the history. Enter asks without
  // leaving the field, so a reader can try several answers from the keyboard.
  const [typed, setTyped] = useState(value);
  useEffect(() => setTyped(value), [value]);

  const size = inline ? "w-auto max-w-full" : "w-full sm:w-56";
  return (
    <label
      className={
        inline ? "flex min-w-0 items-center gap-2" : "flex flex-col gap-1"
      }
    >
      <span className={inline ? "text-muted" : "text-sm text-muted"}>
        {param.label}
      </span>
      {param.type === "select" ? (
        <select
          value={value}
          onChange={(e) => onAsk(param.key, e.target.value)}
          aria-label={param.label}
          className={`field h-9 border border-border bg-page ${size}`}
        >
          {!param.options?.some((o) => o.value === value) && (
            <option value={value}>{value === "" ? "—" : value}</option>
          )}
          {param.options?.map((option, i) => (
            <option key={`${i}-${option.value}`} value={option.value}>
              {option.label ?? option.value}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={() => typed !== value && onAsk(param.key, typed)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && typed !== value) onAsk(param.key, typed);
          }}
          aria-label={param.label}
          className={`field h-9 border border-border bg-page ${size}`}
        />
      )}
    </label>
  );
}
