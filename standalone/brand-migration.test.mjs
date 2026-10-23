import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';

// Exercise an upgrade from the shipped schema, with existing brand data.
// These are isolated local SQLite/PGlite databases, never a network database.
const root=mkdtempSync(join(tmpdir(),'portal-brand-upgrade-'));
const hash=source=>createHash('sha256').update(source).digest('hex');
const legacy={id:'existing-brand',name:'Existing Brand',tagline:'Keep existing content',color:'#abcdef',logo:'https://example.test/existing.png',created_at:'2026-10-01T00:00:00.000Z'};
const legacyFiles={sqlite:['drizzle/0000_unknown_smasher.sql','drizzle/0001_rapid_the_enforcers.sql'],pglite:['standalone/postgres/0001_portal.sql']};

async function checkUpgrade(kind,path){
 const env={...process.env,NODE_ENV:'test',PORTAL_DATABASE:path};
 delete env.PORTAL_POSTGRES_URL;delete env.PORTAL_POSTGRES_CA_FILE;delete env.RENDER;
 delete env.PORTAL_TEST_POSTGRES;delete env.PORTAL_TEST_POSTGRES_PATH;
 if(kind==='pglite'){env.PORTAL_TEST_POSTGRES='1';env.PORTAL_TEST_POSTGRES_PATH=path;}
 const source=`
  import assert from 'node:assert/strict';
  import {sql} from './standalone/runtime.mjs';
  try{
   const row=await sql.prepare('SELECT * FROM brands WHERE id=?').get('existing-brand');
   const legacy=JSON.parse(process.env.PORTAL_UPGRADE_EXPECTED);
   for(const [key,value] of Object.entries(legacy))assert.equal(row[key],value);
   assert.equal(row.language,'zh-CN');assert.equal(row.support_url,'');
   await sql.prepare('UPDATE brands SET language=?,support_url=? WHERE id=?').run('ms','https://example.test/support','existing-brand');
  }finally{await sql.close();}
 `;
 const run=code=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{...env,PORTAL_UPGRADE_EXPECTED:JSON.stringify(legacy)},stdio:['ignore','ignore','pipe']});
  let error='';child.stderr.on('data',data=>error+=data);child.on('error',reject);child.on('close',status=>status?reject(Error(error)):resolve());
 });
 await run(source);
 await run(`
  import assert from 'node:assert/strict';
  import {sql} from './standalone/runtime.mjs';
  try{
   const row=await sql.prepare('SELECT * FROM brands WHERE id=?').get('existing-brand');
   assert.equal(row.name,'Existing Brand');assert.equal(row.language,'ms');assert.equal(row.support_url,'https://example.test/support');
   await sql.prepare('INSERT INTO brands(id,name,created_at) VALUES (?,?,?)').run('new-brand','New Brand','2026-10-23T00:00:00.000Z');
   const fresh=await sql.prepare('SELECT language,support_url FROM brands WHERE id=?').get('new-brand');
   assert.equal(fresh.language,'zh-CN');assert.equal(fresh.support_url,'');
   assert.equal(Number((await sql.prepare('SELECT count(*) AS n FROM brands').get()).n),2);
  }finally{await sql.close();}
 `);
 console.log('PASS ['+kind+']: existing brand upgrade preserves content, defaults new fields and restarts without replaying migration.');
}

try{
 const sqlitePath=join(root,'old.sqlite');
 const {DatabaseSync}=await import('node:sqlite');const sqlite=new DatabaseSync(sqlitePath);
 try{
  sqlite.exec('CREATE TABLE schema_versions(name TEXT PRIMARY KEY,hash TEXT NOT NULL)');
  for(const file of legacyFiles.sqlite){const source=readFileSync(file,'utf8');sqlite.exec(source);sqlite.prepare('INSERT INTO schema_versions(name,hash) VALUES (?,?)').run(file.split('/').at(-1),hash(source));}
  sqlite.prepare('INSERT INTO brands(id,name,tagline,color,logo,created_at) VALUES (?,?,?,?,?,?)').run(...Object.values(legacy));
 }finally{sqlite.close();}
 await checkUpgrade('sqlite',sqlitePath);
 const pgPath=join(root,'old-pg');const {PGlite}=await import('@electric-sql/pglite');const pg=new PGlite(pgPath);
 try{
  for(const file of legacyFiles.pglite){const source=readFileSync(file,'utf8');await pg.exec(source);await pg.query('INSERT INTO portal_private.schema_versions(name,hash) VALUES ($1,$2)',[file.split('/').at(-1),hash(source)]);}
  await pg.query('INSERT INTO portal_private.brands(id,name,tagline,color,logo,created_at) VALUES ($1,$2,$3,$4,$5,$6)',Object.values(legacy));
 }finally{await pg.close();}
 await checkUpgrade('pglite',pgPath);
}finally{rmSync(root,{recursive:true,force:true});}
