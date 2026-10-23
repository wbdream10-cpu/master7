'use client';
import {useEffect,useRef,useState} from 'react';
type Configuration={enabled:boolean;subject:string;environment:string|null;methods:{code:string;label:string}[]};
type Intent={requestKey:string;amount:string;currency:'MYR';tradeCode:string;payerName:string};
type Result={id:string;status:'awaiting_payment'|'awaiting_confirmation'|'review_required'|'credited';payUrl:string|null};
const paymentLink=(value:unknown)=>{try{if(typeof value!=='string'||value.includes('#'))return null;const url=new URL(value);return url.origin==='https://payment.vpay.club'&&!url.username&&!url.password&&!url.hash?url.href:null;}catch{return null;}};
export default function VPayCheckout(){
 const [config,setConfig]=useState<Configuration|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [amount,setAmount]=useState(''),[payerName,setPayerName]=useState(''),[method,setMethod]=useState(''),[intent,setIntent]=useState<Intent|null>(null),[result,setResult]=useState<Result|null>(null);
 const alive=useRef(false),request=useRef<AbortController|null>(null),sending=useRef(false);
 const storageKey=config?'master7:vpay-intent:'+encodeURIComponent(JSON.stringify([config.subject,config.environment])):'';
 useEffect(()=>{
  alive.current=true;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
  void(async()=>{try{
   const response=await fetch('/api/v1/payments/vpay/config',{cache:'no-store',signal:controller.signal});const data=await response.json();
   if(!response.ok||typeof data.enabled!=='boolean'||typeof data.subject!=='string'||!Array.isArray(data.methods))throw Error('充值方式暂时无法读取，请稍后重试。');
   const key='master7:vpay-intent:'+encodeURIComponent(JSON.stringify([data.subject,data.environment])),saved=sessionStorage.getItem(key);
   let restored:Intent|null=null;
   if(saved){restored=JSON.parse(saved);if(!restored||typeof restored.requestKey!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(restored.requestKey)||typeof restored.amount!=='string'||typeof restored.payerName!=='string'||typeof restored.tradeCode!=='string'||restored.currency!=='MYR')throw Error('请联系客服核对上一笔充值订单。');}
   if(alive.current){setConfig(data);setMethod(restored?.tradeCode||data.methods[0]?.code||'');if(restored){setIntent(restored);setAmount(restored.amount);setPayerName(restored.payerName);}}
  }catch(e){if(alive.current)setError(e instanceof Error?e.message:'充值方式暂时无法读取。');}finally{clearTimeout(timer);}})();
  return()=>{alive.current=false;controller.abort();request.current?.abort();clearTimeout(timer);};
 },[]);
 async function submit(event:React.FormEvent<HTMLFormElement>){
  event.preventDefault();if(!config?.enabled||sending.current)return;
  const data:Intent=intent||{requestKey:crypto.randomUUID(),amount,currency:'MYR',tradeCode:method,payerName};
  try{sessionStorage.setItem(storageKey,JSON.stringify(data));}catch{setError('浏览器无法保留订单，请稍后重试。');return;}
  setIntent(data);setBusy(true);sending.current=true;setError('');
  const controller=new AbortController();request.current=controller;const timer=setTimeout(()=>controller.abort(),20000);
  try{
   const response=await fetch('/api/v1/payments/vpay/orders',{method:'POST',headers:{'Content-Type':'application/json','X-Portal-Request':'1'},body:JSON.stringify(data),signal:controller.signal});
   const body=await response.json();
   if(response.status===400){sessionStorage.removeItem(storageKey);if(alive.current)setIntent(null);throw Error('请检查充值金额、方式及付款人姓名。');}
   if(!response.ok)throw Error('暂时无法确认订单，请保留此页，稍后查询原订单。');
   if(typeof body.id!=='string'||!['awaiting_payment','awaiting_confirmation','review_required','credited'].includes(body.status)||(body.payUrl!==null&&!paymentLink(body.payUrl)))throw Error('订单结果暂时无法确认，请查询原订单。');
   if(alive.current)setResult({...body,payUrl:paymentLink(body.payUrl)});
  }catch(e){if(alive.current)setError(e instanceof Error&&e.name!=='AbortError'?e.message:'订单仍在确认中，请稍后查询原订单。');}finally{clearTimeout(timer);sending.current=false;if(alive.current)setBusy(false);}
 }
 function next(){sessionStorage.removeItem(storageKey);setIntent(null);setResult(null);setAmount('');setPayerName('');setError('');}
 return <section className="panel" aria-labelledby="vpay-checkout-title" aria-busy={busy}>
  <div className="panel-heading"><h2 id="vpay-checkout-title">VPay 充值</h2></div><div className="settings-form">
  {error&&<p className="form-error" role="alert">{error}</p>}
  {!config&&!error&&<p role="status">正在读取充值方式…</p>}
  {config&&!config.enabled&&<p>VPay 充值尚未开放。</p>}
  {config?.enabled&&<>
   {config.environment==='uat'&&<p role="status">当前为 UAT 测试环境，余额与正式账户分开。</p>}
   <p className="settings-help">在 VPay 收银台完成付款后，平台核验结果并更新钱包与充值记录。</p>
   {result&&<div role="status"><p>平台订单：<code>{result.id}</code></p><p>{result.status==='credited'?'已核验并入账，请刷新下方钱包与充值记录。':result.status==='awaiting_payment'?'订单已建立，请前往收银台完成付款。':result.status==='review_required'?'订单需要复核，请联系客服并提供平台订单号。':'订单仍在确认中，请稍后查询原订单。'}</p>{result.payUrl&&<a className="primary" href={result.payUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">前往 VPay 收银台</a>}</div>}
   {result?.status==='credited'?<button type="button" className="secondary" onClick={next}>新的充值</button>:<form onSubmit={submit}>
    <label>充值方式<select required disabled={busy||!!intent} value={method} onChange={event=>setMethod(event.target.value)}>{config.methods.map(item=><option key={item.code} value={item.code}>{item.label}</option>)}</select></label>
    <label>金额（MYR）<input required disabled={busy||!!intent} type="text" inputMode="decimal" maxLength={9} pattern="(0|[1-9][0-9]{0,5})([.][0-9]{1,2})?" value={amount} onChange={event=>setAmount(event.target.value)} placeholder="0.00"/></label>
    <label>付款人姓名<input required disabled={busy||!!intent} maxLength={30} autoComplete="name" value={payerName} onChange={event=>setPayerName(event.target.value)}/></label>
    <button type="submit" className="primary" disabled={busy||!method}>{busy?'正在确认订单…':intent?'查询原订单':'建立充值订单'}</button>
   </form>}
  </>}
  </div>
 </section>;
}
