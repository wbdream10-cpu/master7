import {randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {sql,withStorage} from './runtime.mjs';
import {normalizeVPayMYR,inspectVPayCreateResult,inspectVPayNotification,inspectVPayQueryResult,VPayContractError} from './vpay-contract.mjs';
import {createVPayOrderVerifier} from './vpay-gateway.mjs';
import {createVPayStore} from './vpay-store.mjs';
import {withdrawalWalletState} from './withdrawals.mjs';

const json=(value,status=200)=>Response.json(value,{status});
const identifier=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,50}$/.test(v);
const merchant=v=>typeof v==='string'&&/^[1-9]\d{0,9}$/.test(v);
const decimal=minor=>(BigInt(minor)/100n).toString()+'.'+(BigInt(minor)%100n).toString().padStart(2,'0');
const expected=order=>({traderId:order.merchantId,outTradeNo:order.id,tradeNo:order.tradeNo,amount:decimal(order.amountMinor),currency:order.currency});
const equalToken=(authorization,token)=>{
 if(typeof token!=='string'||Buffer.byteLength(token)<32||Buffer.byteLength(token)>1024||typeof authorization!=='string'||authorization.length>1100)return false;
 const a=Buffer.from(authorization),b=Buffer.from('Bearer '+token);
 return a.length===b.length&&timingSafeEqual(a,b);
};
const success=()=>new Response('SUCCESS',{headers:{'Content-Type':'text/plain; charset=utf-8'}});

export function createVPaySettlement({env=process.env,verifyOrder,now=()=>new Date()}={}){
 const trader=String(env.PORTAL_VPAY_TRADER_ID||''),environment=String(env.PORTAL_VPAY_ENVIRONMENT||'');
 const token=env.PORTAL_VPAY_CALLBACK_TOKEN;
 const validToken=value=>typeof value==='string'&&Buffer.byteLength(value)>=32&&Buffer.byteLength(value)<=1024;
 const queryToken=env.PORTAL_VPAY_QUERY_TOKEN,orderToken=env.PORTAL_VPAY_ORDER_TOKEN;
 const injectedVerifier=typeof verifyOrder==='function';
 const credentialsReady=injectedVerifier||(validToken(queryToken)&&queryToken!==token&&
  (!Object.hasOwn(env,'PORTAL_VPAY_ORDER_TOKEN')||(validToken(orderToken)&&orderToken!==token&&orderToken!==queryToken)));
 const enabled=env.PORTAL_VPAY_SETTLEMENT_ENABLED==='true'&&merchant(trader)&&['uat','production'].includes(environment)&&validToken(token)&&credentialsReady;
 const verify=verifyOrder||createVPayOrderVerifier({token:env.PORTAL_VPAY_QUERY_TOKEN,environment});
 const durable=merchant(trader)&&['uat','production'].includes(environment)?createVPayStore({merchantId:trader,environment,now}):null;
 const find=id=>durable?.store.findById(id);
 async function review(order,reason,evidence,{hold=true}={}){
  // VPay sign can contain a reversible encoding of credentials: never persist it.
  let observedMinor=null;try{observedMinor=normalizeVPayMYR(evidence?.amount).amountMinor;}catch{}
  const observed={amountMinor:observedMinor,currency:typeof evidence?.currency==='string'&&/^[A-Z]{3}$/.test(evidence.currency)?evidence.currency:null,state:/^\d{1,3}$/.test(String(evidence?.state))?String(evidence.state):null,tradeNo:typeof evidence?.trade_no==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(evidence.trade_no)?evidence.trade_no:null};
  const hash=createHash('sha256').update(JSON.stringify(observed)).digest('hex'),at=now().toISOString();
  await withStorage(async()=>{
   await sql.exec('BEGIN IMMEDIATE');try{
    await sql.prepare('INSERT INTO portal_payment_reviews(id,order_id,tenant_id,reason,evidence_hash,created_at,observed_minor,observed_currency,observed_state,observed_trade_no) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(order_id,reason,evidence_hash) DO NOTHING').run(randomUUID(),order.id,order.tenantId,reason,hash,at,observed.amountMinor,observed.currency,observed.state,observed.tradeNo);
    if(hold)await sql.prepare("UPDATE portal_payment_orders SET review_required=1 WHERE id=? AND provider='vpay'").run(order.id);
    await sql.exec('COMMIT');
   }catch(e){await sql.exec('ROLLBACK');throw e;}
  });
 }
 async function hasCredit(order){
  return withStorage(async()=>{
   const entry=await sql.prepare('SELECT * FROM portal_wallet_journal WHERE order_id=?').get(order.id);
   return Boolean(entry&&entry.user_id===order.userId&&entry.tenant_id===order.tenantId&&entry.environment===order.environment&&entry.currency===order.currency&&BigInt(entry.member_minor)===BigInt(order.amountMinor)&&BigInt(entry.clearing_minor)===-BigInt(order.amountMinor));
  });
 }
 async function reserveForMember(user,{amount,currency,requestKey,fingerprint,tradeCode}){
  if(!enabled)throw Error('VPAY_SETTLEMENT_DISABLED');
  const normalized=normalizeVPayMYR(amount);
  if(currency!=='MYR'||BigInt(normalized.amountMinor)>10000000n)throw Error('VPAY_INVALID_ORDER');
  const member=await durable.resolveMember(user);
  const result=await durable.store.reserve({id:randomUUID(),userId:member.userId,tenantId:member.tenantId,
   requestKey,amountMinor:normalized.amountMinor,currency:'MYR',fingerprint,tradeCode,createdAt:now().toISOString()});
  return result.order;
 }
 async function claimCreate(id,{fingerprint,attemptedAt}){
  if(!enabled)throw Error('VPAY_SETTLEMENT_DISABLED');
  return durable.store.claimCreate(id,{fingerprint,attemptedAt});
 }
 async function bindCreatedOrder(id,providerReceipt,{updatedAt=now().toISOString()}={}){
  if(!enabled)throw Error('VPAY_SETTLEMENT_DISABLED');
  const order=await find(id);if(!order)throw Error('VPAY_ORDER_UNKNOWN');
  const result=inspectVPayCreateResult(providerReceipt,expected(order));
  return durable.store.markCreated(id,{tradeNo:result.tradeNo,checkoutUrl:result.payUrl,expiresAtRaw:result.expiresAtRaw,updatedAt});
 }
 async function processQuery(order){
  const claim=await durable.store.claimQuery(order.id,{attemptedAt:now().toISOString()});
  if(!claim.claimed){
   if(claim.order?.settlementStatus==='credited')return await hasCredit(claim.order)?'credited':'ledger_inconsistent';
   return 'busy';
  }
  const claimed=claim.order,attemptId=claimed.queryAttemptId,claimToken=claimed.queryClaimToken;
  let confirmed,receipt;
  try{
   receipt=await verify({id:claimed.id,trade_no:claimed.tradeNo,merchant_id:claimed.merchantId});
   confirmed=inspectVPayQueryResult(receipt,expected(claimed));
  }catch(error){
   const mismatch=error instanceof VPayContractError&&['VPAY_MERCHANT_MISMATCH','VPAY_ORDER_MISMATCH','VPAY_AMOUNT_MISMATCH','VPAY_CURRENCY_MISMATCH'].includes(error.code);
   try{await durable.store.finishQuery(claimed.id,{attemptId,claimToken,queryState:'unknown',reason:mismatch?error.code:'VPAY_VERIFICATION_PENDING',updatedAt:now().toISOString()});}catch{}
   if(mismatch)await review(claimed,error.code,receipt?.data);
   return mismatch?'review':'pending';
  }
  if(confirmed.providerState==='paid'){
   try{
    const result=await durable.settlement.commitConfirmed({orderId:claimed.id,attemptId,claimToken,
     confirmation:{provider:'vpay',source:'gateway_query',gatewayAuthenticated:true,providerState:'paid',currency:'MYR',tradeNo:confirmed.tradeNo,amountMinor:confirmed.amountMinor},
     committedAt:now().toISOString()});
    return result.credited||result.alreadyCredited?'credited':result.reviewRequired?'review':'pending';
   }catch(error){
    if(error?.message==='VPAY_QUERY_LEASE_LOST')return 'busy';
    try{await durable.store.finishQuery(claimed.id,{attemptId,claimToken,queryState:'unknown',reason:'VPAY_SETTLEMENT_RETRY',updatedAt:now().toISOString()});}catch{}
    await review(claimed,'VPAY_SETTLEMENT_RETRY',{}, {hold:false});
    return 'pending';
   }
  }
  const queryState=['failed','reversed'].includes(confirmed.providerState)?confirmed.providerState:confirmed.providerState==='pending'?'pending':'unknown';
  try{await durable.store.finishQuery(claimed.id,{attemptId,claimToken,queryState,reason:queryState==='pending'?'VPAY_QUERY_PENDING':'VPAY_QUERY_NOT_PAID',tradeNo:confirmed.tradeNo,amountMinor:confirmed.amountMinor,updatedAt:now().toISOString()});}catch(error){if(error?.message==='VPAY_QUERY_LEASE_LOST')return 'busy';throw error;}
  if(['reversed','unknown'].includes(queryState))await review(claimed,'VPAY_QUERY_NOT_PAID',{amount:confirmed.amount,currency:'MYR',state:confirmed.providerStateCode,trade_no:confirmed.tradeNo});
  return queryState==='pending'?'pending':'review';
 }
 async function receive(raw,authorization){
  if(!enabled)return json({error:'VPAY_SETTLEMENT_DISABLED'},503);
  if(!equalToken(authorization,token))return json({error:'VPAY_CALLBACK_UNAUTHORIZED'},401);
  if(!Buffer.isBuffer(raw)||raw.length>16384)return json({error:'VPAY_INVALID_CALLBACK'},400);
  let payload;try{payload=JSON.parse(raw.toString('utf8'));}catch{return json({error:'VPAY_INVALID_CALLBACK'},400);}
  if(!payload||Array.isArray(payload)||typeof payload!=='object'||!identifier(payload.out_trade_no)||payload.trader_id!==trader)return json({error:'VPAY_INVALID_CALLBACK'},400);
  let order=await find(payload.out_trade_no);
  if(!order)return json({error:'VPAY_ORDER_UNKNOWN'},409);
  if(!order.tradeNo){
   if(!['in_flight','unknown'].includes(order.createState)||typeof payload.trade_no!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(payload.trade_no))return json({error:'VPAY_ORDER_AWAITING_CONFIRMATION'},503);
   // Provisional reference: the authenticated query must match the reserved
   // order and exact amount before it can be bound or credited.
   order={...order,tradeNo:payload.trade_no};
  }
  let notification;
  try{notification=inspectVPayNotification(payload,expected(order));}catch(e){
   if(!(e instanceof VPayContractError))throw e;
   await review(order,e.code,payload);
   return json({error:'VPAY_RECONCILIATION_REQUIRED'},409);
  }
  const action=notification.providerState==='paid'?'independent_query_required':['reversed','risk_control','unknown'].includes(notification.providerState)?'finance_review_required':'not_payable';
  const eventId=createHash('sha256').update(JSON.stringify({version:1,orderId:order.id,tradeNo:notification.tradeNo,amountMinor:notification.amountMinor,state:notification.providerState})).digest('hex');
  try{await durable.store.recordCallback(order.id,{eventId,tradeNo:notification.tradeNo,reportedState:notification.providerState,action,amountMinor:notification.amountMinor,currency:'MYR',receivedAt:now().toISOString()});}
  catch{return json({error:'VPAY_RECONCILIATION_REQUIRED'},409);}
  if(notification.providerState!=='paid')return json({error:'VPAY_PAYMENT_NOT_CONFIRMED'},503);
  order=await find(order.id);
  if(order.reviewRequired)return json({error:'VPAY_RECONCILIATION_REQUIRED'},503);
  if(order.settlementStatus==='credited')return await hasCredit(order)?success():json({error:'VPAY_LEDGER_INCONSISTENT'},503);
  const outcome=await processQuery(order);
  if(outcome==='credited')return success();
  if(outcome==='ledger_inconsistent')return json({error:'VPAY_LEDGER_INCONSISTENT'},503);
  if(outcome==='review')return json({error:'VPAY_RECONCILIATION_REQUIRED'},503);
  return json({error:'VPAY_VERIFICATION_PENDING'},503);
 }
 async function recoverPending({limit=25}={}){
  if(!enabled||env.PORTAL_VPAY_RECOVERY_ENABLED!=='true')return {enabled:false,processed:0,credited:0};
  const candidates=await durable.store.listRecoveryCandidates({limit});let processed=0,credited=0;
  for(const order of candidates){const outcome=await processQuery(order);processed++;if(outcome==='credited')credited++;}
  return {enabled:true,processed,credited};
 }
 async function noteCreationPending(order){
  const current=await durable.store.markCreateUnknown(order.id,{updatedAt:now().toISOString()});
  if(current.settlementStatus!=='credited')await review(current,'VPAY_ORDER_CREATION_PENDING',{}, {hold:false});
  return current;
 }
 return {reserveForMember,claimCreate,bindCreatedOrder,receive,recoverPending,noteCreationPending};
}

export function startVPayRecovery(settlement,{env=process.env,setIntervalFn=setInterval}={}){
 if(env.PORTAL_VPAY_RECOVERY_ENABLED!=='true'||typeof settlement?.recoverPending!=='function')return {enabled:false,stop(){}};
 const requested=Number(env.PORTAL_VPAY_RECOVERY_INTERVAL_MS||120000),interval=Number.isInteger(requested)&&requested>=60000&&requested<=3600000?requested:120000;
 let running=false;
 const run=async()=>{if(running)return;running=true;try{await settlement.recoverPending({limit:25});}catch{console.error('VPay recovery pass failed.');}finally{running=false;}};
 const timer=setIntervalFn(run,interval);timer?.unref?.();queueMicrotask(run);
 return {enabled:true,stop(){clearInterval(timer);}};
}

async function access(user,selected,{financeRecords=false}={}){
 if(!user)return {error:json({error:'Authentication required'},401)};
 if(!['owner','tenant_owner','employee','customer'].includes(user.role))return {error:json({error:'无资金记录查看权限'},403)};
 const identity=await sql.prepare(`SELECT u.email,u.role,u.approved,p.tenant_id AS staff_tenant,p.role AS staff_role,m.tenant_id AS member_tenant,f.user_id AS finance_user_id
  FROM portal_users u LEFT JOIN portal_staff p ON p.user_id=u.id LEFT JOIN members m ON m.email=u.email
  LEFT JOIN portal_finance_staff f ON f.user_id=u.id AND f.tenant_id=p.tenant_id WHERE u.id=?`).get(user.userId);
 if(!identity||!identity.approved)return {error:json({error:'账号不可用'},403)};
 const actualRole=identity.role==='owner'?'owner':identity.staff_role||'customer';
 if(actualRole!==user.role)return {error:json({error:'账号权限已变化，请重新登录'},403)};
 const manager=['owner','tenant_owner'].includes(actualRole);
 const finance=actualRole==='employee'&&Boolean(identity.finance_user_id);
 if(actualRole==='employee'&&(!financeRecords||!finance))return {error:json({error:'无资金记录查看权限'},403)};
 const bound=actualRole==='owner'?null:identity.staff_tenant||identity.member_tenant;
 if(actualRole!=='owner'&&!bound)return {error:json({error:'账号尚未绑定会员租户'},403)};
 if(actualRole!=='owner'&&user.tenantId&&user.tenantId!==bound)return {error:json({error:'账号租户归属已变化，请重新登录'},403)};
 if(actualRole!=='owner'&&selected&&selected!==bound)return {error:json({error:'无权访问其他租户'},403)};
 const tenant=actualRole==='owner'?(selected||'main'):bound;
 if(tenant!=='main'&&!await sql.prepare('SELECT id FROM brands WHERE id=?').get(tenant))return {error:json({error:'租户不存在'},404)};
 return {tenant,manager,finance,canViewAll:manager||finance};
}
const environments=new Set(['uat','production']);
export async function getWallet(user,selected,environment){
 const s=await access(user,selected);if(s.error)return s.error;
 if(user.role==='employee')return json({error:'没有钱包余额查看权限'},403);
 if(!environments.has(environment))return json({error:'请选择测试或正式环境'},400);
 if(environment==='production'){
  const wallet=await withdrawalWalletState(s.tenant,user.userId);
  return json({tenantId:s.tenant,environment,currency:'MYR',balanceMinor:wallet.balanceMinor,postedBalanceMinor:wallet.balanceMinor,heldMinor:wallet.heldMinor,availableMinor:wallet.availableMinor,source:'wallet_journals',scope:'verified_deposit_credits_minus_paid_withdrawals'});
 }
 const row=await sql.prepare('SELECT CAST(COALESCE(SUM(member_minor),0) AS TEXT) AS balance FROM portal_wallet_journal WHERE tenant_id=? AND user_id=? AND environment=? AND currency=?').get(s.tenant,user.userId,environment,'MYR');
 return json({tenantId:s.tenant,environment,currency:'MYR',balanceMinor:row.balance,postedBalanceMinor:row.balance,heldMinor:'0',availableMinor:row.balance,source:'wallet_journal',scope:'deposit_credits_only'});
}
function localDate(value){
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuching',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(value);
 const part=type=>parts.find(item=>item.type===type)?.value;
 return `${part('year')}-${part('month')}-${part('day')}`;
}
function shiftDate(value,days){const [year,month,day]=value.split('-').map(Number);return new Date(Date.UTC(year,month-1,day+days)).toISOString().slice(0,10);}
function range(params){
 const today=localDate(new Date()),from=params.get('from')||shiftDate(today,-6),to=params.get('to')||today;
 const valid=v=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
 if(!valid(from)||!valid(to)||to<from||Date.parse(to)-Date.parse(from)>30*86400000)return null;
 return {from:new Date(from+'T00:00:00+08:00').toISOString(),to:new Date(shiftDate(to,1)+'T00:00:00+08:00').toISOString(),fromLocal:from,toLocal:to,timeZone:'Asia/Kuching'};
}
const publicOrder=row=>({id:row.id,tenantId:row.tenant_id,member:row.username,provider:row.provider||'unknown',providerOrderId:row.trade_no,environment:row.environment,currency:row.currency,amountMinor:String(row.amount_minor),creditedMinor:String(row.member_minor||0),status:row.settlement_status,creationStatus:row.create_outcome,reviewRequired:!!row.review_required,reviewCount:Number(row.review_count),createdAt:row.created_at,verifiedAt:row.verified_at,creditedAt:row.credited_at});
const csvCell=value=>'"'+String(value??'').replace(/^[\u0000-\u0020]*[=+@\-]/,"'$&").replace(/"/g,'""')+'"';
export async function getPaymentRecords(user,params,{exportCSV=false}={}){
 const s=await access(user,params.get('tenant'),{financeRecords:true});if(s.error)return s.error;
 if(exportCSV&&!s.canViewAll)return json({error:'只有获授权财务人员或管理员可以导出'},403);
 const environment=params.get('environment')||'production',dates=range(params);
 if(!environments.has(environment)||!dates)return json({error:'环境或日期无效；最多选择 31 天（Asia/Kuching）'},400);
 const where='o.tenant_id=? AND o.environment=? AND o.created_at>=? AND o.created_at<?'+(s.canViewAll?'':' AND o.user_id=?');
 const values=[s.tenant,environment,dates.from,dates.to,...(s.canViewAll?[]:[user.userId])];
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
  return new Response('\ufeff'+[headers.map(csvCell).join(','),...lines].join('\r\n'),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="master7-reconciliation-records.csv"'}});
 }
 const totals=await sql.prepare('SELECT count(*) AS orders,CAST(COALESCE(SUM(o.amount_minor),0) AS TEXT) AS ordered_minor,CAST(COALESCE(SUM(j.member_minor),0) AS TEXT) AS credited_minor,COALESCE(SUM(CASE WHEN o.review_required=1 THEN 1 ELSE 0 END),0) AS review_orders FROM portal_payment_orders o LEFT JOIN portal_wallet_journal j ON j.order_id=o.id WHERE '+where).get(...values);
 const page=rows.slice(0,100),last=page.at(-1),ids=page.map(r=>r.id);
 const reviews=ids.length?await sql.prepare('SELECT order_id,reason,created_at,observed_minor,observed_currency,observed_state,observed_trade_no FROM portal_payment_reviews WHERE order_id IN ('+ids.map(()=>'?').join(',')+') ORDER BY created_at DESC').all(...ids):[];
 const projected=page.map(row=>({...publicOrder(row),reviews:reviews.filter(r=>r.order_id===row.id).map(r=>({reason:r.reason,createdAt:r.created_at,observedMinor:r.observed_minor,observedCurrency:r.observed_currency,observedState:r.observed_state,observedTradeNo:r.observed_trade_no}))}));
 return json({tenantId:s.tenant,environment,currency:'MYR',range:dates,records:projected,summary:{orders:Number(totals.orders),orderedMinor:totals.ordered_minor,creditedMinor:totals.credited_minor,reviewOrders:Number(totals.review_orders)},nextCursor:rows.length>100?Buffer.from(JSON.stringify({at:last.created_at,id:last.id})).toString('base64url'):null,reconciliationScope:'provider_or_bank_verified_order_and_internal_credit; bank_statement_not_imported'});
}
