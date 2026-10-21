import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {drizzle} from 'drizzle-orm/d1';
import {sql,storageKind,withStorage} from './storage.mjs';
export {sql,storageKind,withStorage};
export const identity=new AsyncLocalStorage();
await withStorage(async()=>{
 if(storageKind==='sqlite')await sql.exec('CREATE TABLE IF NOT EXISTS schema_versions(name TEXT PRIMARY KEY,hash TEXT NOT NULL)');
 else await sql.exec('CREATE SCHEMA IF NOT EXISTS portal_private; CREATE TABLE IF NOT EXISTS portal_private.schema_versions(name TEXT PRIMARY KEY,hash TEXT NOT NULL)');
 const folder=resolve(storageKind==='sqlite'?'drizzle':'standalone/postgres');
 for(const name of readdirSync(folder).filter(n=>n.endsWith('.sql')).sort()){
  const source=readFileSync(resolve(folder,name),'utf8'),hash=createHash('sha256').update(source).digest('hex'),old=await sql.prepare('SELECT hash FROM schema_versions WHERE name=?').get(name);
  if(old){if(old.hash!==hash)throw Error('Migration changed: '+name);continue;}
  await sql.exec('BEGIN IMMEDIATE');try{await sql.exec(source);await sql.prepare('INSERT INTO schema_versions VALUES (?,?)').run(name,hash);await sql.exec('COMMIT')}catch(e){await sql.exec('ROLLBACK');throw e;}
 }
 if(storageKind==='sqlite')await sql.exec(`CREATE TABLE IF NOT EXISTS portal_users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE COLLATE NOCASE,email TEXT NOT NULL UNIQUE COLLATE NOCASE,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','customer')),approved INTEGER NOT NULL DEFAULT 0,recovery_hash TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS portal_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES portal_users(id),expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS portal_rate_limits(bucket TEXT PRIMARY KEY,attempts INTEGER NOT NULL,expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS portal_staff(user_id TEXT PRIMARY KEY REFERENCES portal_users(id),tenant_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('tenant_owner','employee')));`);
});
function statement(query,args=[]){return {bind(...values){return statement(query,values)},async all(){const rows=await sql.prepare(query).all(...args);return {success:true,results:rows,meta:{changes:0}}},async run(){const r=await sql.prepare(query).run(...args);return {success:true,results:[],meta:{changes:Number(r.changes)}}},async raw(){const s=sql.prepare(query);s.setReturnArrays(true);return s.all(...args)}}}
export const database=drizzle({prepare:statement,async batch(items){return withStorage(async()=>{await sql.exec('BEGIN IMMEDIATE');try{const result=[];for(const item of items)result.push(await item.all());await sql.exec('COMMIT');return result}catch(e){await sql.exec('ROLLBACK');throw e}})}});
export async function getUser(){return identity.getStore()||null}
export function owner(email){const user=identity.getStore();return user?.role==='owner'&&user.email===email}
