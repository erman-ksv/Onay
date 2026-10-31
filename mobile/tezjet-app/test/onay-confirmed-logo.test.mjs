import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("passenger and auth use the same user-confirmed logo asset", () => {
 for(const name of ["OnayPassengerHome.tsx","OnayAuthScreen.tsx"]){
  const code=readFileSync(new URL("../components/"+name,import.meta.url),"utf8");
  assert.match(code,/require\("\.\.\/assets\/onay-confirmed-logo\.jpg"\)/);
  assert.doesNotMatch(code,/require\("\.\.\/assets\/onay-original-logo\.png"\)/);
 }
});

test("confirmed logo is an actual 160-pixel JPEG image", () => {
 const img=readFileSync(new URL("../assets/onay-confirmed-logo.jpg",import.meta.url));
 assert.equal(img[0],0xff);assert.equal(img[1],0xd8);assert.equal(img.at(-2),0xff);assert.equal(img.at(-1),0xd9);
 // Decode JPEG dimensions by locating its start-of-frame marker.
 let width=0,height=0;
 for(let i=2;i<img.length-9;){
  if(img[i]!==255){i++;continue;}
  const marker=img[i+1];if(marker===0xd9||marker===0xda)break;
  if(marker===0xd8||marker===0x01||(marker>=0xd0&&marker<=0xd7)){i+=2;continue;}
  const n=img.readUInt16BE(i+2);
  if([0xc0,0xc1,0xc2,0xc3].includes(marker)){height=img.readUInt16BE(i+5);width=img.readUInt16BE(i+7);break;}
  i+=2+n;
 }
 assert.equal(width,160);assert.equal(height,160);
});
