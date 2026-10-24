import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {webConfig} from './production.mjs';

const markers=[
 ['NODE_ENV','production'],['RENDER','true'],
 ['RAILWAY_ENVIRONMENT_ID','fixture-environment'],['RAILWAY_ENVIRONMENT_NAME','staging'],
 ['RAILWAY_PROJECT_ID','fixture-project'],['RAILWAY_SERVICE_ID','fixture-service'],
];
const secret='synthetic-config-secret-do-not-log';
function run(source,overrides={},existing=false){
 const directory=mkdtempSync(join(tmpdir(),'master7-production-'));
 const file=join(directory,'must-not-change.sqlite');
 const original=Buffer.from('existing database sentinel');
 if(existing)writeFileSync(file,original);
 const env={...process.env};
 for(const name of [...markers.map(([name])=>name),'PORTAL_POSTGRES_URL','PORTAL_TEST_POSTGRES','PORTAL_TEST_POSTGRES_PATH','PUBLIC_ORIGIN','PORTAL_ALLOWED_ORIGINS','PORTAL_POSTGRES_CA_FILE'])delete env[name];
 Object.assign(env,{NODE_ENV:'test',PORTAL_DATABASE:file},overrides);
 try{
  const result=spawnSync(process.execPath,['--input-type=module','-e',source],{env,encoding:'utf8',timeout:10000});
  assert.ifError(result.error);
  assert.equal(result.signal,null);
  if(existing)assert.deepEqual(readFileSync(file),original,'invalid configuration must not modify an existing database');
  else assert.equal(existsSync(file),false,'invalid configuration must not create a database');
  assert.equal((result.stdout+result.stderr).includes(secret),false,'configuration errors must not echo secret values');
  return result;
 }finally{rmSync(directory,{recursive:true,force:true});}
}

for(const [name,value] of markers){
 test(`${name} forbids local storage and the embedded test driver before opening a database`,()=>{
  let result=run("await import('./standalone/storage.mjs')",{[name]:value});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Production requires PORTAL_POSTGRES_URL/);
  result=run("await import('./standalone/storage.mjs')",{[name]:value,PORTAL_TEST_POSTGRES:'1',PORTAL_POSTGRES_URL:`postgresql://fixture:${secret}@127.0.0.1/fixture`});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/embedded Postgres test driver cannot be used in production/);
 });
}

test('production rejects whitespace database configuration without exposing it',()=>{
 const result=run("await import('./standalone/storage.mjs')",{NODE_ENV:'production',PORTAL_POSTGRES_URL:'  '});
 assert.notEqual(result.status,0);
 assert.match(result.stderr,/Production requires PORTAL_POSTGRES_URL/);
});

for(const existing of [false,true]){
 test(`web configuration is checked before migrations with ${existing?'an existing':'no'} local database`,()=>{
  for(const config of [
   {NODE_ENV:'production'},
   {NODE_ENV:'production',PUBLIC_ORIGIN:'http://localhost:8080'},
   {PUBLIC_ORIGIN:'https://portal.example.test',PORTAL_ALLOWED_ORIGINS:`https://user:${secret}@brand.example.test`},
  ]){
   const result=run("await import('./standalone/server.mjs')",config,existing);
   assert.notEqual(result.status,0);
   assert.match(result.stderr,/PUBLIC_ORIGIN|PORTAL_ALLOWED_ORIGINS/);
   assert.doesNotMatch(result.stderr,/not a database|SQLITE_ERROR/);
  }
 });
}

test('every hosted environment requires an explicit HTTPS web origin',()=>{
 for(const [name,value] of markers){
  assert.throws(()=>webConfig({[name]:value}),/explicit HTTPS PUBLIC_ORIGIN/);
  for(const origin of ['http://localhost:8080','http://127.0.0.1:8080','http://[::1]:8080','http://portal.example.test']){
   assert.throws(()=>webConfig({[name]:value,PUBLIC_ORIGIN:origin}),/must use HTTPS/);
  }
  const {origin,allowedOrigins}=webConfig({[name]:value,PUBLIC_ORIGIN:'https://portal.example.test',PORTAL_ALLOWED_ORIGINS:'https://brand.example.test'});
  assert.equal(origin.origin,'https://portal.example.test');
  assert.deepEqual([...allowedOrigins],['https://portal.example.test','https://brand.example.test']);
 }
});

test('valid production storage selects real PostgreSQL without opening a connection',()=>{
 const result=run(`
  const {storageKind,sql}=await import('./standalone/storage.mjs');
  if(storageKind!=='postgres')throw Error('Expected production PostgreSQL');
  await sql.close();
 `,{NODE_ENV:'production',PORTAL_POSTGRES_URL:`postgresql://fixture:${secret}@127.0.0.1/fixture`});
 assert.equal(result.status,0,result.stderr);
});

test('local development retains loopback HTTP and explicit origin validation',()=>{
 assert.equal(webConfig({}).origin.origin,'http://127.0.0.1:8080');
 assert.equal(webConfig({PUBLIC_ORIGIN:'http://localhost:9090'}).origin.origin,'http://localhost:9090');
 assert.throws(()=>webConfig({PUBLIC_ORIGIN:'http://external.example.test'}),/must use HTTPS/);
});
