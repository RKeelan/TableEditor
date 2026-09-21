// Which palette the page draws in, remembered per device.
//
// The choice is an attribute on the root element, which the stylesheet reads;
// "system" removes it, and the stylesheet then follows what the browser
// prefers. It is stored rather than sent anywhere: it belongs to the machine
// the tables are read on, not to the tables.
//
// Storage is unavailable in some browsers' private modes and can throw on
// either reading or writing, so every use of it is guarded and the page works
// without it: the choice still holds for as long as the page is open.

export type ThemeChoice = "system" | "light" | "dark";

/** The key `index.html` reads before the first paint. The two must agree. */
export const THEME_KEY = "table-editor-theme";

/** What was chosen last time, or "system" where nothing was or where the
 *  stored value is not a choice this page makes. */
export function storedTheme(): ThemeChoice {
  try {
    const chosen = window.localStorage.getItem(THEME_KEY);
    return chosen === "light" || chosen === "dark" ? chosen : "system";
  } catch {
    return "system";
  }
}

/** Draw in `choice` from now on, and remember it. "system" is remembered by
 *  forgetting: an absent key is the page following the browser. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);

  try {
    if (choice === "system") window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, choice);
  } catch {
    // The choice holds for this page either way.
  }
}
