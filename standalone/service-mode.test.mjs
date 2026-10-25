import assert from 'node:assert/strict';
import test from 'node:test';
import {serviceOnlyMode} from './service-mode.mjs';

test('support-only mode fails closed by default',()=>{
 assert.equal(serviceOnlyMode({}),true);
 assert.equal(serviceOnlyMode({NODE_ENV:'production'}),true);
 assert.equal(serviceOnlyMode({NODE_ENV:'development'}),true);
});

test('isolated test environment can exercise synthetic fixtures',()=>{
 assert.equal(serviceOnlyMode({NODE_ENV:'test'}),false);
});

test('host markers override test mode and keep sensitive routes unavailable',()=>{
 for(const [name,value] of [
  ['RENDER','true'],['RENDER_EXTERNAL_URL','https://example.test'],
  ['RENDER_SERVICE_ID','srv-fixture'],['RAILWAY_ENVIRONMENT_ID','fixture'],
  ['RAILWAY_ENVIRONMENT_NAME','staging'],['RAILWAY_PROJECT_ID','fixture'],
  ['RAILWAY_SERVICE_ID','fixture'],['VERCEL','1'],['NETLIFY','true'],
  ['FLY_APP_NAME','fixture'],['K_SERVICE','fixture']
 ])assert.equal(serviceOnlyMode({NODE_ENV:'test',[name]:value}),true,name);
});
