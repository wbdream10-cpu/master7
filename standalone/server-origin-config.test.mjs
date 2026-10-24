import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const directory=mkdtempSync(join(tmpdir(),'master7-origin-config-'));
const manyOrigins=Array.from({length:21},(_,index)=>`https://brand${index}.example.test`).join(',');
const cases=[
 ['https://master7.best/path','without credentials, path, query, or fragment'],
 ['http://master7.best','must use HTTPS outside local development'],
 ['https://user:pass@master7.best','without credentials, path, query, or fragment'],
 ['http://localhost:8080','must use the same protocol as PUBLIC_ORIGIN'],
 [manyOrigins,'at most 20 comma-separated origins'],
 ['x'.repeat(2001),'is too long'],
];

try{
 for(let index=0;index<cases.length;index++){
  const [allowedOrigins,expected]=cases[index];
  const env={...process.env,NODE_ENV:'test',PUBLIC_ORIGIN:'https://portal.example.test',PORTAL_ALLOWED_ORIGINS:allowedOrigins,PORTAL_DATABASE:join(directory,`case-${index}.sqlite`)};
  delete env.PORTAL_POSTGRES_URL;delete env.PORTAL_TEST_POSTGRES;delete env.RENDER;
  const result=spawnSync(process.execPath,['--input-type=module','-e',"await import('./standalone/server.mjs')"],{cwd:process.cwd(),env,encoding:'utf8'});
  assert.notEqual(result.status,0,`invalid allowlist should fail startup: ${expected}`);
  assert.match(result.stderr, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.equal(existsSync(env.PORTAL_DATABASE),false,'invalid origins must fail before database initialization');
 }
 console.log('PASS: malformed, insecure, oversized, and protocol-mismatched custom-origin configuration fails closed.');
}finally{
 rmSync(directory,{recursive:true,force:true});
}
