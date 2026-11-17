import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const appRequire = createRequire(new URL("../package.json", import.meta.url));
const expoRequire = createRequire(appRequire.resolve("expo/package.json"));
const wrapperRequire = createRequire(expoRequire.resolve("@expo/metro/package.json"));
const metroRequire = createRequire(wrapperRequire.resolve("metro/package.json"));
const assets = metroRequire("./src/Assets.js");
const decoderEntry = metroRequire.resolve("image-size");
// Captured from the unmodified actual Metro0.83.3/image-size1.2.1 consumer.
const baseline = {
  "assets/onay-adaptive-foreground.png": {"width": 1024, "height": 1024, "name": "onay-adaptive-foreground", "type": "png", "scales": [1], "hash": "ac972faaf2b121ccebfec56cb9117397", "httpServerLocation": "/assets/assets"},
  "assets/onay-confirmed-logo.jpg": {"width": 160, "height": 160, "name": "onay-confirmed-logo", "type": "jpg", "scales": [1], "hash": "4cbb3b0347edf3508ec062e9df1f0469", "httpServerLocation": "/assets/assets"},
  "assets/onay-launcher-icon.png": {"width": 1024, "height": 1024, "name": "onay-launcher-icon", "type": "png", "scales": [1], "hash": "9be347eb9695c04f3e329196531413d8", "httpServerLocation": "/assets/assets"},
  "assets/onay-nav-chat.png": {"width": 48, "height": 48, "name": "onay-nav-chat", "type": "png", "scales": [1], "hash": "1089c0a294f523e6a129cd68220f0fb5", "httpServerLocation": "/assets/assets"},
  "assets/onay-nav-home.png": {"width": 48, "height": 48, "name": "onay-nav-home", "type": "png", "scales": [1], "hash": "b4314b92d632bc5b25352fa44f9930d6", "httpServerLocation": "/assets/assets"},
  "assets/onay-nav-trips.png": {"width": 48, "height": 48, "name": "onay-nav-trips", "type": "png", "scales": [1], "hash": "d03e86c1b89148736ad7bea6862184cb", "httpServerLocation": "/assets/assets"},
  "assets/onay-nav-user.png": {"width": 48, "height": 48, "name": "onay-nav-user", "type": "png", "scales": [1], "hash": "92c701af3564ef6688ea69a91b49f745", "httpServerLocation": "/assets/assets"},
  "assets/onay-original-logo.png": {"width": 240, "height": 240, "name": "onay-original-logo", "type": "png", "scales": [1], "hash": "286f16b8834c07a957b23b1182cb0652", "httpServerLocation": "/assets/assets"},
  "assets/onay-v2/back.png": {"width": 64, "height": 64, "name": "back", "type": "png", "scales": [1], "hash": "a9e3bbddb9ff3dd01bcc4a29f1915b50", "httpServerLocation": "/assets/assets/onay-v2"},
  "assets/onay-v2/car.png": {"width": 64, "height": 64, "name": "car", "type": "png", "scales": [1], "hash": "6cc76e31ca98faab75e126445619c2bc", "httpServerLocation": "/assets/assets/onay-v2"},
  "assets/onay-v2/chat.png": {"width": 64, "height": 64, "name": "chat", "type": "png", "scales": [1], "hash": "28145f59cf160a21ec56c9e31a75cb9e", "httpServerLocation": "/assets/assets/onay-v2"},
  "assets/onay-v2/check.png": {"width": 64, "height": 64, "name": "check", "type": "png", "scales": [1], "hash": "6d2fdb8cf7be86199ececac5f51b40e4", "httpServerLocation": "/assets/assets/onay-v2"},
  "assets/onay-v2/chev.png": {"width": 64, "height": 64, "name": "chev", "type": "png", "scales": [1], "hash": "3c0ea054b24956b6744f127333e0c43d", "httpServerLocation": "/assets/assets/onay-v2"},
  "assets/onay-v2/city.png": {"width": 64, "height": 64, "name": "city", "type": "png", "scales": [1], "hash": "2281810f8427889f443e50d7437334bd", "httpServerLocation": "/assets/assets/onay-v2"},
  "assets/onay-v2/clock.png": {"width": 64, "height": 64, "name": "clock", "type": "png", "scales": [1], "hash": "bda0e42cf0b461b0ab27de1f5297bbfc", "httpServerLocation": "/assets/assets/onay-v2"},
  "assets/onay-v2/gear.png": {"width": 64, "height": 64, "name": "gear", "type": "png", "scales": [1], "hash": "e0c46b6b5d25c1164c776b9b3550f45b", "httpServerLocation": "/assets/assets/onay-v2"},
  "assets/onay-v2/home.png": {"width": 64, "height": 64, "name": "home", "type": "png", "scales": [1], "hash": "2060292adc2dce7dfaa61523ed262e8c", "httpServerLocation": "/assets/assets/onay-v2"},
  "assets/onay-v2/list.png": {"width": 64, "height": 64, "name": "list", "type": "png", "scales": [1], "hash": "b7bc8d9f548aa2713c65b8a9c1e2f5fa", "httpServerLocation": "/assets/assets/onay-v2"},
  "assets/onay-v2/moon.png": {"width": 64, "height": 64, "name": "moon", "type": "png", "scales": [1], "hash": "d00573d1b92fa4df93dedf3af4faeba0", "httpServerLocation": "/assets/assets/onay-v2"},
  "assets/onay-v2/phone.png": {"width": 64, "height": 64, "name": "phone", "type": "png", "scales": [1], "hash": "26daa2073ab9f0a22e172e57a117ac6c", "httpServerLocation": "/assets/assets/onay-v2"},
  "assets/onay-v2/pin.png": {"width": 64, "height": 64, "name": "pin", "type": "png", "scales": [1], "hash": "4dbec280f5bbd4bb74cf4fb6fc2401f3", "httpServerLocation": "/assets/assets/onay-v2"},
  "assets/onay-v2/seat.png": {"width": 64, "height": 64, "name": "seat", "type": "png", "scales": [1], "hash": "3b41f44e7710e8d522eba1d7cb93060e", "httpServerLocation": "/assets/assets/onay-v2"},
  "assets/onay-v2/sun.png": {"width": 64, "height": 64, "name": "sun", "type": "png", "scales": [1], "hash": "6466c73fcf460050e1e4c7fc6a6fb98b", "httpServerLocation": "/assets/assets/onay-v2"},
  "assets/onay-v2/trips.png": {"width": 64, "height": 64, "name": "trips", "type": "png", "scales": [1], "hash": "40fd1ad2ee67c7ea3662b68b6b7f41ab", "httpServerLocation": "/assets/assets/onay-v2"},
  "assets/onay-v2/user.png": {"width": 64, "height": 64, "name": "user", "type": "png", "scales": [1], "hash": "3f1cd9b1f72e3cc5764b95defdf133bd", "httpServerLocation": "/assets/assets/onay-v2"},
  "assets/onay-v2/village.png": {"width": 64, "height": 64, "name": "village", "type": "png", "scales": [1], "hash": "a93aea2b0e076a5b5a7bad7b2fba5e55", "httpServerLocation": "/assets/assets/onay-v2"},
  "assets/onay-v2/warn.png": {"width": 64, "height": 64, "name": "warn", "type": "png", "scales": [1], "hash": "3af1d258f095299ee8985fc7979839d4", "httpServerLocation": "/assets/assets/onay-v2"},
};
// Dimension-parser fixtures, not a claim of full pixel/codec decoding.
const standard = {
  "bmp": "Qk02AAAAAAAAADYAAAAoAAAADAAAACIAAAABABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "gif": "R0lGODlhDAAiAA==",
  "webp": "UklGRhYAAABXRUJQVlA4WAoAAAAAAAAACwAAIQAA",
  "tiff": "SUkqAAgAAAAKAAABBAABAAAADAAAAAEBBAABAAAAIgAAAAIBAwABAAAACAAAAAMBAwABAAAAAQAAAAYBAwABAAAAAQAAABEBBAABAAAAhgAAABUBAwABAAAAAQAAABYBBAABAAAAIgAAABcBBAABAAAAmAEAABwBAwABAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  "psd": "OEJQUwABAAAAAAAAAAMAAAAiAAAADAAIAAM=",
  "ktx": "q0tUWCAxMbsNChoKAQIDBAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAACIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
  "svg": "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMiIgaGVpZ2h0PSIzNCI+PC9zdmc+"
};

function png(width = 12, height = 34) {
  const data = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(data);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12);
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  data[24] = 8;
  data[25] = 6;
  return data;
}

function box(type, content = Buffer.alloc(0), declaredSize = 8 + content.length) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(declaredSize);
  header.write(type, 4, 4, "ascii");
  return Buffer.concat([header, content]);
}

function icns(entrySize = 8, fileSize = 16) {
  const data = Buffer.alloc(16);
  data.write("icns");
  data.writeUInt32BE(fileSize, 4);
  data.write("icp4", 8);
  data.writeUInt32BE(entrySize, 12);
  return data;
}

async function temporary(action) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "onay-image-size-"));
  try { return await action(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function hash(buffers) {
  const digest = crypto.createHash("md5");
  for (const buffer of buffers) digest.update(buffer);
  return digest.digest("hex");
}

test("installed Metro preserves all 27 ONAY assets and complete baseline metadata", () => temporary(async directory => {
  assert.equal(Object.keys(baseline).length, 27);
  // Two launcher assets are ignored build outputs. Produce their exact bytes
  // with the existing generator without relying on another test's side effects
  // or writing shared files while parallel test processes may read them.
  const icons = appRequire("./scripts/prepare-onay-icons.cjs");
  const generated = icons.produceImages(icons.decodePng(fs.readFileSync(icons.SOURCE)));
  const outputs = {
    [path.relative(projectRoot, icons.ICON)]: generated.icon,
    [path.relative(projectRoot, icons.FOREGROUND)]: generated.foreground,
  };
  for (const relative of Object.keys(baseline)) {
    const target = path.join(directory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, outputs[relative] || fs.readFileSync(path.join(projectRoot, relative)));
  }
  for (const [relative, expected] of Object.entries(baseline)) {
    const file = path.join(directory, relative);
    const dimensions = assets.getAssetSize(expected.type, fs.readFileSync(file), file);
    assert.deepEqual(dimensions, { width: expected.width, height: expected.height }, relative);
    assert.equal(dimensions instanceof Promise, false, "buffer sizing must stay synchronous");
    const result = await assets.getAssetData(file, relative, [], null, "/assets");
    assert.deepEqual(result, {
      __packager_asset: true,
      fileSystemLocation: path.dirname(file),
      httpServerLocation: expected.httpServerLocation,
      width: expected.width, height: expected.height,
      scales: expected.scales, files: [file], hash: expected.hash,
      name: expected.name, type: expected.type,
    }, relative);
  }
}));

test("actual installed Metro handles representative standard formats as buffers and filenames", async t => {
  for (const [type, encoded] of Object.entries(standard)) {
    await t.test(type, () => temporary(async directory => {
      const content = Buffer.from(encoded, "base64");
      const file = path.join(directory, "fixture." + type);
      await writeFile(file, content);
      assert.deepEqual(assets.getAssetSize(type, content, file), { width: 12, height: 34 });
      const data = await assets.getAssetData(file, "fixture." + type, [], null, "/assets");
      assert.deepEqual([data.width, data.height, data.scales, data.hash], [12, 34, [1], hash([content])]);
    }));
  }
});

test("Metro preserves non-image null, explicit empty-buffer failure and supported decoder types", () => {
  assert.equal(assets.getAssetSize("txt", png(), "ordinary.txt"), null);
  assert.throws(() => assets.getAssetSize("png", Buffer.alloc(0), "empty.png"), /cannot be an empty file/);
  assert.deepEqual([...metroRequire("image-size").types].sort(), [
    "bmp", "cur", "dds", "gif", "heif", "icns", "ico", "j2c", "jp2", "jpg",
    "jxl", "jxl-stream", "ktx", "png", "pnm", "psd", "svg", "tga", "tiff", "webp",
  ].sort());
  assert.deepEqual(assets.getAssetSize("png", icns(), "header.png"), { width: 16, height: 16 });
});

test("Metro retains the .zip-path Buffer branch without invoking a filename-only parser", () => temporary(async directory => {
  // An ordinary temporary directory exercises the existing '.zip/' branch;
  // this is not a claim that an actual ZIP virtual filesystem was tested.
  const archiveDirectory = path.join(directory, "fixture.zip");
  await mkdir(archiveDirectory);
  const file = path.join(archiveDirectory, "icon.png"), content = png();
  await writeFile(file, content);
  const data = await assets.getAssetData(file, "icon.png", [], null, "/assets");
  assert.deepEqual([data.width, data.height, data.hash, data.files], [12, 34, hash([content]), [file]]);
}));

test("Metro retains @2x/@3x normalization and platform-specific selection", () => temporary(async directory => {
  const second = png(24, 68), third = png(36, 102), android = png(48, 136);
  const file = path.join(directory, "icon@2x.png");
  await writeFile(file, second);
  await writeFile(path.join(directory, "icon@3x.png"), third);
  await writeFile(path.join(directory, "icon@2x.android.png"), android);
  const generic = await assets.getAssetData(file, "icon@2x.png", [], null, "/assets");
  assert.deepEqual([generic.width, generic.height, generic.scales, generic.hash], [12, 34, [2, 3], hash([second, third])]);
  const platform = await assets.getAssetData(file, "icon@2x.png", [], "android", "/assets");
  assert.deepEqual([platform.width, platform.height, platform.scales, platform.hash], [24, 68, [2], hash([android])]);
  assert.ok(platform.files[0].endsWith("icon@2x.android.png"));
}));

test("actual Metro runs asset plugins in order and propagates plugin failure", () => temporary(async directory => {
  const file = path.join(directory, "icon.png"), content = png();
  await writeFile(file, content);
  const first = path.join(directory, "first.cjs"), second = path.join(directory, "second.cjs"), broken = path.join(directory, "broken.cjs");
  await writeFile(first, 'module.exports = data => ({ ...data, width: data.width + 1, trace: ["first"] });');
  await writeFile(second, 'module.exports = async data => ({ ...data, width: data.width * 2, trace: [...data.trace, "second"] });');
  await writeFile(broken, 'module.exports = () => { throw new Error("ONAY_PLUGIN_FAILURE"); };');
  const result = await assets.getAssetData(file, "icon.png", [first, second], null, "/assets");
  assert.deepEqual([result.width, result.height, result.trace, result.hash], [26, 34, ["first", "second"], hash([content])]);
  await assert.rejects(assets.getAssetData(file, "icon.png", [broken], null, "/assets"), /ONAY_PLUGIN_FAILURE/);
}));

test("parallel filename reads retain independent complete Metro asset metadata", () => temporary(async directory => {
  const file = path.join(directory, "icon.png");
  await writeFile(file, png());
  const expected = await assets.getAssetData(file, "icon.png", [], null, "/assets");
  const pending = Array.from({ length: 16 }, () => assets.getAssetData(file, "icon.png", [], null, "/assets"));
  assert.ok(pending.every(value => value instanceof Promise));
  for (const result of await Promise.all(pending)) assert.deepEqual(result, expected);
}));

test("Metro preserves missing/truncated-file rejection and non-image metadata", () => temporary(async directory => {
  await assert.rejects(assets.getAssetData(path.join(directory, "missing.png"), "missing.png", [], null, "/assets"));
  const empty = path.join(directory, "empty.png");
  await writeFile(empty, Buffer.alloc(0));
  await assert.rejects(assets.getAssetData(empty, "empty.png", [], null, "/assets"));
  const truncated = path.join(directory, "truncated.png");
  await writeFile(truncated, png().subarray(0, 8));
  await assert.rejects(assets.getAssetData(truncated, "truncated.png", [], null, "/assets"));
  const text = path.join(directory, "ordinary.txt"), content = Buffer.from("ordinary text");
  await writeFile(text, content);
  const result = await assets.getAssetData(text, "ordinary.txt", [], null, "/assets");
  assert.deepEqual([result.width, result.height, result.hash], [undefined, undefined, hash([content])]);
}));

const ftypJxl = box("ftyp", Buffer.from("jxl \0\0\0\0", "binary"));
const jxlHeader = box("JXL ", Buffer.from([13, 10, 135, 10]));
const ftypHeif = box("ftyp", Buffer.from("heic\0\0\0\0", "binary"));
const malformed = [
  ["ICNS zero entry", icns(0, 24), "reject"],
  ["ICNS truncated entry", icns().subarray(0, 12), "reject"],
  // Upstream retains header-only sizing for this oversized entry, but it must
  // terminate with finite dimensions. It is not a full-image validity check.
  ["ICNS oversized entry", icns(0xffffffff), "finite"],
  ["JXL zero jxlp", Buffer.concat([jxlHeader, ftypJxl, box("jxlp", Buffer.alloc(4), 0)]), "reject"],
  ["JXL undersized jxlp", Buffer.concat([jxlHeader, ftypJxl, box("jxlp", Buffer.alloc(4), 8)]), "reject"],
  ["HEIF zero meta", Buffer.concat([ftypHeif, box("meta", Buffer.alloc(4), 0)]), "reject"],
  ["HEIF undersized meta", Buffer.concat([ftypHeif, box("meta", Buffer.alloc(4), 4)]), "reject"],
  ["HEIF nested zero ispe", Buffer.concat([ftypHeif, box("meta", Buffer.concat([Buffer.alloc(4), box("iprp", box("ipco", box("ispe", Buffer.alloc(12), 0)))]))]), "reject"],
  ["HEIF truncated box", Buffer.concat([ftypHeif, Buffer.from([0, 0, 0, 20, 109, 101])]), "reject"],
];

for (const [name, content, expected] of malformed) {
  test("bounded installed decoder: " + name, { timeout: 5_000 }, async () => {
    let worker;
    try {
      const result = await new Promise((resolve, reject) => {
        worker = new Worker(`
          const { parentPort, workerData } = require("node:worker_threads");
          const decoder = require(workerData.entry).imageSize;
          const source = Buffer.from(workerData.bytes, "base64");
          const bytes = Buffer.alloc(source.length); source.copy(bytes);
          try { parentPort.postMessage({ dimensions: decoder(bytes) }); }
          catch (error) { parentPort.postMessage({ rejected: true, message: error.message }); }
        `, { eval: true, workerData: { entry: decoderEntry, bytes: content.toString("base64") }, resourceLimits: { maxOldGenerationSizeMb: 32 } });
        const timer = setTimeout(() => reject(new Error("Image parser exceeded one-second bound")), 1_000);
        worker.once("message", data => { clearTimeout(timer); resolve(data); });
        worker.once("error", error => { clearTimeout(timer); reject(error); });
        worker.once("exit", code => { if (code !== 0) { clearTimeout(timer); reject(new Error("Image parser worker exited " + code)); } });
      });
      if (expected === "reject") assert.equal(result.rejected, true, name);
      else assert.deepEqual([result.dimensions.width, result.dimensions.height], [16, 16]);
    } finally {
      if (worker) await worker.terminate();
    }
  });
}
