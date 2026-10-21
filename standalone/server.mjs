import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {identity,sql} from './runtime.mjs';
import {digest,secret,passwordValid,hashPassword,verifyPassword,limited,sessionUser,newSession} from './security.mjs';
import * as api from './dist/api.mjs';
const origin=new URL(process.env.PUBLIC_ORIGIN||'http://127.0.0.1:8080');
if(origin.protocol!=='https:'&&!['127.0.0.1','localhost','[::1]'].includes(origin.hostname))throw Error('PUBLIC_ORIGIN must use HTTPS outside local development.');
const cookieFlags='; Path=/; HttpOnly; SameSite=Lax'+(origin.protocol==='https:'?'; Secure':'');
const dummyHash=await hashPassword('unknown-account-password-never-used');
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function page(title,body,status=200){return new Response(`<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Service Portal</title><link rel="stylesheet" href="/assets/portal.css"><style>.auth-card{max-width:470px;margin:7vh auto;background:white;border:1px solid #e2eaf6;border-radius:16px;padding:32px}.auth-card h1{font-size:28px}.auth-card form{margin:22px 0}.auth-card label{display:block;font-size:12px;margin:15px 0;color:#62738b}.auth-card input{width:100%;padding:12px;margin-top:8px;border:1px solid #dfe7f2;border-radius:7px;font:inherit}.auth-card p{color:#73839b;font-size:12px;line-height:1.8;margin:15px 0}.auth-links{display:flex;gap:18px;color:#2165e8;font-size:12px;flex-wrap:wrap}.recovery{display:block;padding:16px;background:#edf3ff;border-radius:8px;overflow-wrap:anywhere;user-select:all;font-size:14px}.accounts{max-width:1000px;margin:35px auto;padding:20px}.account-row{background:white;padding:20px;border:1px solid #e2eaf6;border-radius:9px;margin-top:14px}.account-row form{display:inline-block;margin:10px 15px 0 0}@media(max-width:550px){.auth-card{margin:24px 15px;padding:25px}}</style></head><body>${body}</body></html>`,{status,headers:{'content-type':'text/html; charset=utf-8'}})}
function authPage(kind,message='',status=200){const register=kind==='register',reset=kind==='reset';const title=register?'创建平台账号':reset?'找回账号密码':'登录服务平台';return page(title,`<main class="auth-card"><div class="brandmark">S<span>·</span></div><p class="eyebrow">WHITE-LABEL SERVICE PORTAL</p><h1>${title}</h1><p>${register?'注册后由老板核实并批准，再登录使用。':reset?'使用注册或开户时保存的恢复码重设密码。':'使用本平台账号与密码进入服务中心。'}</p>${message?'<p role="alert">'+escape(message)+'</p>':''}<form method="post" action="/auth/${register?'register':reset?'reset':'login'}"><label>账号<input name="username" required pattern="[a-zA-Z0-9_-]{3,40}" minlength="3" maxlength="40" autocomplete="username"></label>${register?'<label>联系邮箱<input name="email" required type="email" maxlength="254" autocomplete="email"></label>':''}${reset?'<label>账号恢复码<input name="recovery" required maxlength="100" autocomplete="off"></label>':''}<label>${reset?'新密码':'密码'}<input type="password" name="password" required minlength="12" maxlength="256" autocomplete="${register||reset?'new-password':'current-password'}"></label>${register||reset?'<p>密码至少 12 个字符；不要重复使用其他网站的密码。</p>':''}<button class="primary full">${title}</button></form><nav class="auth-links"><a href="/signin">登录</a><a href="/register">注册</a><a href="/reset">找回密码</a></nav></main>`,status)}
function recoveryPage(code,reset=false){return page('保存账号恢复码',`<main class="auth-card"><h1>${reset?'密码已重设':'注册已提交'}</h1><p>请离线保存以下恢复码。它只显示这一次，持有者可以重设你的密码。不要发送给客服或其他人。</p><code class="recovery">${escape(code)}</code><p>${reset?'旧恢复码和所有旧登录会话已失效。下次请使用此新恢复码。':'账号还需老板核实并批准，恢复码不会再次显示。'}</p><a class="primary" href="/signin">返回登录</a></main>`)}
const redirect=(path,cookie)=>new Response(null,{status:303,headers:{location:path,...(cookie?{'set-cookie':cookie}:{})}});
const json=(data,status=200)=>Response.json(data,{status});
async function bodyOf(req){let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>16384)throw Error('TOO_LARGE');chunks.push(c)}return Buffer.concat(chunks)}
function log(user,action){sql.prepare('INSERT INTO audit(id,tenant_id,actor,action,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),'main',user.email,action,new Date().toISOString())}
function accountsPage(){const users=sql.prepare('SELECT id,username,email,role,approved,created_at FROM portal_users ORDER BY created_at DESC LIMIT 300').all();return page('账号管理',`<main class="accounts"><div class="page-heading"><div><p class="eyebrow">OWNER / ACCOUNT MANAGEMENT</p><h1>平台账号管理</h1><p>仅老板可以批准账号。核实账号和邮箱属于申请人后再批准。</p></div><a class="secondary" href="/admin">返回老板后台</a></div>${users.map(u=>`<section class="account-row"><b>${escape(u.username)}</b><p>${escape(u.email)} · ${u.role==='owner'?'老板':u.approved?'已批准':'等待批准'}</p>${u.role==='customer'?`<form method="post" action="/accounts/${u.approved?'suspend':'approve'}"><input type="hidden" name="id" value="${escape(u.id)}"><button class="${u.approved?'secondary':'primary'}">${u.approved?'暂停账号并撤销登录':'批准此账号'}</button></form>`:''}</section>`).join('')}</main>`)}
async function handle(req){const url=new URL(req.url,origin);const user=sessionUser(req.headers.cookie);const method=req.method||'GET';
 if(method==='POST'&&req.headers.origin!==origin.origin)return json({error:'请求来源不受信任'},403);
 if(method==='GET'&&url.pathname==='/health')return json({status:'ok',authentication:'platform-password',externalServices:false});
 if(method==='GET'&&url.pathname.startsWith('/assets/')){const name={'/assets/client.js':['client.js','text/javascript; charset=utf-8'],'/assets/portal.css':['portal.css','text/css; charset=utf-8']}[url.pathname];return name?new Response(readFileSync(resolve('standalone/dist',name[0])),{headers:{'content-type':name[1]}}):new Response('Not found',{status:404})}
 if(method==='GET'&&['/signin','/register','/reset'].includes(url.pathname))return authPage(url.pathname.slice(1));
 if(method==='POST'&&url.pathname.startsWith('/auth/')){
  if(!String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded'))return json({error:'请求格式错误'},415);
  const form=new URLSearchParams((await bodyOf(req)).toString()),action=url.pathname.slice(6),username=(form.get('username')||'').trim().toLowerCase(),password=form.get('password')||'';
  if(action==='logout'){const token=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('portal_session='))?.slice(15);if(token)sql.prepare('DELETE FROM portal_sessions WHERE token_hash=?').run(digest(token));return redirect('/signin','portal_session=; Max-Age=0'+cookieFlags)}
  const ip=req.socket.remoteAddress||'unknown';if(limited('auth-ip:'+ip,60)||limited(action+':'+username,10))return authPage(action==='login'?'signin':action,'尝试次数过多，请 15 分钟后再试。',429);
  if(!/^[a-z0-9_-]{3,40}$/.test(username))return authPage(action==='login'?'signin':action,'账号格式无效。',400);
  if(action==='register'){
   const email=(form.get('email')||'').trim().toLowerCase();if(!passwordValid(password)||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return authPage('register','请检查邮箱；密码至少 12 个字符，最多 256 字节。',400);
   const recovery=secret(),hash=await hashPassword(password);try{sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),username,email,hash,'customer',0,digest(recovery),new Date().toISOString())}catch{return authPage('register','账号或邮箱不可用，请使用其他资料。',409)}return recoveryPage(recovery);
  }
  const row=sql.prepare('SELECT * FROM portal_users WHERE username=?').get(username);
  if(action==='login'){
   const valid=await verifyPassword(password,row?.password_hash||dummyHash);if(!row||!valid||!row.approved)return authPage('signin','账号、密码错误，或账号尚未批准。',401);
   return redirect(row.role==='owner'?'/admin':'/','portal_session='+newSession(row.id)+'; Max-Age=28800'+cookieFlags);
  }
  if(action==='reset'){
   const code=form.get('recovery')||'';if(!row||code.length>100||digest(code)!==row.recovery_hash||!passwordValid(password))return authPage('reset','账号、恢复码或新密码不正确。',400);
   const recovery=secret(),hash=await hashPassword(password);sql.exec('BEGIN IMMEDIATE');try{const result=sql.prepare('UPDATE portal_users SET password_hash=?,recovery_hash=? WHERE id=? AND recovery_hash=?').run(hash,digest(recovery),row.id,digest(code));if(!result.changes)throw Error('Recovery already used');sql.prepare('DELETE FROM portal_sessions WHERE user_id=?').run(row.id);sql.exec('COMMIT')}catch(e){sql.exec('ROLLBACK');throw e;}return recoveryPage(recovery,true);
  }
  return new Response('Not found',{status:404});
 }
 if(url.pathname==='/api/portal'){
  if(!['GET','POST'].includes(method))return json({error:'Method not allowed'},405);
  const data=method==='POST'?await bodyOf(req):undefined;const request=new Request(new URL(url.pathname+url.search,origin),{method,headers:{origin:req.headers.origin||'','content-type':String(req.headers['content-type']||''),'x-portal-request':String(req.headers['x-portal-request']||'')},body:data});
  return identity.run(user,()=>method==='POST'?api.POST(request):api.GET(request));
 }
 if(url.pathname==='/accounts'||url.pathname.startsWith('/accounts/')){
  if(!user)return redirect('/signin');if(user.role!=='owner')return new Response('无管理权限',{status:403});
  if(method==='GET'&&url.pathname==='/accounts')return accountsPage();
  if(method==='POST'&&['/accounts/approve','/accounts/suspend'].includes(url.pathname)){
   const f=new URLSearchParams((await bodyOf(req)).toString()),id=f.get('id')||'',approve=url.pathname.endsWith('approve');
   const target=sql.prepare("SELECT id,username FROM portal_users WHERE id=? AND role='customer'").get(id);if(!target)return new Response('账号不存在',{status:404});
   sql.exec('BEGIN IMMEDIATE');try{sql.prepare('UPDATE portal_users SET approved=? WHERE id=?').run(approve?1:0,id);sql.prepare('DELETE FROM portal_sessions WHERE user_id=?').run(id);log(user,(approve?'批准账号：':'暂停账号：')+target.username);sql.exec('COMMIT')}catch(e){sql.exec('ROLLBACK');throw e;}return redirect('/accounts');
  }return new Response('Not found',{status:404});
 }
 if(method==='GET'&&['/','/admin'].includes(url.pathname)){
  if(!user)return redirect('/signin');if(url.pathname==='/admin'&&user.role!=='owner')return new Response('无管理权限',{status:403});
  return page('服务中心','<div id="root"></div><script type="module" src="/assets/client.js"></script>');
 }
 return new Response('Not found',{status:404});
}
export const server=createServer(async(req,res)=>{let response;try{response=await handle(req)}catch(e){console.error('Request failed:',e.message==='TOO_LARGE'?'body too large':'internal error');response=json({error:e.message==='TOO_LARGE'?'请求内容过长':'服务暂时无法处理，请稍后重试。'},e.message==='TOO_LARGE'?413:500)}
 const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; connect-src 'self'"};if(origin.protocol==='https:')headers['Strict-Transport-Security']='max-age=31536000';response.headers.forEach((v,k)=>headers[k]=v);res.writeHead(response.status,headers);res.end(Buffer.from(await response.arrayBuffer()));});
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const port=Number(process.env.PORT||8080);server.listen(port,process.env.HOST||'127.0.0.1',()=>console.log('Service Portal listening on port '+server.address().port+'; origin '+origin.origin));}
