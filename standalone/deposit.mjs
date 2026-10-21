import {randomUUID} from 'node:crypto';
import {sql,storageKind} from './runtime.mjs';
import {limited} from './security.mjs';

// A request register only: no provider, checkout, wallet, settlement or credit.
if(storageKind==='sqlite')(await sql.exec(`CREATE TABLE IF NOT EXISTS portal_deposit_requests(
 id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES portal_users(id),
 amount_minor INTEGER NOT NULL CHECK(amount_minor>0 AND amount_minor<=10000000),
 currency TEXT NOT NULL CHECK(currency='MYR'),status TEXT NOT NULL CHECK(status='awaiting_connection'),
 request_key TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(user_id,request_key));`));
const json=(d,status=200)=>Response.json(d,{status});
export function amountMinor(amount){
 if(typeof amount!=='string'||! /^(0|[1-9]\d{0,5})(\.\d{1,2})?$/.test(amount))return null;
 const [major,decimal='']=amount.split('.');const n=Number(major)*100+Number(decimal.padEnd(2,'0'));
 return n>0&&n<=10000000?n:null;
}
async function scope(user,selected){
 if(user.role==='employee')return {error:json({error:'员工没有 Deposit 资料权限'},403)};
 const member=(await sql.prepare('SELECT tenant_id FROM members WHERE email=?').get(user.email));
 const bound=user.tenantId||member?.tenant_id||'main';
 if(user.role!=='owner'&&selected&&selected!==bound)return {error:json({error:'无权访问其他租户'},403)};
 const tenantId=user.role==='owner'?(selected||'main'):bound;
 if(tenantId!=='main'&&!(await sql.prepare('SELECT id FROM brands WHERE id=?').get(tenantId)))return {error:json({error:'租户不存在'},404)};
 return {tenantId,manager:['owner','tenant_owner'].includes(user.role)};
}
const publicRow=r=>({id:r.id,tenantId:r.tenant_id,amountMinor:r.amount_minor,currency:r.currency,status:r.status,createdAt:r.created_at});
export async function getDepositRequests(user,selected){
 const s=(await scope(user,selected));if(s.error)return s.error;
 const rows=(await sql.prepare('SELECT * FROM portal_deposit_requests WHERE tenant_id=?'+(s.manager?'':' AND user_id=?')+' ORDER BY created_at DESC LIMIT 100').all(...(s.manager?[s.tenantId]:[s.tenantId,user.userId])));
 return json({requests:rows.map(publicRow),connectionStatus:'not_connected',fundsProcessed:false});
}
export async function createDepositRequest(user,selected,data){
 const s=(await scope(user,selected));if(s.error)return s.error;
 const minor=amountMinor(data?.amount),requestKey=data?.requestKey;
 if(minor===null||data?.currency!=='MYR'||typeof requestKey!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(requestKey))return json({error:'请输入 0.01–100000.00 MYR，最多两位小数，并提供有效请求标识'},400);
 const old=(await sql.prepare('SELECT * FROM portal_deposit_requests WHERE user_id=? AND request_key=?').get(user.userId,requestKey));
 if(old)return old.amount_minor===minor&&old.tenant_id===s.tenantId?json({request:publicRow(old),duplicate:true,connectionStatus:'not_connected',fundsProcessed:false}):json({error:'请求标识已用于其他金额或租户'},409);
 if((await limited('deposit-request:'+user.userId,20)))return json({error:'申请过于频繁，请稍后再试'},429);
 const id=randomUUID(),now=new Date().toISOString();(await sql.exec('BEGIN IMMEDIATE'));try{
 (await sql.prepare('INSERT INTO portal_deposit_requests VALUES (?,?,?,?,?,?,?,?)').run(id,s.tenantId,user.userId,minor,'MYR','awaiting_connection',requestKey,now));
 (await sql.prepare('INSERT INTO audit(id,tenant_id,actor,action,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),s.tenantId,user.email,'记录 Deposit 申请：'+id,now));(await sql.exec('COMMIT'));
 }catch(e){(await sql.exec('ROLLBACK'));throw e;}
 return json({request:{id,tenantId:s.tenantId,amountMinor:minor,currency:'MYR',status:'awaiting_connection',createdAt:now},duplicate:false,connectionStatus:'not_connected',fundsProcessed:false},201);
}
