// All external destinations are fixed. Scope-specific secrets stay server-side.
const gateway='https://master7-integration-gateway.onrender.com';
function reader({queryToken,environment,fetchImpl}){
 const valid=token=>typeof token==='string'&&Buffer.byteLength(token)>=32&&Buffer.byteLength(token)<=1024;
 async function read(path,{token=queryToken,body}={}){
  if(!valid(token)||!['uat','production'].includes(environment))throw Error('VPAY_GATEWAY_UNAVAILABLE');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  try{
   const response=await fetchImpl(gateway+path,{method:body?'POST':'GET',redirect:'error',signal:controller.signal,headers:{Accept:'application/json',Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
   if(!response.ok||response.redirected)throw Error('VPAY_GATEWAY_UNAVAILABLE');
   let size=0;const chunks=[];
   if(response.body)for await(const chunk of response.body){size+=chunk.length;if(size>65536)throw Error('VPAY_GATEWAY_UNAVAILABLE');chunks.push(Buffer.from(chunk));}
   try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('VPAY_GATEWAY_UNAVAILABLE');}
  }finally{clearTimeout(timer);}
 }
 async function configuration(traderId){
  const result=await read('/platform/vpay/config');
  if(result.provider!=='vpay'||result.configured!==true||result.mode!==environment||result.traderId!==traderId)throw Error('VPAY_ENVIRONMENT_UNCONFIRMED');
  return result;
 }
 return {read,configuration};
}
export function createVPayOrderVerifier({token,environment,fetchImpl=globalThis.fetch}){
 const client=reader({queryToken:token,environment,fetchImpl});
 return async order=>{
  await client.configuration(order.merchant_id);
  const result=await client.read('/platform/vpay/order-query',{body:{outTradeNo:order.id,tradeNo:order.trade_no}});
  if(result.provider!=='vpay'||result.upstreamStatus!==200)throw Error('VPAY_QUERY_UNAVAILABLE');
  return result.result;
 };
}
export function createVPayOrderCreator({queryToken,orderToken,environment,fetchImpl=globalThis.fetch}){
 const client=reader({queryToken,environment,fetchImpl});
 return async draft=>{
  const status=await client.configuration(draft.trader_id);
  if(status.paymentReady!==true||!Array.isArray(status.tradeCodes)||!status.tradeCodes.includes(draft.trade_code)||status.notifyUrl!==draft.notify_url||status.returnUrl!==draft.callback_url)throw Error('VPAY_CHECKOUT_UNCONFIRMED');
  const result=await client.read('/platform/vpay/order',{token:orderToken,body:{outTradeNo:draft.out_trade_no,title:draft.title,amount:draft.amount,tradeCode:draft.trade_code,payerName:draft.payer_name,notifyUrl:draft.notify_url,callbackUrl:draft.callback_url}});
  if(result.provider!=='vpay'||result.upstreamStatus!==200)throw Error('VPAY_CHECKOUT_UNCONFIRMED');
  return result.result;
 };
}
