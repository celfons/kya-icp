import { describe, expect, it } from "vitest";
import { DASHBOARD_HTML } from "../src/dashboard.js";

describe("dashboard", () => {
  it("has an inline script that parses", () => {
    const scripts = [...DASHBOARD_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(() => new Function(s)).not.toThrow();
  });
});
