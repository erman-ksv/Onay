import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import buildConfig from '../app.config.ts';
const config=JSON.parse(readFileSync(new URL('../app.json',import.meta.url),'utf8')).expo;
test('debug identity distinguishes V2 upgrades while preserving Android applicationId',()=>{
 assert.equal(config.name,'Onay');assert.equal(config.android.package,'uz.tezjet.app');
 assert.ok(Number.isSafeInteger(config.android.versionCode)&&config.android.versionCode>1);
 assert.equal(config.icon,'./assets/onay-original-logo.png');
});
test('public build receipt embeds the selected source and preserves ordinary Expo configuration',t=>{
 const keys=['ONAY_BUILD_SHA','ONAY_BUILD_BRANCH','GITHUB_RUN_ID'];const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(()=>{for(const k of keys)before[k]===undefined?delete process.env[k]:process.env[k]=before[k];});
 process.env.ONAY_BUILD_SHA='a'.repeat(40);process.env.ONAY_BUILD_BRANCH='feat/artifact-auth-ui-v1';process.env.GITHUB_RUN_ID='123';
 const result=buildConfig({config});assert.equal(result.android.package,config.android.package);
 assert.deepEqual(result.extra.onayBuild,{commit:'a'.repeat(40),branch:'feat/artifact-auth-ui-v1',runId:'123',versionCode:config.android.versionCode});
 assert.deepEqual(Object.keys(result.extra.onayBuild).sort(),['branch','commit','runId','versionCode']);
});
