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
 for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
  const context=await browser.newContext({viewport});const page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/signin');await page.locator('input[name=username]').fill('browserowner');await page.locator('input[name=password]').fill(fixturePassword);await page.getByRole('button',{name:'登录 MASTER7',exact:true}).click();await page.waitForURL('**/admin');
  await page.goto(base+'/admin?section=notices');
  const trigger=page.getByRole('button',{name:'新增公告',exact:true});await trigger.click();
  const dialog=page.getByRole('dialog');await dialog.waitFor();
  if(process.env.MASTER7_BROWSER_ARTIFACTS){mkdirSync(process.env.MASTER7_BROWSER_ARTIFACTS,{recursive:true});await page.screenshot({path:join(process.env.MASTER7_BROWSER_ARTIFACTS,'dialog-'+viewport.width+'.png')});}
  const initialFocus=await dialog.evaluate(el=>el.contains(document.activeElement));
  let focusEscaped=false;for(let i=0;i<12;i++){await page.keyboard.press('Tab');if(!await dialog.evaluate(el=>el.contains(document.activeElement)))focusEscaped=true;}
  for(let i=0;i<12;i++){await page.keyboard.press('Shift+Tab');if(!await dialog.evaluate(el=>el.contains(document.activeElement)))focusEscaped=true;}
  await page.keyboard.press('Escape');await page.waitForTimeout(120);
  const escapeClosed=!await dialog.isVisible();
  const focusRestored=await trigger.evaluate(el=>document.activeElement===el);
  const noHorizontalOverflow=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
  console.log(JSON.stringify({viewport,initialFocus,focusEscaped,escapeClosed,focusRestored,noHorizontalOverflow,errors}));
  {assert(initialFocus);assert(!focusEscaped);assert(escapeClosed);assert(focusRestored);assert(noHorizontalOverflow);assert.deepEqual(errors,[]);}
  await trigger.click();
  const noticeTitle='Synthetic keyboard regression notice '+viewport.width;
  await dialog.locator('input[name=title]').fill(noticeTitle);
  await dialog.locator('textarea[name=body]').fill('Local browser test only.');
  let release;const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/portal*',async route=>{if(route.request().method()==='POST')await gate;await route.continue();});
  await dialog.getByRole('button',{name:'保存公告',exact:true}).click();
  await dialog.getByRole('button',{name:'提交中…',exact:true}).waitFor();
  await page.keyboard.press('Escape');
  assert(await dialog.isVisible(),'Escape must not discard an in-flight save');
  assert(await dialog.getByRole('button',{name:'关闭',exact:true}).isDisabled());
  release();await dialog.waitFor({state:'hidden'});
  await page.getByText(noticeTitle,{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('PASS: notice save persists and Escape cannot dismiss an in-flight save at '+viewport.width+'px');
  await context.close();
 }
}finally{await browser?.close();if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));}rmSync(dir,{recursive:true,force:true});}
