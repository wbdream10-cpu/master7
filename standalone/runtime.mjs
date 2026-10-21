import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,readFileSync,readdirSync,chmodSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { drizzle } from 'drizzle-orm/d1';
export const identity=new AsyncLocalStorage();
const file=process.env.PORTAL_DATABASE||resolve('data/portal.sqlite');mkdirSync(dirname(file),{recursive:true,mode:0o700});
export const sql=new DatabaseSync(file);chmodSync(file,0o600);sql.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
sql.exec('CREATE TABLE IF NOT EXISTS schema_versions (name TEXT PRIMARY KEY, hash TEXT NOT NULL)');
for(const name of readdirSync(resolve('drizzle')).filter(n=>n.endsWith('.sql')).sort()){
 const source=readFileSync(resolve('drizzle',name),'utf8'),hash=createHash('sha256').update(source).digest('hex'),old=sql.prepare('SELECT hash FROM schema_versions WHERE name=?').get(name);
 if(old){if(old.hash!==hash)throw Error('Migration changed: '+name);continue;}
 sql.exec('BEGIN IMMEDIATE');try{sql.exec(source);sql.prepare('INSERT INTO schema_versions VALUES (?,?)').run(name,hash);sql.exec('COMMIT')}catch(e){sql.exec('ROLLBACK');throw e;}
}
sql.exec(`CREATE TABLE IF NOT EXISTS portal_users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE COLLATE NOCASE,email TEXT NOT NULL UNIQUE COLLATE NOCASE,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','customer')),approved INTEGER NOT NULL DEFAULT 0,recovery_hash TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS portal_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES portal_users(id),expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS portal_rate_limits(bucket TEXT PRIMARY KEY,attempts INTEGER NOT NULL,expires_at INTEGER NOT NULL);`);
function statement(query,args=[]){return {bind(...values){return statement(query,values)},async all(){const rows=sql.prepare(query).all(...args);return {success:true,results:rows,meta:{changes:0}}},async run(){const r=sql.prepare(query).run(...args);return {success:true,results:[],meta:{changes:Number(r.changes)}}},async raw(){const s=sql.prepare(query);s.setReturnArrays(true);return s.all(...args)}}}
export const database=drizzle({prepare:statement,async batch(items){sql.exec('BEGIN IMMEDIATE');try{const result=[];for(const item of items)result.push(await item.all());sql.exec('COMMIT');return result}catch(e){sql.exec('ROLLBACK');throw e}}});
export async function getUser(){return identity.getStore()||null}
export function owner(email){const user=identity.getStore();return user?.role==='owner'&&user.email===email}
