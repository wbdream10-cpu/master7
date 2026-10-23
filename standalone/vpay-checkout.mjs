import {createHash} from 'node:crypto';
import {sql,withStorage} from './runtime.mjs';
import {limited} from './security.mjs';
import {createUnsignedVPayOrder,inspectVPayCreateResult,VPayContractError} from './vpay-contract.mjs';
import {createVPayOrderCreator} from './vpay-gateway.mjs';
const json=(value,status=200)=>Response.json(value,{status});
const labels={'1':'P2P 网上银行','2':'DuitNow','3':'TNG PIN','4':'Telco PIN','5':'TNG','7':'动态 DuitNow'};
const notifyOrigin='https://master7-integration-gateway.onrender.com';
export function createVPayCheckout({settlement,env=process.env,createOrder,now=()=>new Date()}={}){
 const traderId=env.PORTAL_VPAY_TRADER_ID,environment=env.PORTAL_VPAY_ENVIRONMENT;
 let codes=[],configuration;
 try{
  codes=JSON.parse(env.PORTAL_VPAY_TRADE_CODES||'[]');
  if(!Array.isArray(codes)||!codes.length||new Set(codes).size!==codes.length||codes.some(code=>!Object.hasOwn(labels,code)))throw Error();
  configuration={traderId,enabledTradeCodes:codes,notifyOrigin,callbackOrigin:env.PUBLIC_ORIGIN};
  createUnsignedVPayOrder({traderId,outTradeNo:'configuration_check',amount:'1.00',currency:'MYR',tradeCode:codes[0],title:'MASTER7 deposit',payerName:'CONFIGURATION CHECK',notifyUrl:notifyOrigin+'/callbacks/vpay/payment',callbackUrl:env.PORTAL_VPAY_RETURN_URL},configuration);
  const validToken=key=>typeof env[key]==='string'&&Buffer.byteLength(env[key])>=32&&Buffer.byteLength(env[key])<=1024;
  if(env.PORTAL_VPAY_ORDERS_ENABLED!=='true'||env.PORTAL_VPAY_SETTLEMENT_ENABLED!=='true'||!['uat','production'].includes(environment)||!['PORTAL_VPAY_CALLBACK_TOKEN','PORTAL_VPAY_QUERY_TOKEN','PORTAL_VPAY_ORDER_TOKEN'].every(validToken))throw Error();
  if(new Set([env.PORTAL_VPAY_CALLBACK_TOKEN,env.PORTAL_VPAY_QUERY_TOKEN,env.PORTAL_VPAY_ORDER_TOKEN]).size!==3)throw Error();
 }catch{configuration=null;codes=[];}
 const create=createOrder||createVPayOrderCreator({queryToken:env.PORTAL_VPAY_QUERY_TOKEN,orderToken:env.PORTAL_VPAY_ORDER_TOKEN,environment});
 const publicStatus=user=>!user?json({error:'请先登录'},401):json({provider:'vpay',enabled:Boolean(configuration)&&user.role==='customer',subject:JSON.stringify([user.userId,user.tenantId||'main']),environment:configuration?environment:null,currency:'MYR',methods:configuration&&user.role==='customer'?codes.map(code=>({code,label:labels[code]})):[]});
 async function submit(user,data){
  if(!user)return json({error:'请先登录'},401);
  if(user.role!=='customer')return json({error:'仅会员可以创建本人充值订单'},403);
  if(!configuration)return json({error:'VPAY_CHECKOUT_DISABLED'},503);
  if(!data||Array.isArray(data)||typeof data!=='object')return json({error:'VPAY_INVALID_ORDER'},400);
  const fields={traderId,amount:data.amount,currency:data.currency,tradeCode:data.tradeCode,title:'MASTER7 deposit',payerName:data.payerName,notifyUrl:notifyOrigin+'/callbacks/vpay/payment',callbackUrl:env.PORTAL_VPAY_RETURN_URL};
  let canonical;
  try{canonical=createUnsignedVPayOrder({...fields,outTradeNo:'validation_only'},configuration);}catch{return json({error:'VPAY_INVALID_ORDER'},400);}
  if(await withStorage(()=>limited('vpay-create:'+user.userId,20)))return json({error:'申请过于频繁，请稍后重试'},429);
  let order;
  try{order=await settlement.reserveForMember(user,{amount:canonical.amount,currency:'MYR',requestKey:data.requestKey});}catch(e){
   const code=e instanceof VPayContractError?e.code:e.message;
   return json({error:code==='VPAY_IDEMPOTENCY_CONFLICT'?code:'VPAY_INVALID_ORDER'},code==='VPAY_IDEMPOTENCY_CONFLICT'?409:400);
  }
  const fingerprint=createHash('sha256').update(JSON.stringify({merchant:traderId,environment,amount:canonical.amount,tradeCode:canonical.trade_code,payerName:canonical.payer_name,returnUrl:canonical.callback_url})).digest('hex');
  const claimed=await withStorage(async()=>{
   const change=await sql.prepare("UPDATE portal_payment_orders SET create_outcome='in_flight',create_attempted_at=?,create_fingerprint=?,trade_code=? WHERE id=? AND create_outcome='not_sent' AND settlement_status='created' AND review_required=0").run(now().toISOString(),fingerprint,canonical.trade_code,order.id);
   const current=await sql.prepare('SELECT * FROM portal_payment_orders WHERE id=?').get(order.id);
   return {send:change.changes===1,order:current};
  });
  order=claimed.order;
  if(order.create_fingerprint!==fingerprint)return json({error:'VPAY_IDEMPOTENCY_CONFLICT'},409);
  function result(row){
   if(row.review_required)return json({id:row.id,status:'review_required',payUrl:null},202);
   if(row.settlement_status==='credited')return json({id:row.id,status:'credited',payUrl:null},200);
   if(row.create_outcome==='created'&&row.checkout_url)return json({id:row.id,status:'awaiting_payment',payUrl:row.checkout_url,expiresAtRaw:row.expires_at_raw},200);
   return json({id:row.id,status:'awaiting_confirmation',payUrl:null},202);
  }
  if(!claimed.send)return result(order);
  try{
   const draft=createUnsignedVPayOrder({...fields,outTradeNo:order.id},configuration),receipt=await create(draft);
   const checked=inspectVPayCreateResult(receipt,{traderId,outTradeNo:order.id,amount:draft.amount,currency:'MYR'});
   await settlement.bindCreatedOrder(order.id,receipt);
   const current=await withStorage(async()=>{
    await sql.prepare("UPDATE portal_payment_orders SET create_outcome='created',checkout_url=?,expires_at_raw=? WHERE id=? AND trade_no=?").run(checked.payUrl,checked.expiresAtRaw,order.id,checked.tradeNo);
    return sql.prepare('SELECT * FROM portal_payment_orders WHERE id=?').get(order.id);
   });
   return result(current);
  }catch{
   // A timeout never proves that the provider did not create an order.
   // The durable claim prevents automatic resending, including after restart.
   await withStorage(()=>sql.prepare("UPDATE portal_payment_orders SET create_outcome='unknown' WHERE id=? AND create_outcome='in_flight' AND settlement_status<>'credited'").run(order.id));
   const recovered=await withStorage(()=>sql.prepare('SELECT * FROM portal_payment_orders WHERE id=?').get(order.id));
   if(recovered.settlement_status==='credited')return result(recovered);
   await settlement.noteCreationPending(order,{});
   return result(await withStorage(()=>sql.prepare('SELECT * FROM portal_payment_orders WHERE id=?').get(order.id)));
  }
 }
 return {publicStatus,submit};
}
