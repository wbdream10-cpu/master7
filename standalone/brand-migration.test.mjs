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
const legacyFiles={sqlite:['drizzle/0000_unknown_smasher.sql','drizzle/0001_rapid_the_enforcers.sql','drizzle/0002_brand_settings.sql','drizzle/0003_wallet_deposits.sql'],pglite:['standalone/postgres/0001_portal.sql','standalone/postgres/0002_brand_settings.sql','standalone/postgres/0003_wallet_deposits.sql']};

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
   const payment=await sql.prepare('SELECT * FROM portal_payment_orders WHERE id=?').get('existing-order');
   assert.equal(payment.settlement_status,'credited');assert.equal(payment.trade_no,'existing-provider-order');assert.equal(Number(payment.amount_minor),125);
   assert.equal(payment.create_outcome,'not_sent');assert.equal(payment.checkout_url,null);assert.equal(payment.create_fingerprint,null);
   assert.equal(Number((await sql.prepare('SELECT member_minor FROM portal_wallet_journal WHERE order_id=?').get('existing-order')).member_minor),125);
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
   assert.equal(Number((await sql.prepare('SELECT count(*) AS n FROM portal_wallet_journal WHERE order_id=?').get('existing-order')).n),1);
  }finally{await sql.close();}
 `);
 console.log('PASS ['+kind+']: brand and wallet upgrade preserves existing content, credited orders and journals, defaults checkout fields and restarts without replaying migration.');
}

try{
 const sqlitePath=join(root,'old.sqlite');
 const {DatabaseSync}=await import('node:sqlite');const sqlite=new DatabaseSync(sqlitePath);
 try{
  sqlite.exec('CREATE TABLE schema_versions(name TEXT PRIMARY KEY,hash TEXT NOT NULL)');
  sqlite.exec("CREATE TABLE portal_users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE COLLATE NOCASE,email TEXT NOT NULL UNIQUE COLLATE NOCASE,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','customer')),approved INTEGER NOT NULL DEFAULT 0,recovery_hash TEXT NOT NULL,created_at TEXT NOT NULL)");
  for(const file of legacyFiles.sqlite){const source=readFileSync(file,'utf8');sqlite.exec(source);sqlite.prepare('INSERT INTO schema_versions(name,hash) VALUES (?,?)').run(file.split('/').at(-1),hash(source));}
  sqlite.prepare('INSERT INTO brands(id,name,tagline,color,logo,created_at) VALUES (?,?,?,?,?,?)').run(...Object.values(legacy));
  sqlite.exec("INSERT INTO portal_users VALUES ('legacy-member','legacy-member','legacy@example.test','synthetic-hash','customer',1,'synthetic-hash','2026-10-01T00:00:00Z'); INSERT INTO portal_payment_orders(id,tenant_id,user_id,request_key,merchant_id,environment,amount_minor,currency,trade_no,settlement_status,created_at) VALUES ('existing-order','existing-brand','legacy-member','existing-request-key','123456','uat',125,'MYR','existing-provider-order','credited','2026-10-01T00:00:00Z'); INSERT INTO portal_wallet_journal VALUES ('existing-entry','existing-order','existing-brand','legacy-member','uat','MYR',125,-125,'2026-10-01T00:00:00Z')");
 }finally{sqlite.close();}
 await checkUpgrade('sqlite',sqlitePath);
 const pgPath=join(root,'old-pg');const {PGlite}=await import('@electric-sql/pglite');const pg=new PGlite(pgPath);
 try{
  for(const file of legacyFiles.pglite){const source=readFileSync(file,'utf8');await pg.exec(source);await pg.query('INSERT INTO portal_private.schema_versions(name,hash) VALUES ($1,$2)',[file.split('/').at(-1),hash(source)]);}
  await pg.query('INSERT INTO portal_private.brands(id,name,tagline,color,logo,created_at) VALUES ($1,$2,$3,$4,$5,$6)',Object.values(legacy));
  await pg.exec("INSERT INTO portal_private.portal_users VALUES ('legacy-member','legacy-member','legacy@example.test','synthetic-hash','customer',1,'synthetic-hash','2026-10-01T00:00:00Z'); INSERT INTO portal_private.portal_payment_orders(id,tenant_id,user_id,request_key,merchant_id,environment,amount_minor,currency,trade_no,settlement_status,created_at) VALUES ('existing-order','existing-brand','legacy-member','existing-request-key','123456','uat',125,'MYR','existing-provider-order','credited','2026-10-01T00:00:00Z'); INSERT INTO portal_private.portal_wallet_journal VALUES ('existing-entry','existing-order','existing-brand','legacy-member','uat','MYR',125,-125,'2026-10-01T00:00:00Z')");
 }finally{await pg.close();}
 await checkUpgrade('pglite',pgPath);
}finally{rmSync(root,{recursive:true,force:true});}
