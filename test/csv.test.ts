import { describe, expect, it } from "vitest";
import { toCsv } from "../src/csv.js";

describe("toCsv", () => {
  it("quotes only when needed and uses CRLF", () => {
    expect(toCsv(["a", "b"], [["x,y", 'q"t'], [1, null]])).toBe('a,b\r\n"x,y","q""t"\r\n1,\r\n');
  });
});
