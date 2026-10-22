import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showFleetRow, fleetRank } from '../src/fleet-policy.ts';
import type { Meta } from '../src/store.ts';
const now = 100_000;
const meta: Meta = {label:'test',herdrName:'test',definition:'worker',paneId:'p',piSessionId:'s',cwd:'/tmp',startedAt:1,endedAt:70_001,state:'done'};
test('recent completion stays, expires exactly at 30 seconds', () => {
 assert.equal(showFleetRow(meta,'done',false,now),true);
 assert.equal(showFleetRow(meta,'done',false,now+1),false);
});
test('old completion stays hidden after restart', () => {
 assert.equal(showFleetRow(meta,'done',false,now+999_999),false);
});
test('legacy record without end timestamp does not remain forever', () => {
 assert.equal(showFleetRow({...meta,endedAt:undefined},'done',false,now),false);
});
test('blocked and failure states never expire', () => {
 for(const state of ['blocked','failed','timeout','no_result','running','starting'])
  assert.equal(showFleetRow(meta,state,false,now+999_999),true,state);
});
test('closed row never displays',()=>assert.equal(showFleetRow(meta,'closed',true,now),false));
test('live completion stays visible even with showDone disabled',()=> {
 assert.equal(showFleetRow(meta,'done',true,now+999_999,{showDone:false}),true);
});
test('config supports immediate hide and custom TTL',()=> {
 assert.equal(showFleetRow(meta,'done',false,now,{showDone:false}),false);
 assert.equal(showFleetRow(meta,'done',false,now,{completedTtlMs:0}),false);
 assert.equal(showFleetRow(meta,'done',false,now+1,{completedTtlMs:60_000}),true);
});
test('invalid TTL falls back and negative TTL clamps to zero',()=> {
 assert.equal(showFleetRow(meta,'done',false,now,{completedTtlMs:NaN}),true);
 assert.equal(showFleetRow(meta,'done',false,now,{completedTtlMs:-1}),false);
});
test('attention sorts before running, then completions',()=> {
 assert.ok(fleetRank('blocked') < fleetRank('running'));
 assert.ok(fleetRank('failed') < fleetRank('done'));
 assert.ok(fleetRank('running') < fleetRank('done'));
});
test('a spawn that never started expires instead of pinning an error row',()=> {
 const spawnFailed: Meta = {...meta,state:'spawn_failed',startedAt:95_000,endedAt:95_200};
 assert.equal(showFleetRow(spawnFailed,'spawn_failed',false,now),true);
 assert.equal(showFleetRow(spawnFailed,'spawn_failed',false,now+60_000),false);
 assert.equal(showFleetRow(spawnFailed,'spawn_failed',false,now,{completedTtlMs:0}),false);
});
test('spawn failures sort below real attention and above running',()=> {
 assert.ok(fleetRank('failed') < fleetRank('spawn_failed'));
 assert.ok(fleetRank('spawn_failed') < fleetRank('running'));
});
