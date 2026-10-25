import {origin,allowedOrigins} from './server-config.mjs';
import {createServer} from 'node:http';
import {publicHomeBody} from './public-home.mjs';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {identity,sql,withStorage} from './runtime.mjs';
import {digest,secret,passwordValid,hashPassword,verifyPassword,limited,sessionUser,newSession} from './security.mjs';
import * as api from './dist/api.mjs';
import {listConnections,configureConnection,receiveEvent,listEvents} from './connections.mjs';
import {getDepositRequests,createDepositRequest} from './deposit.mjs';
import {createPaymentChannelsHandler} from './payment-channels.mjs';
import {createGSPayRuntime} from './gspay-runtime.mjs';
import {createVPaySettlement,startVPayRecovery,getWallet,getPaymentRecords} from './wallet.mjs';
import {createVPayCheckout} from './vpay-checkout.mjs';
import {createSponsoredGamesHandler} from './sponsored-games.mjs';
import {BankReceiptUploadError,createBankDeposits,readBankReceiptBody} from './bank-deposits.mjs';
import {createWithdrawals} from './withdrawals.mjs';
import {createFinanceReconciliation} from './finance-reconciliation.mjs';
const originAllowed=value=>typeof value==='string'&&allowedOrigins.has(value);
const serviceOnlyMode=()=>process.env.NODE_ENV!=='test'&&Boolean(process.env.RENDER_EXTERNAL_URL);
const serviceOnlySensitivePath=path=>[
 '/api/v1/deposit-requests',
 '/api/v1/bank-transfer/config',
 '/api/v1/bank-deposits',
 '/api/v1/finance-staff',
 '/api/v1/finance-metrics',
 '/api/v1/withdrawals/config',
 '/api/v1/withdrawals',
 '/api/v1/withdrawals/export',
 '/api/v1/finance-reconciliation',
 '/api/v1/finance-reconciliation/export',
 '/api/v1/sponsored-games',
 '/api/v1/payment-channels',
 '/api/v1/wallet',
 '/api/v1/payment-records',
 '/api/v1/payment-records/export',
 '/api/v1/payments/gspay/config',
 '/api/v1/payments/vpay/config',
 '/api/v1/payments/vpay/orders',
 '/api/v1/payment-callbacks/vpay/payment',
].includes(path)
 || path.startsWith('/api/v1/bank-deposits/')
 || path.startsWith('/api/v1/withdrawals/')
 || path.startsWith('/api/v1/payment-callbacks/gspay/');

const cookieFlags='; Path=/; HttpOnly; SameSite=Lax'+(origin.protocol==='https:'?'; Secure':'');
const dummyHash=await hashPassword('unknown-account-password-never-used');
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function page(title,body,status=200){return new Response(`<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#050b1b"><title>${escape(title)} · MASTER7</title><link rel="stylesheet" href="/assets/portal.css"><style>
:root{color-scheme:dark;--m7-bg:#040816;--m7-panel:rgba(7,18,43,.92);--m7-line:rgba(58,129,226,.3);--m7-blue:#0878df;--m7-gold:#e9bd63;--m7-text:#f6f9ff;--m7-muted:#9cabc7}*{box-sizing:border-box}html{min-height:100%;background:var(--m7-bg)}body{min-height:100vh;margin:0;color:var(--m7-text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:radial-gradient(circle at 20% 12%,rgba(0,88,204,.22),transparent 33%),radial-gradient(circle at 85% 8%,rgba(229,180,80,.12),transparent 28%),linear-gradient(145deg,#02040d 0%,#07152e 58%,#030713 100%);background-attachment:fixed}a{color:#73b9fa;text-decoration:none}a:hover{text-decoration:underline}h1,h2,p{margin-top:0}.auth-shell{min-height:100vh;display:grid;place-items:center;padding:42px 18px;position:relative;isolation:isolate}.auth-shell:before{content:"";position:fixed;inset:0;background:linear-gradient(90deg,rgba(2,6,17,.95),rgba(2,7,20,.74)),url('/brand/master7-logo.jpg') center/cover no-repeat;opacity:.54;z-index:-1}.auth-card{width:min(100%,480px);background:linear-gradient(155deg,rgba(12,28,62,.96),rgba(5,12,29,.97));border:1px solid var(--m7-line);border-radius:24px;padding:34px;box-shadow:0 32px 90px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.07);position:relative;overflow:hidden}.auth-card:before{content:"";position:absolute;left:0;right:0;top:0;height:3px;background:linear-gradient(90deg,transparent,var(--m7-blue),var(--m7-gold),transparent)}.auth-card h1{font-size:clamp(26px,6vw,34px);letter-spacing:-.025em;margin-bottom:12px}.auth-card form{margin:24px 0}.auth-card label,.settings-form label{display:block;color:#c6d2e8;font-size:13px;font-weight:650;margin:16px 0}.auth-card input,.settings-form input,.settings-form select{display:block;width:100%;margin-top:8px;padding:13px 14px;color:var(--m7-text);background:rgba(1,7,20,.78);border:1px solid rgba(80,142,222,.34);border-radius:11px;font:inherit;outline:none}.auth-card input:focus,.settings-form input:focus,.settings-form select:focus{border-color:var(--m7-blue);box-shadow:0 0 0 3px rgba(8,120,223,.18)}.auth-card p,.account-row p,.page-heading p{color:var(--m7-muted);font-size:13px;line-height:1.75;margin-bottom:16px}.eyebrow{color:var(--m7-gold)!important;font-size:11px!important;font-weight:800;letter-spacing:.18em;text-transform:uppercase}.auth-brand-logo{width:88px;height:88px;margin-bottom:18px}.auth-brand-logo img{width:100%;height:100%;object-fit:contain;filter:drop-shadow(0 10px 24px rgba(0,91,210,.32))}.primary,.secondary,button{border:0;border-radius:11px;padding:12px 18px;font:inherit;font-weight:760;cursor:pointer}.primary{display:inline-flex;align-items:center;justify-content:center;color:#f8fbff!important;background:linear-gradient(115deg,#148fd5,#075acb 62%,#d3a74f);box-shadow:0 10px 28px rgba(5,81,190,.34)}.secondary{display:inline-flex;align-items:center;justify-content:center;color:#e8f4ff!important;background:rgba(12,44,91,.84);border:1px solid rgba(63,137,229,.34)}.full{width:100%}.auth-links{display:flex;gap:20px;align-items:center;justify-content:center;flex-wrap:wrap;padding-top:4px;font-size:13px}.recovery{display:block;padding:17px;color:#d9ebff;background:rgba(5,36,81,.78);border:1px solid rgba(42,120,217,.4);border-radius:12px;overflow-wrap:anywhere;user-select:all;font-size:14px;line-height:1.7}[role=alert]{padding:11px 13px;color:#ffe5a3!important;background:rgba(116,73,4,.28);border:1px solid rgba(238,186,73,.34);border-radius:10px}.accounts{width:min(1120px,calc(100% - 28px));margin:0 auto;padding:30px 0 60px}.server-brandbar{display:flex;align-items:center;gap:13px;margin-bottom:24px;color:#eef6ff}.server-brandbar img{width:48px;height:48px;object-fit:contain}.server-brandbar strong{display:block;font-size:17px;letter-spacing:.08em}.server-brandbar span{display:block;color:var(--m7-muted);font-size:11px;letter-spacing:.12em}.page-heading{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;padding:25px 26px;background:linear-gradient(130deg,rgba(9,34,79,.97),rgba(7,19,44,.92));border:1px solid var(--m7-line);border-radius:20px;box-shadow:0 20px 54px rgba(0,0,0,.24)}.page-heading h1{font-size:clamp(24px,5vw,34px);margin-bottom:0}.account-row{padding:22px 24px;background:var(--m7-panel);border:1px solid var(--m7-line);border-radius:16px;margin-top:15px;box-shadow:0 12px 32px rgba(0,0,0,.18)}.account-row>.account-row{background:rgba(4,13,31,.72)}.account-row b{font-size:16px}.account-row form{display:inline-block;margin:10px 14px 0 0}.account-row .settings-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:0 14px;align-items:end;width:100%}.settings-form p{grid-column:1/-1}.settings-form input[type=checkbox]{display:inline-block;width:auto;margin:0 7px 0 0}.account-row code{display:block;padding:10px 12px;color:#a9d5ff;background:rgba(2,9,22,.72);border-radius:8px;overflow-wrap:anywhere}@media(max-width:650px){.auth-card{padding:27px 22px;border-radius:20px}.page-heading{display:block;padding:22px}.page-heading .secondary{margin-top:18px}.account-row{padding:19px}.account-row form{display:block;margin-right:0}.account-row button{width:100%}.accounts{padding-top:18px}}
</style></head><body>${body}</body></html>`,{status,headers:{'content-type':'text/html; charset=utf-8'}})}
function authPage(kind,message='',status=200){const register=kind==='register',reset=kind==='reset';const title=register?'创建会员账号':reset?'找回账号密码':'登录 MASTER7';return page(title,`<div class="auth-shell"><main class="auth-card"><div class="brandmark auth-brand-logo"><img src="/brand/master7-logo.jpg" alt="MASTER7 — SEVEN Premium Experience" width="128" height="128"></div><p class="eyebrow">MASTER7 · MEMBER PLATFORM</p><h1>${title}</h1><p>${register?'注册后由平台管理员核实并批准，即可进入新版会员中心。':reset?'使用注册或开户时保存的恢复码重设密码。':'使用 MASTER7 账号与密码进入会员平台或运营后台。'}</p>${message?'<p role="alert">'+escape(message)+'</p>':''}<form method="post" action="/auth/${register?'register':reset?'reset':'login'}"><label>账号<input name="username" required pattern="[a-zA-Z0-9_-]{3,40}" minlength="3" maxlength="40" autocomplete="username"></label>${register?'<label>联系邮箱<input name="email" required type="email" maxlength="254" autocomplete="email"></label>':''}${reset?'<label>账号恢复码<input name="recovery" required maxlength="100" autocomplete="off"></label>':''}<label>${reset?'新密码':'密码'}<input type="password" name="password" required minlength="12" maxlength="256" autocomplete="${register||reset?'new-password':'current-password'}"></label>${register||reset?'<p>密码至少 12 个字符；不要重复使用其他网站的密码。</p>':''}<button class="primary full">${title}</button></form><nav class="auth-links"><a href="/signin">登录</a><a href="/register">注册</a><a href="/reset">找回密码</a></nav></main></div>`,status)}
function recoveryPage(code,reset=false){return page('保存账号恢复码',`<div class="auth-shell"><main class="auth-card"><div class="brandmark auth-brand-logo"><img src="/brand/master7-logo.jpg" alt="MASTER7 — SEVEN Premium Experience" width="128" height="128"></div><p class="eyebrow">MASTER7 · ACCOUNT SECURITY</p><h1>${reset?'密码已重设':'注册已提交'}</h1><p>请离线保存以下恢复码。它只显示这一次，持有者可以重设你的密码。不要发送给客服或其他人。</p><code class="recovery">${escape(code)}</code><p>${reset?'旧恢复码和所有旧登录会话已失效。下次请使用此新恢复码。':'账号还需平台管理员核实并批准，恢复码不会再次显示。'}</p><a class="primary" href="/signin">返回登录</a></main></div>`)}
function ownerBootstrapConfig(){
 if(process.env.PORTAL_OWNER_BOOTSTRAP_ENABLED!=='true')return null;
 const username=String(process.env.PORTAL_OWNER_BOOTSTRAP_USERNAME||'').trim().toLowerCase();
 const email=String(process.env.PORTAL_OWNER_BOOTSTRAP_EMAIL||'').trim().toLowerCase();
 const tokenHash=String(process.env.PORTAL_OWNER_BOOTSTRAP_TOKEN_SHA256||'').trim().toLowerCase();
 const expiresAt=Date.parse(String(process.env.PORTAL_OWNER_BOOTSTRAP_EXPIRES_AT||''));
 if(!/^[a-z0-9_-]{3,40}$/.test(username)||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!/^[a-f0-9]{64}$/.test(tokenHash)||!Number.isFinite(expiresAt))return null;
 return {username,email,tokenHash,expiresAt};
}
function bootstrapTokenValid(token,expected){
 if(typeof token!=='string'||Buffer.byteLength(token)<32||Buffer.byteLength(token)>256||!/^[a-f0-9]{64}$/.test(expected))return false;
 return timingSafeEqual(Buffer.from(digest(token),'hex'),Buffer.from(expected,'hex'));
}
function maskedEmail(email){const [local,domain]=email.split('@');return escape((local.slice(0,2)||'*')+'•••@'+domain)}
function ownerSetupPage(config,message='',status=200){return page('建立总部管理员',`<div class="auth-shell"><main class="auth-card"><div class="brandmark auth-brand-logo"><img src="/brand/master7-logo.jpg" alt="MASTER7 — SEVEN Premium Experience" width="128" height="128"></div><p class="eyebrow">MASTER7 · SECURE OWNER SETUP</p><h1>建立总部管理员</h1><p>这是新版运营后台的一次性安全开户页面。开户后入口会永久关闭。</p>${message?'<p role="alert">'+escape(message)+'</p>':''}<p>账号：<b>${escape(config.username)}</b><br>邮箱：<b>${maskedEmail(config.email)}</b></p><form method="post" action="/owner-setup"><label>一次性开户码<input type="password" name="bootstrapToken" required minlength="32" maxlength="256" autocomplete="off"></label><label>新密码<input type="password" name="password" required minlength="12" maxlength="256" autocomplete="new-password"></label><label>确认新密码<input type="password" name="confirmPassword" required minlength="12" maxlength="256" autocomplete="new-password"></label><p>密码至少 12 个字符；不要使用银行、邮箱或其他网站的密码。</p><button class="primary full">安全建立总部账号</button></form><nav class="auth-links"><a href="/signin">返回登录</a></nav></main></div>`,status)}
function ownerSetupClosed(message='总部管理员已建立，请直接登录。',status=410){return page('总部管理员开户已关闭',`<div class="auth-shell"><main class="auth-card"><div class="brandmark auth-brand-logo"><img src="/brand/master7-logo.jpg" alt="MASTER7 — SEVEN Premium Experience" width="128" height="128"></div><p class="eyebrow">MASTER7 · OWNER SETUP</p><h1>一次性开户已关闭</h1><p>${escape(message)}</p><a class="primary" href="/signin">前往登录</a></main></div>`,status)}
function ownerRecoveryPage(code){return page('保存总部账号恢复码',`<div class="auth-shell"><main class="auth-card"><div class="brandmark auth-brand-logo"><img src="/brand/master7-logo.jpg" alt="MASTER7 — SEVEN Premium Experience" width="128" height="128"></div><p class="eyebrow">MASTER7 · OWNER SECURITY</p><h1>总部管理员已建立</h1><p>请立即离线保存以下恢复码。它只显示这一次；不要发送给客服或其他人。</p><code class="recovery">${escape(code)}</code><p>关闭此页面后恢复码不会再次显示。请使用刚才设置的密码登录后台。</p><a class="primary" href="/signin">登录总部后台</a></main></div>`)}
const redirect=(path,cookie)=>new Response(null,{status:303,headers:{location:path,...(cookie?{'set-cookie':cookie}:{})}});
const json=(data,status=200)=>Response.json(data,{status});
const getPaymentChannels=createPaymentChannelsHandler({
 getMemberTenant:email=>withStorage(async()=>{const member=await sql.prepare('SELECT tenant_id FROM members WHERE email=?').get(email);return member?.tenant_id||null;}),
 tenantExists:id=>withStorage(async()=>Boolean(await sql.prepare('SELECT id FROM brands WHERE id=?').get(id))),
});
const gspayRuntime=createGSPayRuntime({
 getMemberTenant:email=>withStorage(async()=>{const member=await sql.prepare('SELECT tenant_id FROM members WHERE email=?').get(email);return member?.tenant_id||null;}),
 tenantExists:id=>withStorage(async()=>Boolean(await sql.prepare('SELECT id FROM brands WHERE id=?').get(id))),
});
const gspayCallbackPaths=new Map([
 ['/api/v1/payment-callbacks/gspay/payment','payment'],
 ['/api/v1/payment-callbacks/gspay/duitnow','duitnow'],
]);
const unavailableGspayPublicPaths=new Set([
 '/api/payment/gspay/callback',
 '/api/payment/gspay/duitnow/callback',
 '/api/payment/gspay/payout/callback',
 '/api/v1/payments/gspay/orders',
 '/api/v1/payment-callbacks/gspay/payout',
 '/api/v1/payment-callbacks/gspay/usdt',
]);
const vpaySettlement=createVPaySettlement();
startVPayRecovery(vpaySettlement);
const vpayCheckout=createVPayCheckout({settlement:vpaySettlement});
const sponsoredGames=createSponsoredGamesHandler({
 getMemberTenant:email=>withStorage(async()=>{const member=await sql.prepare('SELECT tenant_id FROM members WHERE email=?').get(email);return member?.tenant_id||null;}),
 tenantExists:id=>withStorage(async()=>Boolean(await sql.prepare('SELECT id FROM brands WHERE id=?').get(id))),
});
const bankDeposits=createBankDeposits();
const withdrawals=createWithdrawals();
const financeReconciliation=createFinanceReconciliation();
async function dispatch(req){
 const url=new URL(req.url,origin);
 if(serviceOnlyMode()&&serviceOnlySensitivePath(url.pathname))return json({error:'SERVICE_ONLY_MODE',message:'This deployment is limited to membership, support, branding and access-management features.'},410);
 if(unavailableGspayPublicPaths.has(url.pathname))return json({error:'Not found'},404);
 const gspayChannel=gspayCallbackPaths.get(url.pathname);
 if(gspayChannel){
  if(req.method!=='POST')return json({error:'Method not allowed'},405);
  return gspayRuntime.receive({authorization:req.headers.authorization,contentType:req.headers['content-type'],channel:gspayChannel,readBody:()=>bodyOf(req)});
 }
 if(url.pathname==='/api/v1/payments/gspay/config'){
  if(req.method!=='GET')return json({error:'Method not allowed'},405);
  const user=await withStorage(()=>sessionUser(req.headers.cookie));
  return gspayRuntime.status(user,url.searchParams.get('tenant'));
 }
 const bankReceipt=url.pathname.match(/^\/api\/v1\/bank-deposits\/([^/]+)\/receipt$/);
 const bankReview=url.pathname.match(/^\/api\/v1\/bank-deposits\/([^/]+)\/review$/);
 if(url.pathname==='/api/v1/bank-transfer/config'||url.pathname==='/api/v1/bank-deposits'||url.pathname==='/api/v1/finance-staff'||url.pathname==='/api/v1/finance-metrics'||bankReceipt||bankReview){
  const user=await withStorage(()=>sessionUser(req.headers.cookie)),tenant=url.searchParams.get('tenant');
  if(url.pathname==='/api/v1/finance-metrics')return req.method==='GET'?bankDeposits.getTodayMetrics(user,tenant):json({error:'Method not allowed'},405);
  if(bankReceipt){
   const id=bankReceipt[1];
   if(req.method==='GET')return bankDeposits.readReceipt(user,tenant,id);
   if(req.method!=='PUT')return json({error:'Method not allowed'},405);
   if(!user)return json({error:'请先登录'},401);
   if(!originAllowed(req.headers.origin))return json({error:'请求来源不受信任'},403);
   if(req.headers['x-portal-request']!=='1')return json({error:'请求格式错误'},415);
   if(!['image/jpeg','image/png','image/webp'].includes(String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase()))return json({error:'银行单据只接受 JPEG、PNG 或 WebP 图片'},415);
   try{return bankDeposits.uploadReceipt(user,tenant,id,await readBankReceiptBody(req),req.headers['content-type']);}
   catch(error){
    if(error instanceof BankReceiptUploadError)return json({error:error.code==='BANK_RECEIPT_TOO_LARGE'?'银行单据不得超过 2 MiB':'银行单据不能为空'},error.status);
    throw error;
   }
  }
  if(req.method==='GET'){
   if(bankReview)return json({error:'Method not allowed'},405);
   if(url.pathname==='/api/v1/bank-transfer/config')return bankDeposits.getConfiguration(user,tenant);
   if(url.pathname==='/api/v1/bank-deposits')return bankDeposits.list(user,tenant,url.searchParams);
   if(url.pathname==='/api/v1/finance-staff')return bankDeposits.listFinanceStaff(user,tenant);
  }
  if(req.method!=='POST')return json({error:'Method not allowed'},405);
  if(!user)return json({error:'请先登录'},401);
  if(!originAllowed(req.headers.origin))return json({error:'请求来源不受信任'},403);
  if(req.headers['x-portal-request']!=='1'||!String(req.headers['content-type']).startsWith('application/json'))return json({error:'请求格式错误'},415);
  let data;try{data=JSON.parse((await bodyOf(req)).toString('utf8'));}catch{return json({error:'请求格式错误'},400);}
  if(!data||typeof data!=='object'||Array.isArray(data))return json({error:'请求格式错误'},400);
  if(bankReview)return bankDeposits.review(user,tenant,bankReview[1],data);
  if(url.pathname==='/api/v1/bank-transfer/config')return bankDeposits.saveConfiguration(user,tenant,data);
  if(url.pathname==='/api/v1/bank-deposits')return bankDeposits.submit(user,tenant,data);
  if(url.pathname==='/api/v1/finance-staff')return bankDeposits.setFinanceAccess(user,tenant,data);
  return json({error:'Not found'},404);
 }
 const withdrawalReview=url.pathname.match(/^\/api\/v1\/withdrawals\/([^/]+)\/review$/);
 if(['/api/v1/withdrawals/config','/api/v1/withdrawals','/api/v1/withdrawals/export'].includes(url.pathname)||withdrawalReview){
  const user=await withStorage(()=>sessionUser(req.headers.cookie)),tenant=url.searchParams.get('tenant');
  if(req.method==='GET'){
   if(withdrawalReview)return json({error:'Method not allowed'},405);
   if(url.pathname==='/api/v1/withdrawals/config')return withdrawals.configuration(user,tenant);
   if(url.pathname==='/api/v1/withdrawals/export')return withdrawals.exportRecords(user,tenant,url.searchParams);
   return withdrawals.list(user,tenant,url.searchParams);
  }
  if(req.method!=='POST'||url.pathname.endsWith('/config')||url.pathname.endsWith('/export'))return json({error:'Method not allowed'},405);
  if(!user)return json({error:'请先登录'},401);
  if(!originAllowed(req.headers.origin))return json({error:'请求来源不受信任'},403);
  if(req.headers['x-portal-request']!=='1'||!String(req.headers['content-type']).startsWith('application/json'))return json({error:'请求格式错误'},415);
  let data;try{data=JSON.parse((await bodyOf(req)).toString('utf8'));}catch{return json({error:'请求格式错误'},400);}
  if(!data||typeof data!=='object'||Array.isArray(data))return json({error:'请求格式错误'},400);
  return withdrawalReview?withdrawals.review(user,tenant,withdrawalReview[1],data):withdrawals.submit(user,tenant,data);
 }
 if(['/api/v1/finance-reconciliation','/api/v1/finance-reconciliation/export'].includes(url.pathname)){
  if(req.method!=='GET')return json({error:'Method not allowed'},405);
  const user=await withStorage(()=>sessionUser(req.headers.cookie));
  return url.pathname.endsWith('/export')?financeReconciliation.exportRecords(user,url.searchParams):financeReconciliation.getSummary(user,url.searchParams);
 }
 if(url.pathname==='/api/v1/sponsored-games'){
  if(req.method!=='GET')return json({error:'Method not allowed'},405);
  const user=await withStorage(()=>sessionUser(req.headers.cookie));
  return sponsoredGames(user,url.searchParams);
 }
 if(['/api/v1/payments/vpay/config','/api/v1/payments/vpay/orders'].includes(url.pathname)){
  const user=await withStorage(()=>sessionUser(req.headers.cookie));
  if(url.pathname.endsWith('/config'))return req.method==='GET'?vpayCheckout.publicStatus(user):json({error:'Method not allowed'},405);
  if(req.method!=='POST')return json({error:'Method not allowed'},405);
  if(!user)return json({error:'请先登录'},401);
  if(!originAllowed(req.headers.origin))return json({error:'请求来源不受信任'},403);
  if(req.headers['x-portal-request']!=='1'||!String(req.headers['content-type']).startsWith('application/json'))return json({error:'请求格式错误'},415);
  let data;try{data=JSON.parse((await bodyOf(req)).toString('utf8'));}catch{return json({error:'请求格式错误'},400);}
  // Supplier network calls must not hold the application's global DB queue.
  return vpayCheckout.submit(user,data);
 }
 if(url.pathname==='/api/v1/payment-callbacks/vpay/payment'){
  if(req.method!=='POST')return json({error:'Method not allowed'},405);
  if(!String(req.headers['content-type']).startsWith('application/json'))return json({error:'JSON required'},415);
  return vpaySettlement.receive(await bodyOf(req),req.headers.authorization);
 }
 if(url.pathname==='/api/v1/payment-channels'){
  if(req.method!=='GET')return json({error:'Method not allowed'},405);
  const user=await withStorage(()=>sessionUser(req.headers.cookie));
  return getPaymentChannels(user,url.searchParams.get('tenant'));
 }
 return withStorage(()=>handle(req));
}
async function bodyOf(req){if(req.portalBody)return req.portalBody;let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>16384)throw Error('TOO_LARGE');chunks.push(c)}return Buffer.concat(chunks)}
async function log(user,action){(await sql.prepare('INSERT INTO audit(id,tenant_id,actor,action,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),user.tenantId||'main',user.email,action,new Date().toISOString()))}
async function accountsPage(user){const head=user.role==='owner';const users=(await sql.prepare(`SELECT u.id,u.username,u.email,u.role,u.approved,p.role AS staff_role,COALESCE(p.tenant_id,m.tenant_id,'main') AS tenant_id FROM portal_users u LEFT JOIN portal_staff p ON p.user_id=u.id LEFT JOIN members m ON m.email=u.email ${head?'':"WHERE u.role<>'owner' AND COALESCE(p.tenant_id,m.tenant_id,'main')=?"} ORDER BY u.created_at DESC LIMIT 300`).all(...(head?[]:[user.tenantId])));return page('账号与租户管理',`<main class="accounts"><header class="server-brandbar"><img src="/brand/master7-logo.jpg" alt="MASTER7 — SEVEN Premium Experience" width="48" height="48"><div><strong>MASTER7</strong><span>OPERATIONS CONSOLE</span></div></header><div class="page-heading"><div><p class="eyebrow">MEMBERS &amp; ACCESS</p><h1>${head?'总部账号与租户管理':'本租户账号管理'}</h1><p>审批新会员、分配职责，并保持每个品牌的数据权限独立。</p></div><a class="secondary" href="/admin">返回运营后台</a></div>${head?`<section class="account-row"><h2>创建全新租户</h2><form class="settings-form" method="post" action="/accounts/tenant"><label>租户代码<input name="tenantId" required pattern="[a-z0-9][a-z0-9_-]{2,39}" maxlength="40"></label><button class="primary">创建租户</button><p>建立全新空白空间，不导入旧账号、余额、订单或内容。</p></form></section>`:''}${users.map(u=>`<section class="account-row"><b>${escape(u.username)}</b><p>${escape(u.email)} · ${escape(u.tenant_id)} · ${escape(u.role==='owner'?'总部':u.staff_role==='tenant_owner'?'租户老板':u.staff_role==='employee'?'员工':'会员')} · ${u.approved?'已批准':'等待批准'}</p>${u.role!=='owner'&&(head||!u.staff_role)?`<form method="post" action="/accounts/${u.approved?'suspend':'approve'}"><input type="hidden" name="id" value="${escape(u.id)}"><button class="secondary">${u.approved?'暂停并撤销登录':'批准账号'}</button></form>`:''}${head&&u.role!=='owner'?`<form class="settings-form" method="post" action="/accounts/role"><input type="hidden" name="id" value="${escape(u.id)}"><label>租户代码<input name="tenantId" value="${escape(u.tenant_id)}" required maxlength="60"></label><label>职责<select name="role"><option value="customer" ${!u.staff_role?'selected':''}>会员</option><option value="tenant_owner" ${u.staff_role==='tenant_owner'?'selected':''}>租户老板</option><option value="employee" ${u.staff_role==='employee'?'selected':''}>员工</option></select></label><button class="secondary">保存归属与职责并撤销旧登录</button><p>已明确归属其他租户的账号不能直接转移。</p></form>`:''}</section>`).join('')}</main>`)}
async function connectionsPage(){const rows=(await listConnections()),events=(await listEvents());return page('接口与回调管理',`<main class="accounts"><header class="server-brandbar"><img src="/brand/master7-logo.jpg" alt="MASTER7 — SEVEN Premium Experience" width="48" height="48"><div><strong>MASTER7</strong><span>INTEGRATION CONSOLE</span></div></header><div class="page-heading"><div><p class="eyebrow">OWNER · CONNECTIONS</p><h1>接口与回调管理</h1><p>只管理受控接收通道；收到事件不代表游戏、支付或钱包业务已经完成。</p></div><a class="secondary" href="/admin">返回运营后台</a></div><section class="account-row"><h2>配置接收通道</h2><form class="settings-form" method="post" action="/connections"><label>连接标识<input name="id" required pattern="[a-z0-9][a-z0-9_-]{2,39}" maxlength="40"></label><label>工作空间 ID<input name="tenantId" required value="main" maxlength="60"></label><label>签名密钥的环境变量名<input name="keyEnv" required pattern="PORTAL_HOOK_[A-Z0-9_]{3,60}" maxlength="72" placeholder="PORTAL_HOOK_..." autocomplete="off"></label><p>这里只填写环境变量名称，密钥由部署负责人在服务器设置，至少 32 字节。</p><label><input type="checkbox" name="enabled"> 启用接收</label><button class="primary">保存连接</button></form></section><section class="account-row"><h2>已配置连接</h2>${rows.length?rows.map(c=>`<div class="account-row"><b>${escape(c.id)}</b><p>${escape(c.tenantId)} · ${c.enabled?'已启用':'已停用'} · ${c.configured?'密钥已配置':'缺少密钥'}</p><code>${escape(c.callbackPath)}</code><p>密钥变量：${escape(c.keyEnv)}</p><form method="post" action="/connections"><input type="hidden" name="id" value="${escape(c.id)}"><input type="hidden" name="tenantId" value="${escape(c.tenantId)}"><input type="hidden" name="keyEnv" value="${escape(c.keyEnv)}">${c.enabled?'':'<input type="hidden" name="enabled" value="on">'}<button class="secondary">${c.enabled?'停用连接':'启用连接'}</button></form></div>`).join(''):'<p>暂无连接。</p>'}</section><section class="account-row"><h2>最近收到的事件</h2><p>仅显示事件元数据，原始内容不会在这里公开。事件仍待对应适配器安全处理。</p>${events.length?events.map(e=>`<div class="account-row"><b>${escape(e.type)}</b><p>${escape(e.connectionId)} · ${escape(e.tenantId)} · ${escape(e.receivedAt)}</p><code>${escape(e.eventId)}</code><p>已接收 / 未处理</p></div>`).join(''):'<p>暂无事件。</p>'}</section></main>`)}
async function handle(req){const url=new URL(req.url,origin);const user=(await sessionUser(req.headers.cookie));const method=req.method||'GET';
 if(method==='POST'&&!url.pathname.startsWith('/api/v1/hooks/')&&!originAllowed(req.headers.origin))return json({error:'请求来源不受信任'},403);
 if(url.pathname==='/owner-setup'){
  if(!['GET','POST'].includes(method))return new Response('Method not allowed',{status:405});
  const config=ownerBootstrapConfig();
  if(!config)return new Response('Not found',{status:404});
  if((await sql.prepare("SELECT id FROM portal_users WHERE role='owner'").get()))return ownerSetupClosed();
  if(config.expiresAt<=Date.now())return ownerSetupClosed('一次性开户期限已结束，请由部署负责人重新签发。');
  if((await sql.prepare('SELECT id FROM portal_users WHERE username=? OR email=?').get(config.username,config.email)))return ownerSetupClosed('开户配置不可用，请由部署负责人重新签发。',409);
  if(method==='GET')return ownerSetupPage(config);
  if(!String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded'))return json({error:'请求格式错误'},415);
  const ip=req.socket.remoteAddress||'unknown';if(await limited('owner-bootstrap-ip:'+ip,10))return ownerSetupPage(config,'尝试次数过多，请 15 分钟后再试。',429);
  const form=new URLSearchParams((await bodyOf(req)).toString()),token=form.get('bootstrapToken')||'',password=form.get('password')||'',confirm=form.get('confirmPassword')||'';
  if(!bootstrapTokenValid(token,config.tokenHash)||!passwordValid(password)||password!==confirm)return ownerSetupPage(config,'开户资料或一次性代码无效。',400);
  const recovery=secret(),passwordHash=await hashPassword(password),createdAt=new Date().toISOString();
  await sql.exec('BEGIN IMMEDIATE');try{
   if((await sql.prepare("SELECT id FROM portal_users WHERE role='owner'").get())){await sql.exec('ROLLBACK');return ownerSetupClosed()}
   await sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),config.username,config.email,passwordHash,'owner',1,digest(recovery),createdAt);
   await sql.prepare('INSERT INTO audit(id,tenant_id,actor,action,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),'main',config.email,'安全建立首位总部管理员',createdAt);
   await sql.exec('COMMIT');
  }catch(e){
   await sql.exec('ROLLBACK');
   if((await sql.prepare("SELECT id FROM portal_users WHERE role='owner'").get()))return ownerSetupClosed();
   throw e;
  }
  return ownerRecoveryPage(recovery);
 }
 if(url.pathname==='/payment-return'){
  if(method!=='GET')return json({error:'Method not allowed'},405);
  if(!user)return redirect('/signin');
  return page('付款结果核验',`<div class="auth-shell"><main class="auth-card"><div class="brandmark auth-brand-logo"><img src="/brand/master7-logo.jpg" alt="MASTER7 — SEVEN Premium Experience" width="128" height="128"></div><p class="eyebrow">MASTER7 · PAYMENT STATUS</p><h1>正在核对付款结果</h1><p>付款结果以钱包与充值记录为准。页面跳转不会增加余额；如仍在处理中，请稍后刷新记录。</p><a class="primary" href="/">返回会员中心查看充值记录</a></main></div>`);
 }
 if(['/api/v1/wallet','/api/v1/payment-records','/api/v1/payment-records/export'].includes(url.pathname)){
  if(method!=='GET')return json({error:'Method not allowed'},405);
  if(url.pathname==='/api/v1/wallet')return getWallet(user,url.searchParams.get('tenant'),url.searchParams.get('environment')||'production');
  return getPaymentRecords(user,url.searchParams,{exportCSV:url.pathname.endsWith('/export')});
 }
 if(url.pathname==='/account'){
  if(!user)return redirect('/signin');
  if(method==='GET')return page('账号安全',`<div class="auth-shell"><main class="auth-card"><div class="brandmark auth-brand-logo"><img src="/brand/master7-logo.jpg" alt="MASTER7 — SEVEN Premium Experience" width="128" height="128"></div><p class="eyebrow">MASTER7 · ACCOUNT SECURITY</p><h1>账号安全</h1><p>当前账号：${escape(user.displayName)}</p><p>修改密码将退出所有旧登录，并更换恢复码。请准备离线保存新的恢复码。</p><form method="post" action="/account"><label>当前密码<input type="password" name="currentPassword" required minlength="12" maxlength="256" autocomplete="current-password"></label><label>新密码<input type="password" name="newPassword" required minlength="12" maxlength="256" autocomplete="new-password"></label><label>确认新密码<input type="password" name="confirmPassword" required minlength="12" maxlength="256" autocomplete="new-password"></label><button class="primary full">修改密码并退出全部登录</button></form><nav class="auth-links"><a href="${user.role==='customer'?'/':'/admin'}">返回${user.role==='customer'?'会员平台':'运营后台'}</a></nav></main></div>`);
  if(method!=='POST')return new Response('Method not allowed',{status:405});
  if(!String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded'))return json({error:'请求格式错误'},415);
  if((await limited('account-password:'+user.userId,10)))return json({error:'尝试过于频繁，请稍后再试'},429);
  const f=new URLSearchParams((await bodyOf(req)).toString()),current=f.get('currentPassword')||'',next=f.get('newPassword')||'',confirm=f.get('confirmPassword')||'';
  if(!passwordValid(next)||next!==confirm||next===current)return json({error:'新密码至少 12 个字符，须与确认一致且不同于当前密码'},400);
  const row=(await sql.prepare('SELECT password_hash FROM portal_users WHERE id=?').get(user.userId));
  if(!row||!await verifyPassword(current,row.password_hash))return json({error:'当前密码不正确'},400);
  const newHash=await hashPassword(next),recovery=secret();(await sql.exec('BEGIN IMMEDIATE'));try{
   const r=(await sql.prepare('UPDATE portal_users SET password_hash=?,recovery_hash=? WHERE id=? AND password_hash=?').run(newHash,digest(recovery),user.userId,row.password_hash));
   if(!r.changes)throw Error('Concurrent password change');
   (await sql.prepare('DELETE FROM portal_sessions WHERE user_id=?').run(user.userId));(await log(user,'修改账号密码并撤销全部登录'));(await sql.exec('COMMIT'));
  }catch(e){(await sql.exec('ROLLBACK'));throw e;}
  const response=recoveryPage(recovery,true);response.headers.set('set-cookie','portal_session=; Max-Age=0'+cookieFlags);return response;
 }
 if(url.pathname==='/api/v1/deposit-requests'){
  if(!user)return json({error:'请先登录'},401);
  if(method==='GET')return (await getDepositRequests(user,url.searchParams.get('tenant')));
  if(method!=='POST')return json({error:'Method not allowed'},405);
  if(req.headers['x-portal-request']!=='1'||!String(req.headers['content-type']).startsWith('application/json'))return json({error:'请求格式错误'},415);
  let data;try{data=JSON.parse((await bodyOf(req)).toString());}catch{return json({error:'请求格式错误'},400);}
  return (await createDepositRequest(user,url.searchParams.get('tenant'),data));
 }
 if(url.pathname.startsWith('/api/v1/hooks/')){
  if(method!=='POST')return json({error:'Method not allowed'},405);
  return (await receiveEvent(req,url.pathname.slice('/api/v1/hooks/'.length),await bodyOf(req)));
 }
 if(url.pathname==='/api/v1/me'){
  if(method!=='GET')return json({error:'Method not allowed'},405);
  return user?json({id:user.userId,username:user.displayName,role:user.role,finance:user.finance}):json({error:'Authentication required'},401);
 }
 if(url.pathname==='/connections'||url.pathname.startsWith('/api/v1/connections')){
  if(!user)return url.pathname==='/connections'?redirect('/signin'):json({error:'Authentication required'},401);
  if(user.role!=='owner')return json({error:'Owner access required'},403);
  if(method==='GET'&&url.pathname==='/api/v1/connections')return json({connections:(await listConnections()),events:(await listEvents())});
  if(method==='POST'&&url.pathname==='/api/v1/connections'){
   if(!String(req.headers['content-type']).startsWith('application/json')||req.headers['x-portal-request']!=='1')return json({error:'Invalid request'},415);
   let data;try{data=JSON.parse((await bodyOf(req)).toString());}catch{return json({error:'Invalid JSON'},400);}
   return data&&typeof data==='object'&&!Array.isArray(data)?(await configureConnection(data,user)):json({error:'Invalid request'},400);
  }
  if(method==='POST'&&url.pathname==='/connections'){
   if(!String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded'))return json({error:'Invalid request'},415);
   const f=new URLSearchParams((await bodyOf(req)).toString());const r=(await configureConnection({id:f.get('id'),tenantId:f.get('tenantId'),keyEnv:f.get('keyEnv'),enabled:f.get('enabled')==='on'},user));
   return r.ok?redirect('/connections'):r;
  }
  if(method==='GET'&&url.pathname==='/connections')return (await connectionsPage());
  return json({error:'Not found'},404);
 }
 if(method==='GET'&&url.pathname==='/health'){
  try{await sql.prepare('SELECT 1 AS ready').get();return json({status:'ok',database:'ready',scope:'database_readiness',authentication:'platform-password',externalServices:false,release:process.env.RENDER_GIT_COMMIT||'local'});}
  catch{return json({status:'unavailable',database:'unavailable',scope:'database_readiness',externalServices:false},503);}
 }
 if(method==='GET'&&(url.pathname.startsWith('/assets/')||url.pathname==='/brand/master7-logo.jpg')){const name={'/brand/master7-logo.jpg':['master7-logo.jpg','image/jpeg'],'/assets/client.js':['client.js','text/javascript; charset=utf-8'],'/assets/portal.css':['portal.css','text/css; charset=utf-8']}[url.pathname];return name?new Response(readFileSync(resolve('standalone/dist',name[0])),{headers:{'content-type':name[1]}}):new Response('Not found',{status:404})}
 if(method==='GET'&&['/signin','/register','/reset'].includes(url.pathname))return authPage(url.pathname.slice(1));
 if(method==='POST'&&url.pathname.startsWith('/auth/')){
  if(!String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded'))return json({error:'请求格式错误'},415);
  const form=new URLSearchParams((await bodyOf(req)).toString()),action=url.pathname.slice(6),username=(form.get('username')||'').trim().toLowerCase(),password=form.get('password')||'';
  if(action==='logout'){const token=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('portal_session='))?.slice(15);if(token)(await sql.prepare('DELETE FROM portal_sessions WHERE token_hash=?').run(digest(token)));return redirect('/signin','portal_session=; Max-Age=0'+cookieFlags)}
  const ip=req.socket.remoteAddress||'unknown';if((await limited('auth-ip:'+ip,60))||(await limited(action+':'+username,10)))return authPage(action==='login'?'signin':action,'尝试次数过多，请 15 分钟后再试。',429);
  if(!/^[a-z0-9_-]{3,40}$/.test(username))return authPage(action==='login'?'signin':action,'账号格式无效。',400);
  if(action==='register'){
   const email=(form.get('email')||'').trim().toLowerCase();if(!passwordValid(password)||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return authPage('register','请检查邮箱；密码至少 12 个字符，最多 256 字节。',400);
   const bootstrap=ownerBootstrapConfig();if(bootstrap&&(username===bootstrap.username||email===bootstrap.email))return authPage('register','账号或邮箱不可用，请使用其他资料。',409);
   const recovery=secret(),hash=await hashPassword(password);try{(await sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),username,email,hash,'customer',0,digest(recovery),new Date().toISOString()))}catch{return authPage('register','账号或邮箱不可用，请使用其他资料。',409)}return recoveryPage(recovery);
  }
  const row=(await sql.prepare('SELECT * FROM portal_users WHERE username=?').get(username));
  if(action==='login'){
   const valid=await verifyPassword(password,row?.password_hash||dummyHash);if(!row||!valid||!row.approved)return authPage('signin','账号、密码错误，或账号尚未批准。',401);
   const staff=await sql.prepare('SELECT user_id FROM portal_staff WHERE user_id=?').get(row.id),token=await newSession(row.id);
   if(!token)return authPage('signin','账号、密码错误，或账号尚未批准。',401);
   return redirect(row.role==='owner'||staff?'/admin':'/','portal_session='+token+'; Max-Age=28800'+cookieFlags);
  }
  if(action==='reset'){
   const code=form.get('recovery')||'';if(!row||code.length>100||digest(code)!==row.recovery_hash||!passwordValid(password))return authPage('reset','账号、恢复码或新密码不正确。',400);
   const recovery=secret(),hash=await hashPassword(password);(await sql.exec('BEGIN IMMEDIATE'));try{const result=(await sql.prepare('UPDATE portal_users SET password_hash=?,recovery_hash=? WHERE id=? AND recovery_hash=?').run(hash,digest(recovery),row.id,digest(code)));if(!result.changes)throw Error('Recovery already used');(await sql.prepare('DELETE FROM portal_sessions WHERE user_id=?').run(row.id));(await sql.exec('COMMIT'))}catch(e){(await sql.exec('ROLLBACK'));throw e;}return recoveryPage(recovery,true);
  }
  return new Response('Not found',{status:404});
 }
 if(url.pathname==='/api/portal'){
  if(!['GET','POST'].includes(method))return json({error:'Method not allowed'},405);
  const data=method==='POST'?await bodyOf(req):undefined;const requestOrigin=originAllowed(req.headers.origin)?req.headers.origin:origin.origin;const request=new Request(new URL(url.pathname+url.search,requestOrigin),{method,headers:{origin:req.headers.origin||'','content-type':String(req.headers['content-type']||''),'x-portal-request':String(req.headers['x-portal-request']||'')},body:data});
  return identity.run(user,()=>method==='POST'?api.POST(request):api.GET(request));
 }
 if(url.pathname==='/accounts'||url.pathname.startsWith('/accounts/')){
  if(!user)return redirect('/signin');if(!['owner','tenant_owner'].includes(user.role))return new Response('无管理权限',{status:403});
  if(method==='GET'&&url.pathname==='/accounts')return (await accountsPage(user));
  if(method==='POST'&&['/accounts/role','/accounts/tenant'].includes(url.pathname)){
   if(user.role!=='owner')return new Response('仅总部可分配职责',{status:403});
   const f=new URLSearchParams((await bodyOf(req)).toString()),tenantId=f.get('tenantId')||'';
   if(url.pathname==='/accounts/tenant'){
    if(!/^[a-z0-9][a-z0-9_-]{2,39}$/.test(tenantId)||tenantId==='main')return json({error:'租户代码无效'},400);
    if((await sql.prepare('SELECT id FROM brands WHERE id=?').get(tenantId)))return json({error:'租户已存在'},409);
    const now=new Date().toISOString();(await sql.exec('BEGIN IMMEDIATE'));try{(await sql.prepare('INSERT INTO brands(id,name,created_at) VALUES (?,?,?)').run(tenantId,tenantId,now));(await log(user,'创建租户：'+tenantId));(await sql.exec('COMMIT'));}catch(e){(await sql.exec('ROLLBACK'));throw e;}return redirect('/accounts');
   }
   const id=f.get('id')||'',role=f.get('role')||'';
   if(!['tenant_owner','employee','customer'].includes(role))return json({error:'职责无效'},400);
   const target=(await sql.prepare("SELECT id,email FROM portal_users WHERE id=? AND role='customer'").get(id));
   if(!target)return json({error:'账号不存在'},404);
   if(tenantId!=='main'&&!(await sql.prepare('SELECT id FROM brands WHERE id=?').get(tenantId)))return json({error:'租户不存在'},404);
   const membership=(await sql.prepare('SELECT tenant_id FROM members WHERE email=?').get(target.email)),staff=(await sql.prepare('SELECT tenant_id FROM portal_staff WHERE user_id=?').get(id));
   const mainAssignment=membership?.tenant_id==='main'&&tenantId!=='main'&&!staff;
   if((membership&&membership.tenant_id!==tenantId&&!mainAssignment)||(staff&&staff.tenant_id!==tenantId))return json({error:'账号已归属其他租户，不能直接转移'},409);
   (await sql.exec('BEGIN IMMEDIATE'));try{
    // Serialize membership/staff assignment with wallet settlements that
    // revalidate this identity before crediting funds.
    const identityLock=await sql.prepare("UPDATE portal_users SET id=id WHERE id=? AND role='customer'").run(id);
    if(identityLock.changes!==1)throw Error('ACCOUNT_NOT_FOUND');
    const currentTarget=await sql.prepare("SELECT id,email FROM portal_users WHERE id=? AND role='customer'").get(id);
    await sql.prepare('UPDATE members SET email=email WHERE email=?').run(currentTarget.email);
    const currentMembership=await sql.prepare('SELECT tenant_id FROM members WHERE email=?').get(currentTarget.email);
    const currentStaff=await sql.prepare('SELECT tenant_id FROM portal_staff WHERE user_id=?').get(id);
    const currentMainAssignment=currentMembership?.tenant_id==='main'&&tenantId!=='main'&&!currentStaff;
    if((currentMembership&&currentMembership.tenant_id!==tenantId&&!currentMainAssignment)||(currentStaff&&currentStaff.tenant_id!==tenantId))throw Error('TENANT_ASSIGNMENT_CONFLICT');
    if(currentMainAssignment)(await sql.prepare("UPDATE members SET tenant_id=? WHERE email=? AND tenant_id='main'").run(tenantId,currentTarget.email));
    else (await sql.prepare('INSERT INTO members(email,tenant_id,created_at) VALUES (?,?,?) ON CONFLICT(email) DO NOTHING').run(currentTarget.email,tenantId,new Date().toISOString()));
    const assignedMembership=await sql.prepare('SELECT tenant_id FROM members WHERE email=?').get(currentTarget.email);
    if(!assignedMembership||assignedMembership.tenant_id!==tenantId)throw Error('TENANT_ASSIGNMENT_CONFLICT');
    const financeRevoked=await sql.prepare('DELETE FROM portal_finance_staff WHERE user_id=?').run(id);
    if(role==='customer')(await sql.prepare('DELETE FROM portal_staff WHERE user_id=?').run(id));else (await sql.prepare('INSERT INTO portal_staff VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET role=excluded.role').run(id,tenantId,role));
    (await sql.prepare('DELETE FROM portal_sessions WHERE user_id=?').run(id));if(financeRevoked.changes)(await log(user,'职责变更撤销财务审核权限：'+currentTarget.email));(await log(user,'分配职责：'+currentTarget.email+' / '+tenantId+' / '+role));(await sql.exec('COMMIT'));
   }catch(e){(await sql.exec('ROLLBACK'));if(e.message==='ACCOUNT_NOT_FOUND')return json({error:'账号不存在'},404);if(e.message==='TENANT_ASSIGNMENT_CONFLICT')return json({error:'账号已归属其他租户，不能直接转移'},409);throw e;}return redirect('/accounts');
  }
  if(method==='POST'&&['/accounts/approve','/accounts/suspend'].includes(url.pathname)){
   const f=new URLSearchParams((await bodyOf(req)).toString()),id=f.get('id')||'',approve=url.pathname.endsWith('approve');
   const target=(await sql.prepare("SELECT u.id,u.username,u.email,p.role AS staff_role,p.tenant_id AS staff_tenant,m.tenant_id AS member_tenant FROM portal_users u LEFT JOIN portal_staff p ON p.user_id=u.id LEFT JOIN members m ON m.email=u.email WHERE u.id=? AND u.role='customer'").get(id));if(!target)return new Response('账号不存在',{status:404});
   if(user.role==='tenant_owner'&&(target.member_tenant!==user.tenantId||target.staff_role))return json({error:'仅可管理本租户客户'},403);
   (await sql.exec('BEGIN IMMEDIATE'));try{
    const identityLock=await sql.prepare("UPDATE portal_users SET id=id WHERE id=? AND role='customer'").run(id);if(identityLock.changes!==1)throw Error('ACCOUNT_NOT_FOUND');
    const current=await sql.prepare("SELECT u.username,u.email,p.role AS staff_role,p.tenant_id AS staff_tenant,m.tenant_id AS member_tenant FROM portal_users u LEFT JOIN portal_staff p ON p.user_id=u.id LEFT JOIN members m ON m.email=u.email WHERE u.id=? AND u.role='customer'").get(id);if(!current)throw Error('ACCOUNT_NOT_FOUND');
    await sql.prepare('UPDATE members SET email=email WHERE email=?').run(current.email);
    if(user.role==='tenant_owner'&&(current.member_tenant!==user.tenantId||current.staff_role))throw Error('ACCOUNT_FORBIDDEN');
    if(approve){
     const tenantId=current.member_tenant||current.staff_tenant||(user.role==='owner'?'main':user.tenantId);
     if(!tenantId||(current.member_tenant&&current.member_tenant!==tenantId)||(current.staff_tenant&&current.staff_tenant!==tenantId))throw Error('TENANT_ASSIGNMENT_CONFLICT');
     await sql.prepare('INSERT INTO members(email,tenant_id,created_at) VALUES (?,?,?) ON CONFLICT(email) DO NOTHING').run(current.email,tenantId,new Date().toISOString());
     const assigned=await sql.prepare('SELECT tenant_id FROM members WHERE email=?').get(current.email);if(!assigned||assigned.tenant_id!==tenantId)throw Error('TENANT_ASSIGNMENT_CONFLICT');
    }
    await sql.prepare('UPDATE portal_users SET approved=? WHERE id=?').run(approve?1:0,id);await sql.prepare('DELETE FROM portal_sessions WHERE user_id=?').run(id);await log(user,(approve?'批准账号：':'暂停账号：')+current.username);await sql.exec('COMMIT');
   }catch(e){await sql.exec('ROLLBACK');if(e.message==='ACCOUNT_NOT_FOUND')return new Response('账号不存在',{status:404});if(e.message==='ACCOUNT_FORBIDDEN')return json({error:'仅可管理本租户客户'},403);if(e.message==='TENANT_ASSIGNMENT_CONFLICT')return json({error:'账号租户归属冲突'},409);throw e;}return redirect('/accounts');
  }return new Response('Not found',{status:404});
 }
 if(method==='GET'&&['/','/admin'].includes(url.pathname)){
  if(!user){if(url.pathname==='/')return page('MASTER7 客户服务门户',publicHomeBody());return redirect('/signin');}if(url.pathname==='/admin'&&!['owner','tenant_owner','employee'].includes(user.role))return new Response('无管理权限',{status:403});
  return page(url.pathname==='/admin'?'MASTER7 运营后台':'MASTER7 会员平台','<div id="root"></div><script type="module" src="/assets/client.js"></script>');
 }
 return new Response('Not found',{status:404});
}
export const server=createServer(async(req,res)=>{let response;try{const pathname=new URL(req.url,origin).pathname;if(req.method==='POST'&&!gspayCallbackPaths.has(pathname)&&!unavailableGspayPublicPaths.has(pathname))req.portalBody=await bodyOf(req);response=await dispatch(req)}catch(e){console.error('Request failed:',e.message==='TOO_LARGE'?'body too large':'internal error');response=json({error:e.message==='TOO_LARGE'?'请求内容过长':'服务暂时无法处理，请稍后重试。'},e.message==='TOO_LARGE'?413:500)}
 // Native same-origin form POSTs must retain Origin for the strict source check above.
 const headers={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'same-origin','x-frame-options':'DENY','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; connect-src 'self'"};if(origin.protocol==='https:')headers['strict-transport-security']='max-age=31536000';response.headers.forEach((v,k)=>headers[k]=v);res.writeHead(response.status,headers);res.end(Buffer.from(await response.arrayBuffer()));});
server.requestTimeout=30000;server.headersTimeout=15000;
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const port=Number(process.env.PORT||8080);server.listen(port,process.env.HOST||'127.0.0.1',()=>console.log('MASTER7 listening on port '+server.address().port+'; origin '+origin.origin));}
