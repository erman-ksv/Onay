import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = name => readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf8')
  .replace(/^\s*#.*$/gm, '');
const qa = workflow('onay-apk118-startup-release.yml');
const delivery = workflow('onay-apk119-publish-only.yml');

test('pull request Android acceptance never publishes releases or requests contents write', () => {
  assert.match(qa, /^  pull_request:/m);
  assert.doesNotMatch(qa, /gh release|contents: write|pull_request_target/);
  assert.match(qa, /contents: read/);
  assert.match(qa, /actions: read/);
});

test('APK119 acceptance retains original artifact, signer and installed source verification', () => {
  assert.match(qa, /head\.sha == 'e61c32b6ec09fd73cb0f49e71211020a6ce1c1e9'/);
  assert.match(qa, /run-id: 42486987509/);
  assert.match(qa, /cmp diagnostic\/mobile\/tezjet-app\/android\/app\/build\/outputs\/apk\/debug\/app-debug\.apk/);
  assert.match(qa, /hashlib\.sha256\(new\.read_bytes\(\)\)\.hexdigest\(\)/);
  assert.match(qa, /diff -u \/tmp\/onay-apk118-cert \/tmp\/onay-apk119-cert/);
  assert.match(qa, /python3 scripts\/onay-build-sha-android-qa\.py --provenance apk119\/build-provenance\.json --version-code 119/);
  assert.match(qa, /python3 scripts\/onay-apk119-icon-android-qa\.py --version-code 119/);
});

test('separate branch delivery requires successful Android QA and exact original APK bytes', () => {
  assert.match(delivery, /^  push:/m);
  assert.match(delivery, /github\.repository == 'erman-ksv\/Onay' && github\.ref == 'refs\/heads\/feat\/artifact-auth-ui-v1'/);
  assert.match(delivery, /test "\$result" = "success"/);
  assert.match(delivery, /ae8216170a72077fa589c22570544e369b4391b6f8da6f811f0f17885dfdb06f/);
  assert.match(delivery, /receipt\['sourceSha'\]\s*==\s*'e61c32b6ec09fd73cb0f49e71211020a6ce1c1e9'/);
  assert.match(delivery, /hashlib\.sha256\(original\.read_bytes\(\)\)\.hexdigest\(\)==expected/);
  assert.match(delivery, /--prerelease --latest=false/);
  assert.doesNotMatch(delivery, /pull_request_target|gradlew|expo prebuild/);
});
