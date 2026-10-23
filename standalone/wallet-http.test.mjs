import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
delete process.env.PORTAL_POSTGRES_URL;delete process.env.PORTAL_TEST_POSTGRES;delete process.env.RENDER;
process.env.NODE_ENV='test';const dir=mkdtempSync(join(tmpdir(),'master7-wallet-http-'));
process.env.PORTAL_DATABASE=join(dir,'wallet.sqlite');process.env.PUBLIC_ORIGIN='https://portal.example.test';
Object.assign(process.env,{PORTAL_VPAY_ORDERS_ENABLED:'true',PORTAL_VPAY_TRADE_CODES:'["2"]',PORTAL_VPAY_ORDER_TOKEN:'synthetic-order-token-at-least-32-bytes',PORTAL_VPAY_RETURN_URL:'https://portal.example.test/payment-return',PORTAL_VPAY_SETTLEMENT_ENABLED:'true',PORTAL_VPAY_TRADER_ID:'123456',PORTAL_VPAY_ENVIRONMENT:'uat',PORTAL_VPAY_CALLBACK_TOKEN:'synthetic-callback-token-at-least-32-bytes',PORTAL_VPAY_QUERY_TOKEN:'synthetic-query-token-at-least-32-bytes'});
const nativeFetch=globalThis.fetch;let expected,order,queryCalls=0,createCalls=0;
globalThis.fetch=(input,options)=>{
 const url=String(input);
 if(url==='https://master7-integration-gateway.onrender.com/platform/vpay/config'){
  assert.equal(options.headers.Authorization,'Bearer '+process.env.PORTAL_VPAY_QUERY_TOKEN);
  return Promise.resolve(Response.json({provider:'vpay',traderId:'123456',mode:'uat',configured:true,paymentReady:true,tradeCodes:['2'],notifyUrl:'https://master7-integration-gateway.onrender.com/callbacks/vpay/payment',returnUrl:process.env.PORTAL_VPAY_RETURN_URL}));
 }
 if(url==='https://master7-integration-gateway.onrender.com/platform/vpay/order'){
  assert.equal(options.headers.Authorization,'Bearer '+process.env.PORTAL_VPAY_ORDER_TOKEN);const draft=JSON.parse(options.body);createCalls++;
  expected={id:draft.outTradeNo,trade_no:'provider_'+draft.outTradeNo};
  assert.equal(draft.amount,'1.25');assert.equal(draft.tradeCode,'2');assert.equal(draft.notifyUrl,'https://master7-integration-gateway.onrender.com/callbacks/vpay/payment');
  return Promise.resolve(Response.json({provider:'vpay',upstreamStatus:200,result:{code:0,data:{trader_id:'123456',out_trade_no:expected.id,trade_no:expected.trade_no,amount:'1.25',pay_url:'https://payment.vpay.club/pay/synthetic',expired_time:'2026-10-23 23:59:59'}}}));
 }
 if(url==='https://master7-integration-gateway.onrender.com/platform/vpay/order-query'){
  assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{outTradeNo:expected.id,tradeNo:expected.trade_no});queryCalls++;
  return Promise.resolve(Response.json({provider:'vpay',upstreamStatus:200,result:{code:0,data:{trader_id:'123456',out_trade_no:expected.id,trade_no:expected.trade_no,amount:'1.25',state:'3'}}}));
 }
 if(!url.startsWith('http://127.0.0.1:'))throw Error('Unexpected external network access in HTTP test');
 return nativeFetch(input,options);
};
const {sql,withStorage}=await import('./runtime.mjs');
const {newSession}=await import('./security.mjs');
const {server}=await import('./server.mjs');
await withStorage(async()=>{
 await sql.prepare('INSERT INTO brands(id,name,created_at) VALUES (?,?,?)').run('alpha','Alpha',new Date().toISOString());
 await sql.prepare('INSERT INTO brands(id,name,created_at) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING').run('main','Main',new Date().toISOString());
 for(const [id,role] of [['member','customer'],['owner','owner']])await sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run(id,id,id+'@example.test','synthetic-hash',role,1,'synthetic-recovery',new Date().toISOString());
 await sql.prepare('INSERT INTO members VALUES (?,?,?)').run('member@example.test','alpha',new Date().toISOString());
});
const memberCookie='portal_session='+await newSession('member'),ownerCookie='portal_session='+await newSession('owner');
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
const call=(path,options={})=>fetch(base+path,{redirect:'manual',...options});
const callback=authorization=>call('/api/v1/payment-callbacks/vpay/payment',{method:'POST',headers:{'Content-Type':'application/json',...(authorization?{Authorization:authorization}:{})},body:JSON.stringify({trader_id:'123456',out_trade_no:order.id,trade_no:expected.trade_no,amount:'1.25',state:'3',sign:'synthetic-signature-verified-by-the-mocked-gateway'})});
try{
 assert.equal((await call('/api/v1/payments/vpay/config')).status,401);
 const config=await (await call('/api/v1/payments/vpay/config',{headers:{Cookie:memberCookie}})).json();assert.equal(config.enabled,true);assert.deepEqual(config.methods,[{code:'2',label:'DuitNow'}]);
 const data={requestKey:'synthetic_http_request',amount:'1.25',currency:'MYR',tradeCode:'2',payerName:'SYNTHETIC MEMBER'};
 const headers={Cookie:memberCookie,Origin:process.env.PUBLIC_ORIGIN,'Content-Type':'application/json','X-Portal-Request':'1'};
 assert.equal((await call('/api/v1/payments/vpay/orders',{method:'POST',headers:{...headers,Origin:'https://attacker.example.test'},body:JSON.stringify(data)})).status,403);
 assert.equal((await call('/api/v1/payments/vpay/orders',{method:'POST',headers:{...headers,'X-Portal-Request':''},body:JSON.stringify(data)})).status,415);
 assert.equal((await call('/api/v1/payments/vpay/orders',{method:'POST',headers:{...headers,Cookie:ownerCookie},body:JSON.stringify(data)})).status,403);
 const created=await call('/api/v1/payments/vpay/orders',{method:'POST',headers,body:JSON.stringify(data)});assert.equal(created.status,200);order=await created.json();assert.equal(order.status,'awaiting_payment');assert.equal(order.payUrl,'https://payment.vpay.club/pay/synthetic');assert.equal(createCalls,1);
 const duplicate=await (await call('/api/v1/payments/vpay/orders',{method:'POST',headers,body:JSON.stringify(data)})).json();assert.equal(duplicate.id,order.id);assert.equal(createCalls,1);
 assert.equal((await call('/payment-return?state=3&amount=1000',{headers:{Cookie:memberCookie}})).status,200);
 assert.equal((await (await call('/api/v1/wallet?environment=uat',{headers:{Cookie:memberCookie}})).json()).balanceMinor,'0');
 assert.equal((await callback()).status,401);
 assert.equal((await callback('Bearer wrong-token')).status,401);
 const response=await callback('Bearer '+process.env.PORTAL_VPAY_CALLBACK_TOKEN);assert.equal(response.status,200);assert.equal(await response.text(),'SUCCESS');
 const wallet=await (await call('/api/v1/wallet?environment=uat',{headers:{Cookie:memberCookie}})).json();assert.equal(wallet.balanceMinor,'125');assert.equal(wallet.tenantId,'alpha');
 const records=await (await call('/api/v1/payment-records?tenant=alpha&environment=uat',{headers:{Cookie:ownerCookie}})).json();assert.equal(records.records[0].id,order.id);assert.equal(records.records[0].member,'member');assert.equal(records.records[0].creditedMinor,'125');
 assert.equal(await (await callback('Bearer '+process.env.PORTAL_VPAY_CALLBACK_TOKEN)).text(),'SUCCESS');assert.equal(queryCalls,1);
 assert.equal((await call('/api/v1/wallet?environment=production',{headers:{Cookie:memberCookie}})).status,200);
 assert.equal((await (await call('/api/v1/wallet?environment=production',{headers:{Cookie:memberCookie}})).json()).balanceMinor,'0');
 assert.equal((await call('/api/v1/wallet?tenant=main&environment=uat',{headers:{Cookie:memberCookie}})).status,403);
 assert.equal((await call('/api/v1/payment-records/export?tenant=alpha&environment=uat',{headers:{Cookie:memberCookie}})).status,403);
 const exported=await call('/api/v1/payment-records/export?tenant=alpha&environment=uat',{headers:{Cookie:ownerCookie}});assert.equal(exported.status,200);const csv=await exported.text();assert(csv.includes(order.id));assert(csv.includes('建单结果'));assert(!csv.includes('https://payment.vpay.club'));
 assert.equal((await call('/api/v1/deposit-requests',{method:'POST',headers:{Cookie:memberCookie,'Content-Type':'application/json'},body:'{}'})).status,403);
 if(process.env.PORTAL_BROWSER_QA==='1'){
  const {createRequire}=await import('node:module');const {chromium}=createRequire(import.meta.url)('playwright');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  try{
   const context=await browser.newContext({viewport:{width:390,height:844}}),errors=[];
   await context.addCookies([{name:'portal_session',value:memberCookie.slice('portal_session='.length),url:'https://portal.example.test',secure:true,httpOnly:true,sameSite:'Lax'}]);
   await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!=='https://portal.example.test')throw Error('Unexpected browser network destination');
    const headers=await request.allHeaders();delete headers.host;delete headers['content-length'];
    const response=await nativeFetch(base+url.pathname+url.search,{method:request.method(),headers,body:request.postDataBuffer()||undefined,redirect:'manual'});
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
   });
   const artifactDir=process.env.PORTAL_BROWSER_ARTIFACTS||dir;
   const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
   await page.goto('https://portal.example.test/');
   await page.getByRole('button',{name:'展开菜单'}).click();await page.getByRole('button',{name:'Deposit',exact:true}).click();
   await page.getByLabel('金额（MYR）',{exact:true}).first().fill('1.25');await page.getByLabel('付款人姓名').fill('SYNTHETIC MEMBER');
   await page.getByRole('button',{name:'建立充值订单',exact:true}).click();
   try{await page.getByRole('link',{name:'前往 VPay 收银台',exact:true}).waitFor({timeout:5000});}catch{throw Error('Synthetic browser checkout failed: '+JSON.stringify({alerts:await page.getByRole('alert').allTextContents(),errors,createCalls}));}
   assert.equal(await page.getByRole('link',{name:'前往 VPay 收银台',exact:true}).getAttribute('href'),'https://payment.vpay.club/pay/synthetic');
   const createdCount=createCalls;await page.reload();await page.getByRole('button',{name:'展开菜单'}).click();await page.getByRole('button',{name:'Deposit',exact:true}).click();
   await page.getByRole('button',{name:'查询原订单',exact:true}).click();await page.getByRole('link',{name:'前往 VPay 收银台',exact:true}).waitFor();assert.equal(createCalls,createdCount);
   await page.locator('.wallet-records').getByLabel(/^环境/).selectOption('uat');await page.locator('.wallet-records').getByText(order.id,{exact:true}).waitFor();
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   assert(await page.locator('.wallet-records .table-wrap').evaluate(element=>element.scrollWidth<=element.clientWidth));
   await page.screenshot({path:join(artifactDir,'vpay-checkout-ui.png'),fullPage:true});assert.deepEqual(errors,[]);
   await context.clearCookies();await context.addCookies([{name:'portal_session',value:ownerCookie.slice('portal_session='.length),url:'https://portal.example.test',secure:true,httpOnly:true,sameSite:'Lax'}]);
   await page.setViewportSize({width:1280,height:900});await page.goto('https://portal.example.test/admin');
   await page.getByLabel('切换品牌').selectOption('alpha');await page.getByRole('button',{name:'Deposit 申请记录',exact:true}).click();
   await page.locator('.wallet-records').getByLabel(/^环境/).selectOption('uat');await page.locator('.wallet-records').getByText(order.id,{exact:true}).waitFor();
   const downloadPromise=page.waitForEvent('download');await page.getByRole('link',{name:'导出期间全部记录（CSV）',exact:true}).click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),'master7-vpay-records.csv');assert.equal(await download.failure(),null);
   await page.screenshot({path:join(artifactDir,'vpay-admin-records-ui.png'),fullPage:true});assert.deepEqual(errors,[]);
   console.log('PASS: mobile Chromium checkout link, refresh recovery without another create, member records, tenant-selected admin records and CSV download. Local mocked upstream only.');
  }finally{await browser.close();}
 }
 console.log('PASS: synthetic local HTTP member checkout → scoped gateway create mock → callback → authenticated query mock → wallet credit → member balance → admin records → CSV; duplicate prevention, scope and CSRF verified. No supplier requests or real funds.');
}finally{await new Promise(resolve=>server.close(resolve));await sql.close();globalThis.fetch=nativeFetch;rmSync(dir,{recursive:true,force:true});}
