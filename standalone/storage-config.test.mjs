import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const projectRoot=fileURLToPath(new URL('../',import.meta.url));
const storageModule=new URL('./storage.mjs',import.meta.url).href;
const importStorage=`
 const {sql,storageKind}=await import(process.env.PORTAL_STORAGE_TEST_MODULE);
 if(storageKind!=='postgres')throw Error('Expected the Postgres driver.');
 await sql.close();
`;

async function runStorage(url,source=importStorage,{render=false,ca=false}={}){
 const directory=mkdtempSync(join(tmpdir(),'portal-storage-config-'));
 const database=join(directory,'must-not-create.sqlite');
 const env={...process.env,NODE_ENV:'test',PORTAL_POSTGRES_URL:url,PORTAL_DATABASE:database,PORTAL_STORAGE_TEST_MODULE:storageModule};
 delete env.RENDER;delete env.PORTAL_TEST_POSTGRES;delete env.PORTAL_TEST_POSTGRES_PATH;delete env.PORTAL_POSTGRES_CA_FILE;
 if(render)env.RENDER='true';
 if(ca){env.PORTAL_POSTGRES_CA_FILE=join(directory,'fixture-ca.pem');writeFileSync(env.PORTAL_POSTGRES_CA_FILE,'test-only CA contents');}
 try{
  // Keep synthetic credentials in the environment, never in source printed by an uncaught stack.
  const result=await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,['--input-type=module','-e',source],{cwd:projectRoot,env,stdio:['ignore','pipe','pipe']});
   let stdout='',stderr='';
   const timer=setTimeout(()=>{child.kill();reject(Error('Storage configuration check timed out.'));},10000);
   child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
   child.on('error',error=>{clearTimeout(timer);reject(error);});
   child.on('close',(status,signal)=>{clearTimeout(timer);resolve({status,signal,stdout,stderr});});
  });
  assert.equal(result.signal,null,'The storage configuration check must terminate normally.');
  assert.equal(existsSync(database),false,'A configured Postgres URL must never fall back to SQLite.');
  return result;
 }finally{rmSync(directory,{recursive:true,force:true});}
}

const marker='synthetic-secret-do-not-log-73916';
const malformed=[
 ['plain invalid value','invalid connection '+marker],
 ['invalid port','postgresql://fixture-user:'+marker+'@127.0.0.1:not-a-port/fixture'],
 ['invalid IPv6 host','postgres://fixture-user:'+marker+'@[invalid-ipv6]/fixture'],
];
for(const [name,url] of malformed){
 test('invalid Postgres URL is safely rejected: '+name,async()=>{
  const result=await runStorage(url,importStorage,{render:true});
  assert.notEqual(result.status,0,'An invalid URL must fail startup.');
  assert.equal(result.stderr.includes(url),false,'stderr must not contain the configured URL.');
  assert.equal(result.stderr.includes(marker),false,'stderr must not contain synthetic credentials.');
  assert.equal(result.stderr.includes('PORTAL_POSTGRES_URL is invalid.'),true,'The configuration error must have a stable, safe message.');
  assert.equal(result.stderr.includes('ERR_INVALID_URL'),false,'The original URL error must be discarded.');
 });
}

test('unsupported protocol remains rejected without echoing credentials',async()=>{
 const url='https://fixture-user:'+marker+'@example.test/fixture';
 const result=await runStorage(url);
 assert.notEqual(result.status,0);
 assert.equal(result.stderr.includes('PORTAL_POSTGRES_URL must be a Postgres connection string.'),true);
 assert.equal(result.stderr.includes(url),false);
 assert.equal(result.stderr.includes(marker),false);
});

for(const protocol of ['postgres:','postgresql:']){
 test(protocol+' keeps the real driver and mandatory TLS without opening a connection',async()=>{
  const source=`
   import assert from 'node:assert/strict';
   import {createRequire} from 'node:module';
   const require=createRequire(import.meta.url),pg=require('pg'),RealPool=pg.Pool;
   let options;
   pg.Pool=class extends RealPool{constructor(config){super(config);options=config;}};
   const {sql,storageKind}=await import(process.env.PORTAL_STORAGE_TEST_MODULE);
   try{
    assert.equal(storageKind,'postgres');
    const parsed=new URL(options.connectionString);
    assert.equal(parsed.protocol,new URL(process.env.PORTAL_POSTGRES_URL).protocol);
    assert.equal(parsed.searchParams.get('application_name'),'storage-config-test');
    assert.equal([...parsed.searchParams.keys()].some(key=>key.toLowerCase().startsWith('ssl')),false);
    assert.equal(options.ssl.rejectUnauthorized,true);
    assert.equal(options.ssl.ca,process.env.PORTAL_POSTGRES_CA_FILE?'test-only CA contents':undefined);
    const client=new pg.Client(options);
    assert.equal(client.connectionParameters.ssl.rejectUnauthorized,true);
    assert.equal(client.connectionParameters.ssl.ca,options.ssl.ca);
   }finally{await sql.close();}
  `;
  const url=protocol+'//fixture-user:'+marker+'@127.0.0.1:5432/fixture?sslmode=disable&ssl=false&SSLROOTCERT=must-not-read&application_name=storage-config-test';
  const result=await runStorage(url,source,{ca:protocol==='postgresql:'});
  assert.equal(result.status,0,'The supported URL must initialize with the real pg driver and required TLS. '+result.stderr);
 });
}
