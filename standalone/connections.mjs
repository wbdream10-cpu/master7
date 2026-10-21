import {createHmac,timingSafeEqual,randomUUID} from 'node:crypto';
import {sql,storageKind} from './runtime.mjs';
import {limited} from './security.mjs';

// No connectors or sample events are created at startup.
if(storageKind==='sqlite')(await sql.exec(`CREATE TABLE IF NOT EXISTS portal_connections(
 id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,key_env TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS portal_events(
 id TEXT PRIMARY KEY,connection_id TEXT NOT NULL REFERENCES portal_connections(id),event_id TEXT NOT NULL,
 type TEXT NOT NULL,payload TEXT NOT NULL,received_at TEXT NOT NULL,
 UNIQUE(connection_id,event_id));`));
const json=(data,status=200)=>Response.json(data,{status});
const idValid=s=>typeof s==='string'&&/^[a-z0-9][a-z0-9_-]{2,39}$/.test(s);
const keyValid=s=>typeof s==='string'&&/^PORTAL_HOOK_[A-Z0-9_]{3,60}$/.test(s);
function keyFor(row){const s=process.env[row.key_env];return typeof s==='string'&&Buffer.byteLength(s)>=32?s:null;}
export async function listConnections(){return (await sql.prepare('SELECT * FROM portal_connections ORDER BY created_at DESC').all()).map(c=>({id:c.id,tenantId:c.tenant_id,keyEnv:c.key_env,enabled:!!c.enabled,configured:!!keyFor(c),callbackPath:'/api/v1/hooks/'+c.id}));}
export async function configureConnection(data,user){
 if(!idValid(data.id)||!keyValid(data.keyEnv)||typeof data.tenantId!=='string'||data.tenantId.length>60)return json({error:'连接标识、工作空间或密钥环境变量名称无效'},400);
 if(data.tenantId!=='main'&&!(await sql.prepare('SELECT id FROM brands WHERE id=?').get(data.tenantId)))return json({error:'工作空间不存在'},404);
 const old=(await sql.prepare('SELECT * FROM portal_connections WHERE id=?').get(data.id));
 if(old&&old.tenant_id!==data.tenantId)return json({error:'已有连接不能转移到其他工作空间，请另建连接'},409);
 if(!old&&(await sql.prepare('SELECT count(*) AS n FROM portal_connections').get()).n>=100)return json({error:'连接数量已达上限'},409);
 const now=new Date().toISOString();(await sql.exec('BEGIN IMMEDIATE'));try{
 (await sql.prepare('INSERT INTO portal_connections VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET key_env=excluded.key_env,enabled=excluded.enabled').run(data.id,data.tenantId,data.keyEnv,data.enabled===true?1:0,now));
 (await sql.prepare('INSERT INTO audit(id,actor,action,created_at,tenant_id) VALUES (?,?,?,?,?)').run(randomUUID(),user.email,'保存通用连接：'+data.id,now,data.tenantId));
 (await sql.exec('COMMIT'));}catch(e){(await sql.exec('ROLLBACK'));throw e;}
 return json({ok:true});
}
export async function receiveEvent(req,connectionId,raw){
 if((await limited('hook-ip:'+(req.socket.remoteAddress||'unknown'),120)))return json({error:'Too many requests'},429);
 const row=(await sql.prepare('SELECT * FROM portal_connections WHERE id=? AND enabled=1').get(connectionId)),key=row&&keyFor(row);
 if(!key)return json({error:'Connection unavailable'},503);
 const timestamp=String(req.headers['x-portal-timestamp']||''),eventId=String(req.headers['x-portal-event-id']||''),signature=String(req.headers['x-portal-signature']||'');
 if(!/^\d{10}$/.test(timestamp)||Math.abs(Date.now()/1000-Number(timestamp))>300||!/^[A-Za-z0-9_.:-]{1,100}$/.test(eventId)||!/^sha256=[0-9a-f]{64}$/.test(signature))return json({error:'Invalid authentication'},401);
 const expected=createHmac('sha256',key).update(timestamp+'.'+eventId+'.').update(raw).digest();
 if(!timingSafeEqual(expected,Buffer.from(signature.slice(7),'hex')))return json({error:'Invalid authentication'},401);
 if(!String(req.headers['content-type']).startsWith('application/json'))return json({error:'JSON required'},415);
 let data;try{data=JSON.parse(raw.toString('utf8'));}catch{return json({error:'Invalid JSON'},400);}
 if(!data||Array.isArray(data)||typeof data!=='object'||typeof data.type!=='string'||!/^[a-zA-Z0-9_.:-]{1,80}$/.test(data.type)||!data.data||Array.isArray(data.data)||typeof data.data!=='object')return json({error:'Expected type and data object'},400);
 const prior=(await sql.prepare('SELECT payload FROM portal_events WHERE connection_id=? AND event_id=?').get(row.id,eventId));
 if(prior)return prior.payload===raw.toString('utf8')?json({accepted:true,duplicate:true,processed:false},202):json({error:'Event ID conflict'},409);
 if((await limited('hook-connection:'+row.id,1000)))return json({error:'Event limit reached'},429);
 if((await sql.prepare('SELECT count(*) AS n FROM portal_events').get()).n>=10000)return json({error:'Event storage limit reached'},507);
 (await sql.prepare('INSERT INTO portal_events VALUES (?,?,?,?,?,?)').run(randomUUID(),row.id,eventId,data.type,raw.toString('utf8'),new Date().toISOString()));
 return json({accepted:true,duplicate:false,processed:false},202);
}
export async function listEvents(){return (await sql.prepare('SELECT e.id,e.connection_id AS "connectionId",c.tenant_id AS "tenantId",e.event_id AS "eventId",e.type,e.received_at AS "receivedAt" FROM portal_events e JOIN portal_connections c ON c.id=e.connection_id ORDER BY e.received_at DESC LIMIT 100').all());}
