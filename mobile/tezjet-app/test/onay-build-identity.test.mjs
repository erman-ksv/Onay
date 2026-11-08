import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import buildConfig, { resolveOnayBuildMetadata } from '../app.config.ts';
import { getOnayBuildIdentity } from '../lib/onay-build-identity.ts';
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

test('display native Android versionCode and verified SHA without fabricating values',()=>{
 const sha='ab12'.repeat(10);
 const receipt={commit:sha,versionCode:114};
 const ok=getOnayBuildIdentity('0.1.0','0.1.0','114',receipt,'demo');
 assert.equal(ok.version,'0.1.0'); assert.equal(ok.versionCode,114);
 assert.equal(ok.shortSha,sha.slice(0,12)); assert.equal(ok.mode,'Демо');
 assert.equal(ok.versionMismatch,false); assert.equal(ok.codeSource,'native');
 const mismatch=getOnayBuildIdentity('0.1.0',null,'112',receipt,'live');
 assert.equal(mismatch.versionCode,112); assert.equal(mismatch.mode,'Обычный');
 assert.equal(mismatch.versionMismatch,true);
 const unknown=getOnayBuildIdentity(null,null,null,{},'demo');
 assert.equal(unknown.versionCode,null); assert.equal(unknown.shortSha,'недоступен');
 assert.equal(unknown.version,'недоступна');
});
test('runtime build identity appears on both profiles and About with actual mode',()=>{
 const read=f=>readFileSync(new URL(f,import.meta.url),'utf8');
 const demo=read('../components/OnayDemoApp.tsx');
 const profile=read('../components/OnayPassengerProfile.tsx');
 const driver=read('../components/OnayDriverProfile.tsx');
 const about=read('../components/OnayPassengerAbout.tsx');
 const build=read('../components/OnayBuildIdentity.tsx');
 assert.match(demo, /<OnayPassengerProfile demoMode/);
 assert.match(demo, /<OnayDriverProfile demoMode/);
 assert.match(demo, /<OnayPassengerAbout mode="demo"/);
 for(const source of [profile,driver]) assert.match(source,/OnayBuildIdentity mode=\{demoMode \? "demo" : "live"\}/);
 assert.match(about, /<OnayBuildIdentity mode=\{mode\}/);
 for(const marker of ['onay-about-version-code','onay-about-source-sha','onay-about-runtime-mode','onay-about-build-mismatch','onay-profile-build-identity']) assert.ok(build.includes(marker));
});

test('generated build-provenance sourceSha is embedded in Expo config and rendered About identity',t=>{
 const sha='f135'.repeat(10);
 const cwd=process.cwd(), dir=mkdtempSync(join(tmpdir(),'onay-build-provenance-'));
 t.after(()=>{process.chdir(cwd);rmSync(dir,{recursive:true,force:true});});
 const receipt={
   sourceSha:sha, sourceBranch:'feat/artifact-auth-ui-v1', runId:'98765',
   applicationId:config.android.package, versionCode:config.android.versionCode,
 };
 writeFileSync(join(dir,'build-provenance.json'),JSON.stringify(receipt));
 process.chdir(dir);
 const output=buildConfig({config});
 assert.equal(output.extra.onayBuild.commit,receipt.sourceSha);
 assert.equal(output.extra.onayBuild.versionCode,receipt.versionCode);
 assert.equal(output.extra.onayBuild.runId,receipt.runId);
 const display=getOnayBuildIdentity(output.version,output.version,String(receipt.versionCode),output.extra.onayBuild,'demo');
 assert.equal(display.sourceSha,receipt.sourceSha);
 assert.equal(display.shortSha,receipt.sourceSha.slice(0,12));
 assert.equal(display.versionCode,receipt.versionCode);
 assert.equal(display.versionMismatch,false);
 const component=readFileSync(new URL('../components/OnayBuildIdentity.tsx',import.meta.url),'utf8');
 assert.match(component,/SHA исходников: \{info\.shortSha\}/);
 assert.match(component,/Constants\.expoConfig\?\.extra\?\.onayBuild/);
});

test('invalid or conflicting provenance rejects a false build identity',()=>{
 const base={sourceSha:'a'.repeat(40),versionCode:config.android.versionCode,applicationId:config.android.package};
 const env={ONAY_BUILD_SHA:'b'.repeat(40)};
 assert.throws(()=>resolveOnayBuildMetadata(config,base,env),/conflicts/);
 assert.throws(()=>resolveOnayBuildMetadata(config,{...base,sourceSha:'local'},{}),/sourceSha/);
 assert.throws(()=>resolveOnayBuildMetadata(config,{...base,versionCode:999},{}),/versionCode/);
 assert.throws(()=>resolveOnayBuildMetadata(config,{...base,applicationId:'another.app'},{}),/applicationId/);
 assert.throws(()=>resolveOnayBuildMetadata(config,{...base,sourceSha:'a'.repeat(40).toUpperCase().replace(/A/g,'G')},{}),/sourceSha/);
 assert.equal(resolveOnayBuildMetadata(config,null,{}).commit,'local');
});
