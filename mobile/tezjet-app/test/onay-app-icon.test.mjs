import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import icons from "../scripts/prepare-onay-icons.cjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "app.json"), "utf8")).expo;
const pixel = (png, x, y) => [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4)];

test("launcher is white, adaptive foreground transparent and all logo pixels inside circular mask safe area", () => {
  icons.generate();
  assert.equal(config.name, "Onay");
  assert.equal(config.android.package, "uz.tezjet.app");
  assert.equal(config.android.versionCode, 119);
  assert.equal(config.android.adaptiveIcon.backgroundColor, "#ffffff");
  const regular = icons.decodePng(readFileSync(join(root, config.icon)));
  const adaptive = icons.decodePng(readFileSync(join(root, config.android.adaptiveIcon.foregroundImage)));
  for (const img of [regular, adaptive]) {
    assert.equal(img.width, 1024);
    assert.equal(img.height, 1024);
  }
  for (const [x,y] of [[0,0],[0,1023],[1023,0],[1023,1023],[125,512],[512,125]]) {
    assert.deepEqual(pixel(regular,x,y),[255,255,255,255],"white launcher padding");
    assert.equal(pixel(adaptive,x,y)[3],0,"transparent adaptive padding");
  }
  const b=icons.bounds(adaptive,12);
  assert.ok(b.width<=472 && b.height<=472, JSON.stringify(b));
  assert.ok(Math.abs(b.left + b.width/2 - 512)<=3, JSON.stringify(b));
  assert.ok(Math.abs(b.top + b.height/2 - 512)<=3, JSON.stringify(b));
  // Android adaptive round safe circle is about 2/3 canvas diameter.
  for (const [x,y] of [[b.left,b.top],[b.left+b.width,b.top],[b.left,b.top+b.height],[b.left+b.width,b.top+b.height]])
    assert.ok(Math.hypot(x-512,y-512)<340,"foreground must fit even round Android masks");
  let nonWhite=0;
  for(let i=0;i<regular.data.length;i+=4)
    if(regular.data[i]<250 || regular.data[i+1]<250 || regular.data[i+2]<250) nonWhite++;
  assert.ok(nonWhite>2000,"original logo must remain visible over white");
});

test("approved original logo remains the unchanged source for on-screen branding", () => {
  for (const file of ["components/OnayPassengerHome.tsx","components/OnayAuthScreen.tsx"]) {
    const screen = readFileSync(join(root, file), "utf8");
    assert.ok(screen.includes('require("../assets/onay-original-logo.png")'),file);
  }
  const configSource=readFileSync(join(root,"app.config.ts"),"utf8");
  assert.match(configSource,/prepare-onay-icons\.cjs/);
  assert.match(readFileSync(join(root,"scripts/prepare-onay-icons.cjs"),"utf8"),/MAX_LOGO = 472/);
});
