import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../components/PassengerRouteOrder.tsx", import.meta.url), "utf8");

test("route passenger seat controls keep centered, font-independent +/- glyphs", () => {
  for (const id of ["route-seats-minus", "route-seats-plus"]) {
    assert.ok(source.includes(`testID="${id}"`), `missing ${id}`);
  }
  assert.equal((source.match(/width: 48, height: 48, borderRadius: 24/g) ?? []).length, 2);
  assert.equal((source.match(/accessible={false} style={themeStyles.stepGlyph}/g) ?? []).length, 2);
  assert.match(source, /stepGlyph:\{width:20,height:20,alignItems:"center",justifyContent:"center"\}/);
  assert.match(source, /stepHorizontal:\{width:16,height:2,borderRadius:1,backgroundColor:"#5bd62f"\}/);
  assert.match(source, /stepVertical:\{position:"absolute",width:2,height:16,borderRadius:1,backgroundColor:"#5bd62f"\}/);
  assert.match(source, /stepStroke: \{ backgroundColor: "#175444" \}/);
  assert.ok(!source.includes("lightStyles.stepStroke"));
});

test("route seat bounds, submitting guards and accessible labels remain intact", () => {
  assert.match(source, /accessibilityLabel="Уменьшить количество мест"/);
  assert.match(source, /accessibilityLabel="Увеличить количество мест"/);
  assert.match(source, /disabled=\{seats <= 1 \|\| submitting\}/);
  assert.match(source, /disabled=\{seats >= 8 \|\| submitting\}/);
  assert.match(source, /setSeats\(Math\.max\(1, seats - 1\)\)/);
  assert.match(source, /setSeats\(Math\.min\(8, seats \+ 1\)\)/);
});
