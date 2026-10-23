// Server-only, read-only verification. Neither endpoint creates an order.
const gateway = 'https://master7-integration-gateway.onrender.com';
export function createVPayOrderVerifier({token, environment, fetchImpl=globalThis.fetch}) {
 return async order => {
  if(typeof token!=='string'||Buffer.byteLength(token)<32||!['uat','production'].includes(environment))throw Error('VPAY_QUERY_UNAVAILABLE');
  async function read(path,options={}){
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
   try{
    const response=await fetchImpl(gateway+path,{...options,redirect:'error',signal:controller.signal,headers:{Accept:'application/json',...options.headers}});
    if(!response.ok||response.redirected)throw Error('VPAY_QUERY_UNAVAILABLE');
    let size=0;const chunks=[];
    if(response.body)for await(const chunk of response.body){size+=chunk.length;if(size>65536)throw Error('VPAY_QUERY_UNAVAILABLE');chunks.push(Buffer.from(chunk));}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('VPAY_QUERY_UNAVAILABLE');}
   }finally{clearTimeout(timer);}
  }
  const status=await read('/providers/vpay/status');
  if(status.provider!=='vpay'||status.configured!==true||status.mode!==environment)throw Error('VPAY_ENVIRONMENT_UNCONFIRMED');
  const result=await read('/platform/vpay/order-query',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({outTradeNo:order.id,tradeNo:order.trade_no})});
  if(result.provider!=='vpay'||result.upstreamStatus!==200)throw Error('VPAY_QUERY_UNAVAILABLE');
  return result.result;
 };
}
