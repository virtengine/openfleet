import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("mui module theme binding", () => {
  it("uses a real imported binding for createTheme", () => {
    const source = readFileSync(resolve(process.cwd(), "ui/modules/mui.js"), "utf8");
    expect(source).toContain("createTheme as createMuiTheme");
    expect(source).toContain("export const veTheme = createMuiTheme(");
  });

  it("uses local imported bindings for ThemeProvider and SvgIcon helpers", () => {
    const source = readFileSync(resolve(process.cwd(), "ui/modules/mui.js"), "utf8");
    expect(source).toContain("ThemeProvider as MuiThemeProvider");
    expect(source).toContain("SvgIcon as MuiSvgIcon");
    expect(source).toContain("<${MuiThemeProvider} theme=${veTheme}>");
    expect(source).toContain("<${MuiSvgIcon} ...${props}");
  });

  it("keeps MUI overlays above the custom modal sheet", () => {
    const source = readFileSync(resolve(process.cwd(), "ui/modules/mui.js"), "utf8");
    expect(source).toContain("zIndex: {");
    expect(source).toContain("modal: 11000");
    expect(source).toContain("snackbar: 11050");
    expect(source).toContain("tooltip: 11100");
  });
});
