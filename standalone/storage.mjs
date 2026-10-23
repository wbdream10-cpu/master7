import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync,mkdirSync,chmodSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const scope=new AsyncLocalStorage();
let queue=Promise.resolve();
const testPg=process.env.PORTAL_TEST_POSTGRES==='1';
const postgresUrl=process.env.PORTAL_POSTGRES_URL;
if(process.env.RENDER&&!postgresUrl)throw Error('Render requires PORTAL_POSTGRES_URL; refusing ephemeral SQLite storage.');
if(Object.hasOwn(process.env,'PORTAL_POSTGRES_URL')&&!postgresUrl?.trim())throw Error('PORTAL_POSTGRES_URL is empty.');
export const storageKind=testPg?'pglite':postgresUrl?'postgres':'sqlite';
if(testPg&&(process.env.RENDER||process.env.NODE_ENV==='production'))throw Error('The embedded Postgres test driver cannot be used in production.');
let sqlite,pool,embedded,closed=false;
if(storageKind==='sqlite'){
 const {DatabaseSync}=await import('node:sqlite');
 const path=process.env.PORTAL_DATABASE||resolve('data/portal.sqlite');mkdirSync(dirname(path),{recursive:true,mode:0o700});
 sqlite=new DatabaseSync(path);chmodSync(path,0o600);sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
}else if(testPg){
 const {PGlite}=await import('@electric-sql/pglite');
 embedded=new PGlite(process.env.PORTAL_TEST_POSTGRES_PATH);await embedded.waitReady;
}else{
 const {Pool,types}=await import('pg');
 types.setTypeParser(20,v=>{const n=Number(v);if(!Number.isSafeInteger(n))throw Error('Database integer exceeds safe range.');return n;});
 let parsed;
 try{parsed=new URL(postgresUrl);}catch{throw Error('PORTAL_POSTGRES_URL is invalid.');}
 if(!['postgres:','postgresql:'].includes(parsed.protocol))throw Error('PORTAL_POSTGRES_URL must be a Postgres connection string.');
 for(const key of [...parsed.searchParams.keys()])if(key.toLowerCase().startsWith('ssl'))parsed.searchParams.delete(key);
 const ca=process.env.PORTAL_POSTGRES_CA_FILE?readFileSync(process.env.PORTAL_POSTGRES_CA_FILE,'utf8'):undefined;
 pool=new Pool({connectionString:parsed.toString(),ssl:{rejectUnauthorized:true,...(ca?{ca}:{})},max:2,connectionTimeoutMillis:10000,idleTimeoutMillis:10000,statement_timeout:10000});
 pool.on('error',()=>console.error('Database connection failed.'));
}
// Application-owned SQL only; bind values separately, preserving quoted question marks.
const tables=new Set(['schema_versions','audit','notices','tickets','brands','members','portal_users','portal_sessions','portal_rate_limits','portal_staff','portal_connections','portal_events','portal_deposit_requests']);
export function postgresQuery(source){
 let index=0;
 source=source.replace(/on conflict\s*\(([^)]*)\)/gi,(_,columns)=>'on conflict ('+columns.replace(/(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\.(?=")/g,'')+')');
 return source.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z0-9_]*|\?/g,(token,offset)=>{
  if(token==='?')return '$'+(++index);
  if(token.startsWith("'"))return token;
  const identifier=token.startsWith('"')?token.slice(1,-1):token;
  return tables.has(identifier)&&source[offset-1]!=='.'?'portal_private.'+token:token;
 });
}
export async function withStorage(fn){
 if(scope.getStore())return fn();
 const preceding=queue;let release;queue=new Promise(r=>release=r);await preceding;
 let client,context;
 try{
  client=pool?await pool.connect():embedded;
  context={client,inTransaction:false};return await scope.run(context,fn);
 }finally{
  if(context?.inTransaction)try{if(sqlite)sqlite.exec('ROLLBACK');else await client.query('ROLLBACK')}catch{}
  if(pool&&client)client.release();release();
 }
}
async function query(source,values=[],arrays=false){
 if(sqlite){const statement=sqlite.prepare(source);if(arrays)statement.setReturnArrays(true);return {rows:statement.all(...values)};}
 if(!scope.getStore())return withStorage(()=>query(source,values,arrays));
 const r=await scope.getStore().client.query(postgresQuery(source),values);
 return {rows:arrays?r.rows.map(row=>r.fields.map(field=>row[field.name])):r.rows,rowCount:r.rowCount??r.affectedRows??0};
}
export const sql={
 prepare(source){let arrays=false;return {
  setReturnArrays(enabled){arrays=enabled;return this;},
  async all(...values){return (await query(source,values,arrays)).rows;},
  async get(...values){return (await query(source,values,arrays)).rows[0];},
  async run(...values){if(sqlite){const r=sqlite.prepare(source).run(...values);return {changes:Number(r.changes)};}const r=await query(source,values);return {changes:Number(r.rowCount)};}
 }},
 async exec(source){
  if(!scope.getStore())return withStorage(()=>sql.exec(source));
  const context=scope.getStore(),text=source.trim()==='BEGIN IMMEDIATE'?'BEGIN':source;
  if(sqlite)sqlite.exec(source);else if(embedded)await embedded.exec(text);else await context.client.query(text);
  if(text==='BEGIN')context.inTransaction=true;
  if(text==='COMMIT'||text==='ROLLBACK')context.inTransaction=false;
 },
 async close(){if(closed)return;closed=true;if(sqlite)sqlite.close();if(pool)await pool.end();if(embedded)await embedded.close();},
};
