import { describe, expect, test } from "bun:test";
import { THEME_CHOICES, themeLabel } from "../src/lib/theme";

describe("the theme menu", () => {
  test("offers the system's choice, light and dark, each titled and saying what pressing it does", () => {
    expect(THEME_CHOICES).toEqual([
      { value: "system", title: "System", label: "Use the system theme" },
      { value: "light", title: "Light", label: "Use the light theme" },
      { value: "dark", title: "Dark", label: "Use the dark theme" },
    ]);
  });

  test("names its button by the choice in force", () => {
    expect(themeLabel("system")).toBe("Theme: system");
    expect(themeLabel("light")).toBe("Theme: light");
    expect(themeLabel("dark")).toBe("Theme: dark");
  });
});
