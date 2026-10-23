'use client';
import {useEffect,useRef,useState} from 'react';
type RecordRow={id:string;tenantId:string;member:string;provider:'vpay'|'bank_transfer';providerOrderId:string|null;environment:string;currency:string;amountMinor:string;creditedMinor:string;status:string;creationStatus:string;reviewRequired:boolean;reviewCount:number;createdAt:string;verifiedAt:string|null;creditedAt:string|null;reviews:{reason:string;createdAt:string;observedMinor:string|null;observedCurrency:string|null}[]};
type RecordsData={tenantId:string;environment:string;records:RecordRow[];summary:{orders:number;orderedMinor:string;creditedMinor:string;reviewOrders:number};nextCursor:string|null};
const money=(minor:string)=>{if(!/^-?\d+$/.test(minor))return '未知';const n=BigInt(minor),positive=n<0n?-n:n;return(n<0n?'-':'')+(positive/100n).toString()+'.'+(positive%100n).toString().padStart(2,'0');};
const instant=(v:string|null)=>v?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Kuching',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'—';
export default function WalletRecords({tenantId,admin}:{tenantId:string;admin:boolean}){
 const today=new Date().toISOString().slice(0,10);
 const [environment,setEnvironment]=useState('production'),[from,setFrom]=useState(new Date(Date.now()-6*86400000).toISOString().slice(0,10)),[to,setTo]=useState(today),[revision,setRevision]=useState(0),[cursor,setCursor]=useState('');
 const [state,setState]=useState<{query:string;busy:boolean;error:string;data:RecordsData|null;balance:string|null}>({query:'',busy:true,error:'',data:null,balance:null});
 const sequence=useRef(0);
 const params=new URLSearchParams({tenant:tenantId,environment,from,to});if(cursor)params.set('cursor',cursor);
 const query=params.toString();
 useEffect(()=>{
  const current=++sequence.current,controller=new AbortController();
  setState({query,busy:true,error:'',data:null,balance:null});
  const timer=setTimeout(()=>controller.abort(),12000);
  void(async()=>{try{
   const records=await fetch('/api/v1/payment-records?'+query,{cache:'no-store',signal:controller.signal});
   const result=await records.json();
   if(!records.ok)throw Error(result.error||'记录暂时无法读取');
   if(result.tenantId!==tenantId||result.environment!==environment||!Array.isArray(result.records)||result.records.some((r:RecordRow)=>r.tenantId!==tenantId||r.environment!==environment))throw Error('记录归属暂时无法确认');
   let balance=null;
   if(!admin){const r=await fetch('/api/v1/wallet?'+new URLSearchParams({tenant:tenantId,environment}),{cache:'no-store',signal:controller.signal});const d=await r.json();if(!r.ok||d.tenantId!==tenantId||d.environment!==environment)throw Error('余额暂时无法读取');balance=d.balanceMinor;}
   if(current===sequence.current)setState({query,busy:false,error:'',data:result,balance});
  }catch(e){if(current===sequence.current)setState({query,busy:false,error:e instanceof Error?e.message:'读取失败',data:null,balance:null});}finally{clearTimeout(timer);}})();
  return()=>{sequence.current++;controller.abort();clearTimeout(timer);};
 },[tenantId,environment,from,to,revision,cursor,admin]);
 const update=(action:()=>void)=>{setCursor('');action();};
 const data=state.query===query?state.data:null,busy=state.query!==query||state.busy;
 const reasons:Record<string,string>={VPAY_ORDER_CREATION_PENDING:'建单结果待确认',VPAY_AMOUNT_MISMATCH:'金额不符',VPAY_ORDER_MISMATCH:'订单号不符',VPAY_MERCHANT_MISMATCH:'商户不符',VPAY_CURRENCY_MISMATCH:'币种不符',VPAY_VERIFICATION_PENDING:'等待付款核验',VPAY_QUERY_NOT_PAID:'查询尚未确认付款',VPAY_NONPAID_NOTIFICATION:'收到非成功状态通知',VPAY_MEMBERSHIP_CHANGED:'会员归属变化',VPAY_SETTLEMENT_RETRY:'入账失败，等待重试'};
 return <section className="panel wallet-records" aria-labelledby="wallet-records-title" aria-busy={busy}>
  <div className="panel-heading"><h2 id="wallet-records-title">{admin?'充值入账与对账记录':'钱包与充值记录'}</h2><button type="button" className="secondary" disabled={busy} onClick={()=>setRevision(r=>r+1)}>刷新记录</button></div>
  <div className="settings-form"><div className="wallet-filters">
   <label>环境<select value={environment} onChange={e=>update(()=>setEnvironment(e.target.value))}><option value="production">正式记录</option><option value="uat">UAT 测试记录</option></select></label>
   <label>开始日期（UTC）<input type="date" value={from} max={to} onChange={e=>update(()=>setFrom(e.target.value))}/></label>
   <label>结束日期（UTC）<input type="date" value={to} min={from} max={today} onChange={e=>update(()=>setTo(e.target.value))}/></label>
  </div>
  {environment==='uat'&&<p role="status">以下为隔离测试记录，测试余额不可作为正式余额使用。</p>}
  <p className="settings-help">付款核验成功、钱包入账及后台记录使用同一平台订单号。以下合计来自平台订单与账本，不代表银行结算对账已完成。</p>
  {state.query===query&&state.error&&<p className="form-error" role="alert">{state.error}</p>}
  {busy&&<p role="status">正在读取余额和记录…</p>}
  {data&&<><div className="wallet-summary">
   {!admin&&state.balance!==null&&<div><span>{environment==='uat'?'测试充值余额':'已核验充值余额'}</span><strong>{money(state.balance)} MYR</strong></div>}
   <div><span>期间订单数</span><strong>{data.summary.orders}</strong></div><div><span>期间充值申请</span><strong>{money(data.summary.orderedMinor)} MYR</strong></div><div><span>期间已入账</span><strong>{money(data.summary.creditedMinor)} MYR</strong></div><div><span>需要复核</span><strong>{data.summary.reviewOrders}</strong></div>
  </div>{admin&&<a className="secondary" href={'/api/v1/payment-records/export?'+new URLSearchParams({tenant:tenantId,environment,from,to})}>导出期间全部记录（CSV）</a>}</>}
  </div>
  {data&&<><div className="table-wrap"><table><thead><tr>{admin&&<th>会员</th>}<th>充值通道 / 平台订单 / 核对编号</th><th>充值 / 入账（MYR）</th><th>状态 / 核对记录</th><th>核验 / 入账时间（MYT）</th></tr></thead><tbody>{data.records.map(r=><tr key={r.id}>{admin&&<td data-label="会员">{r.member}</td>}<td data-label="充值通道 / 平台订单 / 核对编号"><b>{r.provider==='bank_transfer'?'银行转账':'VPay'}</b><br/><code>{r.id}</code><br/><small>{r.providerOrderId||(r.provider==='bank_transfer'?'银行核对编号待确认':'待供应商确认')}</small></td><td data-label="充值 / 入账（MYR）">{money(r.amountMinor)} / {money(r.creditedMinor)}</td><td data-label="状态 / 核对记录">{r.status==='credited'?'已入账':r.status==='pending'?'等待付款核验':r.creationStatus==='in_flight'?'正在建单':r.creationStatus==='unknown'?'建单结果待确认':'等待建单'}{r.reviewRequired&&<><br/><strong>需要复核（{r.reviewCount}）</strong></>}{r.reviews?.length>0&&<details><summary>查看处理记录</summary>{r.reviews.map((review,index)=><p key={index}>{reasons[review.reason]||'字段校验未通过'}{review.observedMinor!==null?' · 收到金额 '+money(review.observedMinor)+' '+(review.observedCurrency||'MYR'):''}<small>{instant(review.createdAt)}</small></p>)}</details>}</td><td data-label="核验 / 入账时间（MYT）">{instant(r.verifiedAt)}<br/>{instant(r.creditedAt)}</td></tr>)}</tbody></table></div>{!data.records.length&&<div className="empty"><p>所选期间暂无充值订单。</p></div>}<div className="wallet-pagination">{cursor&&<button className="secondary" onClick={()=>setCursor('')}>返回首批记录</button>}{data.nextCursor&&<button className="secondary" onClick={()=>setCursor(data.nextCursor!)}>下一批记录</button>}</div></>}
 </section>;
}
