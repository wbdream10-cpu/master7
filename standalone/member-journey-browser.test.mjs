import {chromium} from 'playwright';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url));
const dir=mkdtempSync(join(tmpdir(),'master7-browser-'));
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const base='http://127.0.0.1:'+port;
const env={...process.env};
for(const key of Object.keys(env))if(/^(RENDER|RAILWAY_|PORTAL_|PUBLIC_ORIGIN)/.test(key))delete env[key];
Object.assign(env,{NODE_ENV:'test',PORT:String(port),HOST:'127.0.0.1',PUBLIC_ORIGIN:base,PORTAL_DATABASE:join(dir,'browser.sqlite')});
const fixturePassword='Synthetic-browser-password-82713';
const setup=spawnSync(process.execPath,['standalone/admin.mjs','create-owner','browserowner','browser@example.test'],{cwd:root,env,input:fixturePassword+'\n',encoding:'utf8'});
assert.equal(setup.status,0,'Synthetic database setup must succeed');
let server,browser;
try{
 server=spawn(process.execPath,['standalone/server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Local server timeout')),12000);server.stdout.on('data',chunk=>{if(String(chunk).includes('MASTER7 listening')){clearTimeout(timer);resolve();}});server.on('exit',()=>{clearTimeout(timer);reject(Error('Local server exited'));});});
 browser=await chromium.launch({executablePath:process.env.MASTER7_CHROMIUM_PATH||undefined,headless:true,args:['--no-sandbox']});
 // A fresh navigation after each resize prevents stale layout measurements from
 // being mistaken for horizontal overflow in the public service-only homepage.
 const publicContext=await browser.newContext();
 try{
  const home=await publicContext.newPage();
  for(const width of [320,360,390,414,768,1440]){
   await home.setViewportSize({width,height:900});
   await home.goto(base+'/',{waitUntil:'load'});
   await home.locator('#m7-home-title').waitFor();
   const sizes=await home.evaluate(()=>({
    viewport:window.innerWidth,
    client:document.documentElement.clientWidth,
    rootScroll:document.documentElement.scrollWidth,
    bodyScroll:document.body.scrollWidth
   }));
   assert.equal(sizes.viewport,width,'browser viewport should match the test width');
   assert(sizes.rootScroll<=sizes.client,'public homepage root overflow at '+width+'px: '+JSON.stringify(sizes));
   assert(sizes.bodyScroll<=sizes.client,'public homepage body overflow at '+width+'px: '+JSON.stringify(sizes));
   const routes=await home.locator('.m7-home-actions a').evaluateAll(anchors=>anchors.map(a=>new URL(a.href).pathname));
   assert.deepEqual(routes,['/signin','/register'],'public service links must use local protected routes');
   console.log('PASS public homepage responsive '+width+'px: no horizontal overflow; sign-in and registration links');
  }
 }finally{await publicContext.close();}
 for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
  const ownerContext=await browser.newContext({viewport}),memberContext=await browser.newContext({viewport});
  const owner=await ownerContext.newPage(),member=await memberContext.newPage();
  const errors=[];for(const page of [owner,member])page.on('pageerror',e=>errors.push(e.message));
  const username='journey'+viewport.width,email=username+'@example.test',subject='Synthetic support request '+viewport.width;
  async function login(page,user){
   await page.goto(base+'/signin');await page.locator('input[name=username]').fill(user);await page.locator('input[name=password]').fill(fixturePassword);
   const response=page.waitForResponse(r=>r.url()===base+'/auth/login'&&r.request().method()==='POST');
   await page.getByRole('button',{name:'登录 MASTER7',exact:true}).click();return response;
  }
  async function navigate(page,label){
   if(viewport.width<800)await page.getByRole('button',{name:'展开菜单',exact:true}).click();
   await page.locator('.sidebar').getByRole('button',{name:new RegExp('^'+label)}).click();
  }
  await member.goto(base+'/register');await member.locator('input[name=username]').fill(username);await member.locator('input[name=email]').fill(email);await member.locator('input[name=password]').fill(fixturePassword);await member.getByRole('button',{name:'创建会员账号',exact:true}).click();
  await member.getByRole('heading',{name:'注册已提交',exact:true}).waitFor();
  assert.equal((await login(member,username)).status(),401,'pending member must not log in');
  assert.equal((await login(owner,'browserowner')).status(),303);await owner.waitForURL('**/admin');
  await navigate(owner,'会员管理');await owner.getByRole('link',{name:'打开账号管理'}).click();
  const row=owner.locator('.account-row').filter({has:owner.locator('b',{hasText:username})});
  await row.getByRole('button',{name:'批准账号',exact:true}).click();
  await row.getByText(/已批准/).waitFor();
  assert.equal((await login(member,username)).status(),303);await member.waitForURL(base+'/');
  assert.equal((await memberContext.request.get(base+'/admin',{maxRedirects:0})).status(),403,'member must not enter admin');
  await navigate(member,'在线客服');await member.getByRole('button',{name:'提交申请',exact:true}).click();
  let dialog=member.getByRole('dialog');await dialog.locator('input[name=title]').fill(subject);await dialog.locator('textarea[name=body]').fill('Synthetic question for full browser journey.');await dialog.getByRole('button',{name:'确认提交',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await member.getByText(subject,{exact:true}).waitFor();
  await owner.getByRole('link',{name:'返回运营后台'}).click();await navigate(owner,'客服申请');
  const ticket=owner.getByRole('row').filter({hasText:subject});await ticket.getByRole('button',{name:'查看'}).click();
  dialog=owner.getByRole('dialog');await dialog.locator('select[name=status]').selectOption('已完成');await dialog.locator('textarea[name=reply]').fill('Synthetic support reply '+viewport.width);await dialog.getByRole('button',{name:'保存处理结果'}).click();await dialog.waitFor({state:'hidden'});
  await member.reload();await member.getByRole('row').filter({hasText:subject}).getByRole('button',{name:'查看'}).click();
  dialog=member.getByRole('dialog');await dialog.getByText('Synthetic support reply '+viewport.width,{exact:true}).waitFor();await member.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  assert(await member.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'member page must fit viewport');
  await navigate(owner,'品牌设置');
  const brandName='Journey Brand '+viewport.width;
  await owner.locator('input[name=name]').fill(brandName);await owner.locator('textarea[name=tagline]').fill('Synthetic browser brand tagline');await owner.locator('input[name=color]').fill('#123abc');await owner.getByRole('button',{name:'保存品牌设置',exact:true}).click();
  await owner.getByRole('status').filter({hasText:'品牌设置已保存，前台与后台将使用同一份配置。'}).waitFor();
  await member.reload();await member.locator('.brand-name').filter({hasText:brandName}).waitFor();
  assert.equal(await member.locator('.shell').evaluate(el=>el.style.getPropertyValue('--brand')),'#123abc');
  const reconciliationResponse=owner.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/finance-reconciliation');
  await navigate(owner,'财务管理');assert.equal((await reconciliationResponse).status(),200);
  await owner.getByRole('heading',{name:'统一资金净额对账',exact:true}).waitFor();await owner.getByRole('link',{name:'导出统一 CSV'}).waitFor();
  await navigate(owner,'会员管理');await owner.getByRole('link',{name:'打开账号管理'}).click();await row.getByRole('button',{name:'暂停并撤销登录'}).click();
  await member.reload();await member.locator('#m7-home-title').waitFor();
  assert.equal((await memberContext.request.get(base+'/api/portal')).status(),401,'suspended session must not access member API');
  assert.equal((await login(member,username)).status(),401,'suspended member cannot log back in');
  assert.deepEqual(errors,[]);
  console.log('PASS '+viewport.width+'px: registration, pending rejection, UI approval, member login, admin denial, support submission/reply, shared brand name/theme persistence, authenticated finance rendering, suspension and session revocation; no page errors.');
  await ownerContext.close();await memberContext.close();
 }
}finally{await browser?.close();if(server&&server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));}rmSync(dir,{recursive:true,force:true});}
