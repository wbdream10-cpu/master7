import {randomUUID} from 'node:crypto';
import {sql,withStorage} from './runtime.mjs';

const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const providers=['vpay','gspay_myr','bank_transfer','unknown'];
const localDatePattern=/^\d{4}-\d{2}-\d{2}$/;
const csvCell=value=>'"'+String(value??'').replace(/^[\u0000-\u0020]*[=+@\-]/,"'$&").replace(/"/g,'""')+'"';

function validLocalDate(value){
 return typeof value==='string'&&localDatePattern.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
}
function localDate(value){
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuching',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(value);
 const part=type=>parts.find(item=>item.type===type)?.value;
 return `${part('year')}-${part('month')}-${part('day')}`;
}
function shiftDate(value,days){
 const [year,month,day]=value.split('-').map(Number);
 return new Date(Date.UTC(year,month-1,day+days)).toISOString().slice(0,10);
}
function range(params,instant){
 const today=localDate(instant),fromLocal=params.get('from')||shiftDate(today,-6),toLocal=params.get('to')||today;
 if(!validLocalDate(fromLocal)||!validLocalDate(toLocal)||toLocal<fromLocal||Date.parse(toLocal)-Date.parse(fromLocal)>30*86400000)return null;
 return {from:new Date(fromLocal+'T00:00:00+08:00').toISOString(),to:new Date(shiftDate(toLocal,1)+'T00:00:00+08:00').toISOString(),fromLocal,toLocal,timeZone:'Asia/Kuching'};
}

async function canonicalScope(user,selected){
 if(!user||typeof user.userId!=='string')return {error:json({error:'请先登录'},401)};
 if(selected!==null&&selected!==undefined&&(typeof selected!=='string'||selected.length>60||/[\u0000-\u001f\u007f]/u.test(selected)))return {error:json({error:'租户标识无效'},400)};
 const identity=await sql.prepare(`SELECT u.id,u.email,u.role,u.approved,p.tenant_id AS staff_tenant,p.role AS staff_role,m.tenant_id AS member_tenant,f.user_id AS finance_user_id
  FROM portal_users u LEFT JOIN portal_staff p ON p.user_id=u.id LEFT JOIN members m ON m.email=u.email
  LEFT JOIN portal_finance_staff f ON f.user_id=u.id AND f.tenant_id=p.tenant_id WHERE u.id=?`).get(user.userId);
 if(!identity||!identity.approved)return {error:json({error:'账号不可用'},403)};
 const actualRole=identity.role==='owner'?'owner':identity.staff_role||'customer';
 if(actualRole!==user.role)return {error:json({error:'账号权限已变化，请重新登录'},403)};
 const manager=['owner','tenant_owner'].includes(actualRole),finance=actualRole==='employee'&&Boolean(identity.finance_user_id);
 if(!manager&&!finance)return {error:json({error:'没有财务对账权限'},403)};
 const bound=actualRole==='owner'?null:identity.staff_tenant||identity.member_tenant||'main';
 if(actualRole!=='owner'&&user.tenantId&&user.tenantId!==bound)return {error:json({error:'账号租户归属已变化，请重新登录'},403)};
 if(actualRole!=='owner'&&selected&&selected!==bound)return {error:json({error:'无权访问其他租户'},403)};
 const tenantId=actualRole==='owner'?(selected||'main'):bound;
 if(tenantId!=='main'&&!await sql.prepare('SELECT id FROM brands WHERE id=?').get(tenantId))return {error:json({error:'租户不存在'},404)};
 return {tenantId,identity,manager,finance};
}

function emptyChannels(){
 return Object.fromEntries(providers.map(provider=>[provider,{count:0,amountMinor:'0'}]));
}
function summaryResponse(scope,dates,depositRows,withdrawalRow,mismatchRows){
 const channels=emptyChannels();
 for(const row of depositRows){
  if(!Object.hasOwn(channels,row.provider))continue;
  channels[row.provider]={count:Number(row.count),amountMinor:String(row.amount_minor)};
 }
 const depositCount=Object.values(channels).reduce((total,item)=>total+item.count,0);
 const depositMinor=Object.values(channels).reduce((total,item)=>total+BigInt(item.amountMinor),0n);
 const withdrawalCount=Number(withdrawalRow.count),withdrawalMinor=BigInt(withdrawalRow.amount_minor);
 const depositMismatches=Number(mismatchRows.deposit_mismatches),withdrawalMismatches=Number(mismatchRows.withdrawal_mismatches);
 return {
  tenantId:scope.tenantId,environment:'production',currency:'MYR',range:dates,
  deposits:{count:depositCount,amountMinor:depositMinor.toString(),channels},
  withdrawals:{count:withdrawalCount,amountMinor:withdrawalMinor.toString()},
  netMovementMinor:(depositMinor-withdrawalMinor).toString(),
  consistency:{depositLedgerConsistent:depositMismatches===0,withdrawalLedgerConsistent:withdrawalMismatches===0,depositMismatches,withdrawalMismatches},
  scope:'posted_wallet_journals_only; deposits_are_verified_credits; withdrawals_are_paid_debits; supplier_and_bank_statements_not_imported',
 };
}

export function createFinanceReconciliation({now=()=>new Date()}={}){
 const currentTime=()=>{const value=now();if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw new TypeError('Invalid finance reconciliation clock');return value;};

 async function readSummary(scope,dates){
  const values=[scope.tenantId,dates.from,dates.to];
  const [depositRows,withdrawalRow,depositMismatch,withdrawalMismatch]=await Promise.all([
   sql.prepare(`SELECT o.provider,count(*) AS count,CAST(COALESCE(SUM(j.member_minor),0) AS TEXT) AS amount_minor
    FROM portal_wallet_journal j JOIN portal_payment_orders o ON o.id=j.order_id
    WHERE j.tenant_id=? AND j.environment='production' AND j.currency='MYR' AND j.created_at>=? AND j.created_at<?
    GROUP BY o.provider`).all(...values),
   sql.prepare(`SELECT count(*) AS count,CAST(COALESCE(SUM(-j.member_minor),0) AS TEXT) AS amount_minor
    FROM portal_wallet_withdrawal_journal j WHERE j.tenant_id=? AND j.environment='production' AND j.currency='MYR' AND j.created_at>=? AND j.created_at<?`).get(...values),
   sql.prepare(`SELECT count(*) AS count FROM portal_wallet_journal j LEFT JOIN portal_payment_orders o ON o.id=j.order_id
    WHERE j.tenant_id=? AND j.environment='production' AND j.currency='MYR' AND j.created_at>=? AND j.created_at<?
    AND (o.id IS NULL OR o.tenant_id<>j.tenant_id OR o.user_id<>j.user_id OR o.environment<>j.environment OR o.currency<>j.currency OR o.settlement_status<>'credited' OR o.amount_minor<>j.member_minor OR j.member_minor+j.clearing_minor<>0)`).get(...values),
   sql.prepare(`SELECT count(*) AS count FROM portal_wallet_withdrawal_journal j LEFT JOIN portal_withdrawal_requests w ON w.id=j.withdrawal_id
    WHERE j.tenant_id=? AND j.environment='production' AND j.currency='MYR' AND j.created_at>=? AND j.created_at<?
    AND (w.id IS NULL OR w.tenant_id<>j.tenant_id OR w.user_id<>j.user_id OR w.environment<>j.environment OR w.currency<>j.currency OR w.status<>'paid' OR w.amount_minor<>-j.member_minor OR j.member_minor+j.clearing_minor<>0)`).get(...values),
  ]);
  return summaryResponse(scope,dates,depositRows,withdrawalRow,{deposit_mismatches:depositMismatch.count,withdrawal_mismatches:withdrawalMismatch.count});
 }

 async function getSummary(user,params){return withStorage(async()=>{
  if(!(params instanceof URLSearchParams))return json({error:'查询参数无效'},400);
  const scope=await canonicalScope(user,params.get('tenant'));if(scope.error)return scope.error;
  const dates=range(params,currentTime());if(!dates)return json({error:'日期无效；最多选择连续 31 天（Asia/Kuching）'},400);
  return json(await readSummary(scope,dates));
 });}

 async function exportRecords(user,params){return withStorage(async()=>{
  if(!(params instanceof URLSearchParams))return json({error:'查询参数无效'},400);
  const scope=await canonicalScope(user,params.get('tenant'));if(scope.error)return scope.error;
  const dates=range(params,currentTime());if(!dates)return json({error:'日期无效；最多选择连续 31 天（Asia/Kuching）'},400);
  const rows=await sql.prepare(`SELECT 'deposit' AS movement_type,j.id AS journal_id,j.order_id AS reference_id,u.username,o.provider,j.member_minor AS signed_minor,j.created_at AS posted_at
   FROM portal_wallet_journal j JOIN portal_payment_orders o ON o.id=j.order_id JOIN portal_users u ON u.id=j.user_id
   WHERE j.tenant_id=? AND j.environment='production' AND j.currency='MYR' AND j.created_at>=? AND j.created_at<?
   UNION ALL
   SELECT 'withdrawal' AS movement_type,j.id AS journal_id,j.withdrawal_id AS reference_id,u.username,'manual_withdrawal' AS provider,j.member_minor AS signed_minor,j.created_at AS posted_at
   FROM portal_wallet_withdrawal_journal j JOIN portal_withdrawal_requests w ON w.id=j.withdrawal_id JOIN portal_users u ON u.id=j.user_id
   WHERE j.tenant_id=? AND j.environment='production' AND j.currency='MYR' AND j.created_at>=? AND j.created_at<?
   ORDER BY posted_at DESC,journal_id DESC LIMIT 10001`).all(scope.tenantId,dates.from,dates.to,scope.tenantId,dates.from,dates.to);
  if(rows.length>10000)return json({error:'记录超过 10000 条，请缩短导出日期范围'},413);
  const generatedAt=currentTime().toISOString();
  await sql.prepare('INSERT INTO audit(id,tenant_id,actor,action,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),scope.tenantId,scope.identity.email,`导出统一资金对账：${dates.fromLocal} 至 ${dates.toLocal} / ${rows.length} 条`,generatedAt);
  const headers=['资金方向','账本编号','业务编号','会员','通道','金额（分，充值为正／提现为负）','币种','入账时间（UTC）'];
  const lines=rows.map(row=>[row.movement_type,row.journal_id,row.reference_id,row.username,row.provider,String(row.signed_minor),'MYR',row.posted_at].map(csvCell).join(','));
  return new Response('\ufeff'+[headers.map(csvCell).join(','),...lines].join('\r\n'),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="master7-finance-reconciliation.csv"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 });}

 return {getSummary,exportRecords};
}
