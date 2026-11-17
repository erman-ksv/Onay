import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const qa = readFileSync(new URL("../../../scripts/line-ride-browser-qa.py", import.meta.url), "utf8");

test("line-ride QA rejects screenshots falsely labeled mobile or desktop", () => {
  const shot = qa.slice(qa.indexOf("    def shot(self, page, name):"), qa.indexOf("    def screenshot(self, name):"));
  assert.match(shot, /if "mobile-390" in name:/);
  assert.match(shot, /viewport\["width"\] == 390/);
  assert.match(shot, /if "desktop" in name:/);
  assert.match(shot, /viewport\["width"\] == 1440/);
});

test("retained, reverse and passenger history evidence switches to the declared viewport", () => {
  assert.match(qa, /set_viewport_size\(\{"width": 390, "height": 844\}\)[\s\S]{0,300}self\.shot\(self\.page, "mobile-390-finished-retained-enrollment"\)/);
  assert.match(qa, /set_viewport_size\(\{"width": 390, "height": 844\}\)[\s\S]{0,300}self\.shot\(self\.page, "mobile-390-new-B-to-A-enrollment"\)/);
  assert.match(qa, /page\.set_viewport_size\(\{"width": 1440, "height": 1000\}\)\s+self\.shot\(page, "task3-14-history-desktop"\)/);
});
