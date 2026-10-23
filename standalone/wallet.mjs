import {randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {sql,withStorage} from './runtime.mjs';
import {normalizeVPayMYR,inspectVPayCreateResult,inspectVPayNotification,inspectVPayQueryResult,VPayContractError} from './vpay-contract.mjs';
import {createVPayOrderVerifier} from './vpay-gateway.mjs';

const json=(value,status=200)=>Response.json(value,{status});
const identifier=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,50}$/.test(v);
const merchant=v=>typeof v==='string'&&/^[1-9]\d{0,9}$/.test(v);
const expected=order=>({traderId:order.merchant_id,outTradeNo:order.id,tradeNo:order.trade_no,amount:(BigInt(order.amount_minor)/100n).toString()+'.'+(BigInt(order.amount_minor)%100n).toString().padStart(2,'0'),currency:order.currency});
const equalToken=(authorization,token)=>{
 if(typeof token!=='string'||Buffer.byteLength(token)<32||Buffer.byteLength(token)>1024||typeof authorization!=='string'||authorization.length>1100)return false;
 const a=Buffer.from(authorization),b=Buffer.from('Bearer '+token);
 return a.length===b.length&&timingSafeEqual(a,b);
};
const success=()=>new Response('SUCCESS',{headers:{'Content-Type':'text/plain; charset=utf-8'}});

export function createVPaySettlement({env=process.env,verifyOrder,now=()=>new Date()}={}){
 const trader=String(env.PORTAL_VPAY_TRADER_ID||''),environment=String(env.PORTAL_VPAY_ENVIRONMENT||'');
 const token=env.PORTAL_VPAY_CALLBACK_TOKEN;
 const enabled=env.PORTAL_VPAY_SETTLEMENT_ENABLED==='true'&&merchant(trader)&&['uat','production'].includes(environment)&&typeof token==='string'&&Buffer.byteLength(token)>=32&&Buffer.byteLength(token)<=1024;
 const verify=verifyOrder||createVPayOrderVerifier({token:env.PORTAL_VPAY_QUERY_TOKEN,environment});
 const find=id=>withStorage(()=>sql.prepare('SELECT * FROM portal_payment_orders WHERE id=? AND merchant_id=? AND environment=?').get(id,trader,environment));
 async function review(order,reason,evidence,{hold=true}={}){
  // VPay sign can contain a reversible encoding of credentials: never persist it.
  let observedMinor=null;try{observedMinor=normalizeVPayMYR(evidence?.amount).amountMinor;}catch{}
  const observed={amountMinor:observedMinor,currency:typeof evidence?.currency==='string'&&/^[A-Z]{3}$/.test(evidence.currency)?evidence.currency:null,state:/^\d{1,3}$/.test(String(evidence?.state))?String(evidence.state):null,tradeNo:typeof evidence?.trade_no==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(evidence.trade_no)?evidence.trade_no:null};
  const hash=createHash('sha256').update(JSON.stringify(observed)).digest('hex'),at=now().toISOString();
  await withStorage(async()=>{
   await sql.exec('BEGIN IMMEDIATE');try{
    await sql.prepare('INSERT INTO portal_payment_reviews(id,order_id,tenant_id,reason,evidence_hash,created_at,observed_minor,observed_currency,observed_state,observed_trade_no) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(order_id,reason,evidence_hash) DO NOTHING').run(randomUUID(),order.id,order.tenant_id,reason,hash,at,observed.amountMinor,observed.currency,observed.state,observed.tradeNo);
    if(hold)await sql.prepare('UPDATE portal_payment_orders SET review_required=1 WHERE id=?').run(order.id);
    await sql.exec('COMMIT');
   }catch(e){await sql.exec('ROLLBACK');throw e;}
  });
 }
 async function hasCredit(order){
  return withStorage(async()=>{
   const entry=await sql.prepare('SELECT * FROM portal_wallet_journal WHERE order_id=?').get(order.id);
   return Boolean(entry&&entry.user_id===order.user_id&&entry.tenant_id===order.tenant_id&&entry.environment===order.environment&&entry.currency===order.currency&&BigInt(entry.member_minor)===BigInt(order.amount_minor)&&BigInt(entry.clearing_minor)===-BigInt(order.amount_minor));
  });
 }
 // Private server operations: no browser route may bind supplier order numbers.
 async function reserveForMember(user,{amount,currency,requestKey}){
  if(!enabled)throw Error('VPAY_SETTLEMENT_DISABLED');
  const normalized=normalizeVPayMYR(amount);
  if(currency!=='MYR'||BigInt(normalized.amountMinor)>10000000n||typeof requestKey!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(requestKey))throw Error('VPAY_INVALID_ORDER');
  return withStorage(async()=>{
   const member=await sql.prepare("SELECT u.id,COALESCE(m.tenant_id,'main') AS tenant_id FROM portal_users u LEFT JOIN members m ON m.email=u.email LEFT JOIN portal_staff p ON p.user_id=u.id WHERE u.id=? AND u.role='customer' AND u.approved=1 AND p.user_id IS NULL").get(user?.userId||'');
   if(!member||user.role!=='customer'||(user.tenantId&&user.tenantId!==member.tenant_id))throw Error('VPAY_MEMBER_UNAVAILABLE');
   const id=randomUUID(),at=now().toISOString();
   await sql.prepare("INSERT INTO portal_payment_orders(id,tenant_id,user_id,request_key,merchant_id,environment,amount_minor,currency,settlement_status,created_at) VALUES (?,?,?,?,?,?,?,?,'created',?) ON CONFLICT(user_id,request_key) DO NOTHING").run(id,member.tenant_id,member.id,requestKey,trader,environment,Number(normalized.amountMinor),'MYR',at);
   const order=await sql.prepare('SELECT * FROM portal_payment_orders WHERE user_id=? AND request_key=?').get(member.id,requestKey);
   if(order.tenant_id!==member.tenant_id||order.merchant_id!==trader||order.environment!==environment||BigInt(order.amount_minor)!==BigInt(normalized.amountMinor))throw Error('VPAY_IDEMPOTENCY_CONFLICT');
   return order;
  });
 }
 async function bindCreatedOrder(id,providerReceipt){
  if(!enabled)throw Error('VPAY_SETTLEMENT_DISABLED');
  const order=await find(id);if(!order)throw Error('VPAY_ORDER_UNKNOWN');
  const result=inspectVPayCreateResult(providerReceipt,expected(order));
  return withStorage(async()=>{
   const changed=await sql.prepare("UPDATE portal_payment_orders SET trade_no=?,settlement_status='pending' WHERE id=? AND settlement_status='created' AND review_required=0").run(result.tradeNo,id);
   const current=await find(id);
   if(!changed.changes&&current?.trade_no!==result.tradeNo)throw Error('VPAY_ORDER_BINDING_CONFLICT');
   return current;
  });
 }
 async function receive(raw,authorization){
  if(!enabled)return json({error:'VPAY_SETTLEMENT_DISABLED'},503);
  if(!equalToken(authorization,token))return json({error:'VPAY_CALLBACK_UNAUTHORIZED'},401);
  if(!Buffer.isBuffer(raw)||raw.length>16384)return json({error:'VPAY_INVALID_CALLBACK'},400);
  let payload;try{payload=JSON.parse(raw.toString('utf8'));}catch{return json({error:'VPAY_INVALID_CALLBACK'},400);}
  if(!payload||Array.isArray(payload)||typeof payload!=='object'||!identifier(payload.out_trade_no)||payload.trader_id!==trader)return json({error:'VPAY_INVALID_CALLBACK'},400);
  let order=await find(payload.out_trade_no);
  if(!order)return json({error:'VPAY_ORDER_UNKNOWN'},409);
  if(!order.trade_no){
   if(!['in_flight','unknown'].includes(order.create_outcome)||typeof payload.trade_no!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(payload.trade_no))return json({error:'VPAY_ORDER_AWAITING_CONFIRMATION'},503);
   // Provisional reference: the authenticated query must match the reserved
   // order and exact amount before it can be bound or credited.
   order={...order,trade_no:payload.trade_no};
  }
  let notification;
  try{notification=inspectVPayNotification(payload,expected(order));}catch(e){
   if(!(e instanceof VPayContractError))throw e;
   await review(order,e.code,payload);
   return json({error:'VPAY_RECONCILIATION_REQUIRED'},409);
  }
  if(notification.providerState!=='paid'){
   await review(order,'VPAY_NONPAID_NOTIFICATION',payload,{hold:['reversed','risk_control','unknown'].includes(notification.providerState)});
   return json({error:'VPAY_PAYMENT_NOT_CONFIRMED'},503);
  }
  if(order.review_required)return json({error:'VPAY_RECONCILIATION_REQUIRED'},503);
  if(order.settlement_status==='credited')return await hasCredit(order)?success():json({error:'VPAY_LEDGER_INCONSISTENT'},503);
  let confirmed,receipt;
  try{receipt=await verify(order);confirmed=inspectVPayQueryResult(receipt,expected(order));}catch(e){
   const mismatch=e instanceof VPayContractError&&['VPAY_MERCHANT_MISMATCH','VPAY_ORDER_MISMATCH','VPAY_AMOUNT_MISMATCH','VPAY_CURRENCY_MISMATCH'].includes(e.code);
   await review(order,mismatch?e.code:'VPAY_VERIFICATION_PENDING',receipt?.data,{hold:mismatch});
   return json({error:'VPAY_VERIFICATION_PENDING'},503);
  }
  if(confirmed.providerState!=='paid'){
   await review(order,'VPAY_QUERY_NOT_PAID',receipt?.data,{hold:['reversed','unknown'].includes(confirmed.providerState)});
   return json({error:'VPAY_PAYMENT_NOT_CONFIRMED'},503);
  }
  return withStorage(async()=>{
   const at=now().toISOString();await sql.exec('BEGIN IMMEDIATE');
   try{
    const member=await sql.prepare("SELECT COALESCE(m.tenant_id,'main') AS tenant_id FROM portal_users u LEFT JOIN members m ON m.email=u.email LEFT JOIN portal_staff p ON p.user_id=u.id WHERE u.id=? AND u.role='customer' AND u.approved=1 AND p.user_id IS NULL").get(order.user_id);
    if(!member||member.tenant_id!==order.tenant_id){
     await sql.exec('ROLLBACK');await review(order,'VPAY_MEMBERSHIP_CHANGED',{outTradeNo:order.id});
     return json({error:'VPAY_RECONCILIATION_REQUIRED'},503);
    }
    // The conditional write serializes concurrent workers on this order as well.
    const changed=await sql.prepare("UPDATE portal_payment_orders SET settlement_status='credited',trade_no=?,create_outcome='created',verified_at=?,credited_at=? WHERE id=? AND review_required=0 AND merchant_id=? AND environment=? AND ((settlement_status='pending' AND trade_no=?) OR (settlement_status='created' AND trade_no IS NULL AND create_outcome IN ('in_flight','unknown')))").run(order.trade_no,at,at,order.id,trader,environment,order.trade_no);
    if(!changed.changes){
     const current=await find(order.id),done=current?.settlement_status==='credited'&&!current.review_required&&await hasCredit(current);
     await sql.exec('ROLLBACK');return done?success():json({error:'VPAY_SETTLEMENT_CONFLICT'},503);
    }
    await sql.prepare('INSERT INTO portal_wallet_journal(id,order_id,tenant_id,user_id,environment,currency,member_minor,clearing_minor,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(randomUUID(),order.id,order.tenant_id,order.user_id,environment,'MYR',order.amount_minor,-order.amount_minor,at);
    await sql.prepare('INSERT INTO audit(id,tenant_id,actor,action,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),order.tenant_id,'system:vpay','VPay 充值核验并入账：'+order.id,at);
    await sql.exec('COMMIT');return success();
   }catch{
    await sql.exec('ROLLBACK');await review(order,'VPAY_SETTLEMENT_RETRY',payload,{hold:false});
    return json({error:'VPAY_SETTLEMENT_RETRY'},503);
   }
  });
 }
 return {reserveForMember,bindCreatedOrder,receive,noteCreationPending:(order,evidence)=>review(order,'VPAY_ORDER_CREATION_PENDING',evidence,{hold:false})};
}

async function access(user,selected,managerOnly=false){
 if(!user)return {error:json({error:'Authentication required'},401)};
 const manager=['owner','tenant_owner'].includes(user.role);
 if(!['owner','tenant_owner','customer'].includes(user.role)||(managerOnly&&!manager))return {error:json({error:'无资金记录查看权限'},403)};
 const member=await sql.prepare('SELECT tenant_id FROM members WHERE email=?').get(user.email);
 const bound=user.tenantId||member?.tenant_id||'main';
 if(user.role!=='owner'&&selected&&selected!==bound)return {error:json({error:'无权访问其他租户'},403)};
 const tenant=user.role==='owner'?(selected||'main'):bound;
 if(tenant!=='main'&&!await sql.prepare('SELECT id FROM brands WHERE id=?').get(tenant))return {error:json({error:'租户不存在'},404)};
 return {tenant,manager};
}
const environments=new Set(['uat','production']);
export async function getWallet(user,selected,environment){
 const s=await access(user,selected);if(s.error)return s.error;
 if(!environments.has(environment))return json({error:'请选择测试或正式环境'},400);
 const row=await sql.prepare('SELECT CAST(COALESCE(SUM(member_minor),0) AS TEXT) AS balance FROM portal_wallet_journal WHERE tenant_id=? AND user_id=? AND environment=? AND currency=?').get(s.tenant,user.userId,environment,'MYR');
 return json({tenantId:s.tenant,environment,currency:'MYR',balanceMinor:row.balance,source:'wallet_journal',scope:'deposit_credits_only'});
}
function range(params){
 const today=new Date().toISOString().slice(0,10),from=params.get('from')||new Date(Date.now()-6*86400000).toISOString().slice(0,10),to=params.get('to')||today;
 const valid=v=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
 if(!valid(from)||!valid(to)||to<from||Date.parse(to)-Date.parse(from)>30*86400000)return null;
 return {from:from+'T00:00:00.000Z',to:new Date(Date.parse(to+'T00:00:00Z')+86400000).toISOString()};
}
const publicOrder=row=>({id:row.id,tenantId:row.tenant_id,member:row.username,provider:row.merchant_id==='manual_bank'?'bank_transfer':'vpay',providerOrderId:row.trade_no,environment:row.environment,currency:row.currency,amountMinor:String(row.amount_minor),creditedMinor:String(row.member_minor||0),status:row.settlement_status,creationStatus:row.create_outcome,reviewRequired:!!row.review_required,reviewCount:Number(row.review_count),createdAt:row.created_at,verifiedAt:row.verified_at,creditedAt:row.credited_at});
const csvCell=value=>'"'+String(value??'').replace(/^[\u0000-\u0020]*[=+@\-]/,"'$&").replace(/"/g,'""')+'"';
export async function getPaymentRecords(user,params,{exportCSV=false}={}){
 const s=await access(user,params.get('tenant'),exportCSV);if(s.error)return s.error;
 const environment=params.get('environment')||'production',dates=range(params);
 if(!environments.has(environment)||!dates)return json({error:'环境或日期无效；最多选择 31 天（UTC）'},400);
 const where='o.tenant_id=? AND o.environment=? AND o.created_at>=? AND o.created_at<?'+(s.manager?'':' AND o.user_id=?');
 const values=[s.tenant,environment,dates.from,dates.to,...(s.manager?[]:[user.userId])];
 let cursor='';const cursorValues=[];
 if(params.has('cursor')){
  try{
   const encoded=params.get('cursor');if(encoded.length>200||!/^[A-Za-z0-9_-]+$/.test(encoded))throw Error();
   const decoded=JSON.parse(Buffer.from(encoded,'base64url').toString());
   if(typeof decoded.at!=='string'||!/^[0-9TZ:.\-]{24}$/.test(decoded.at)||!identifier(decoded.id))throw Error();
   cursor=' AND (o.created_at<? OR (o.created_at=? AND o.id<?))';cursorValues.push(decoded.at,decoded.at,decoded.id);
  }catch{return json({error:'分页标识无效'},400);}
 }
 if(exportCSV&&cursor)return json({error:'导出不能使用分页标识'},400);
 const limit=exportCSV?10001:101;
 const rows=await sql.prepare('SELECT o.*,u.username,j.member_minor,(SELECT count(*) FROM portal_payment_reviews r WHERE r.order_id=o.id) AS review_count FROM portal_payment_orders o JOIN portal_users u ON u.id=o.user_id LEFT JOIN portal_wallet_journal j ON j.order_id=o.id WHERE '+where+cursor+' ORDER BY o.created_at DESC,o.id DESC LIMIT '+limit).all(...values,...cursorValues);
 if(exportCSV){
  if(rows.length>10000)return json({error:'记录超过 10000 条，请缩短导出日期范围'},413);
  await sql.prepare('INSERT INTO audit(id,tenant_id,actor,action,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),s.tenant,user.email,'导出充值核对记录：'+environment+' / '+dates.from+' / '+dates.to+' / '+rows.length+' 条',new Date().toISOString());
  const headers=['平台订单号','会员','充值通道','外部／核对编号','环境','币种','充值金额（分）','入账金额（分）','状态','建单结果','需复核','创建时间（UTC）','核验时间（UTC）','入账时间（UTC）'];
  const lines=rows.map(publicOrder).map(r=>[r.id,r.member,r.provider,r.providerOrderId,r.environment,r.currency,r.amountMinor,r.creditedMinor,r.status,r.creationStatus,r.reviewRequired?'是':'否',r.createdAt,r.verifiedAt,r.creditedAt].map(csvCell).join(','));
  return new Response('\ufeff'+[headers.map(csvCell).join(','),...lines].join('\r\n'),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="master7-deposit-records.csv"'}});
 }
 const totals=await sql.prepare('SELECT count(*) AS orders,CAST(COALESCE(SUM(o.amount_minor),0) AS TEXT) AS ordered_minor,CAST(COALESCE(SUM(j.member_minor),0) AS TEXT) AS credited_minor,COALESCE(SUM(CASE WHEN o.review_required=1 THEN 1 ELSE 0 END),0) AS review_orders FROM portal_payment_orders o LEFT JOIN portal_wallet_journal j ON j.order_id=o.id WHERE '+where).get(...values);
 const page=rows.slice(0,100),last=page.at(-1),ids=page.map(r=>r.id);
 const reviews=ids.length?await sql.prepare('SELECT order_id,reason,created_at,observed_minor,observed_currency,observed_state,observed_trade_no FROM portal_payment_reviews WHERE order_id IN ('+ids.map(()=>'?').join(',')+') ORDER BY created_at DESC').all(...ids):[];
 const projected=page.map(row=>({...publicOrder(row),reviews:reviews.filter(r=>r.order_id===row.id).map(r=>({reason:r.reason,createdAt:r.created_at,observedMinor:r.observed_minor,observedCurrency:r.observed_currency,observedState:r.observed_state,observedTradeNo:r.observed_trade_no}))}));
 return json({tenantId:s.tenant,environment,currency:'MYR',range:dates,records:projected,summary:{orders:Number(totals.orders),orderedMinor:totals.ordered_minor,creditedMinor:totals.credited_minor,reviewOrders:Number(totals.review_orders)},nextCursor:rows.length>100?Buffer.from(JSON.stringify({at:last.created_at,id:last.id})).toString('base64url'):null,reconciliationScope:'provider_or_bank_verified_order_and_internal_credit; bank_statement_not_imported'});
}
