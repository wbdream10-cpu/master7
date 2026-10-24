import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyDeployment} from './verify-deployment.mjs';

const commit='a'.repeat(40);
const fixtures={
 '/health':['application/json',JSON.stringify({status:'ok',database:'ready',scope:'database_readiness',release:commit})],
 '/signin':['text/html','<form method="post" action="/auth/login"><input name="username"></form>'],
 '/assets/client.js':['text/javascript','console.log("synthetic fixture");'],
 '/assets/portal.css':['text/css','body{color:blue}'],
 '/brand/master7-logo.jpg':['image/jpeg',Buffer.from([255,216,255,217])],
};
async function fixture(overrides,run){
 const directory=await mkdtemp(join(tmpdir(),'deployment-verifier-'));const requests=[];
 const server=createServer((req,res)=>{
  requests.push(req.method+' '+req.url);
  const override=overrides[req.url];if(override?.hang)return;
  if(req.url==='/admin'){res.writeHead(override?.status??303,{location:override?.location??'/signin'});res.end(override?.body??'');return;}
  const [type,body]=fixtures[req.url]||['text/plain','Not found'];
  res.writeHead(override?.status??(fixtures[req.url]?200:404),{'content-type':override?.type??type});res.end(override?.body??body);
 });
 try{
  for(const [path,[,data]] of Object.entries(fixtures))if(!['/health','/signin'].includes(path))await writeFile(join(directory,path.split('/').at(-1)),data);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const options={origin:'http://127.0.0.1:'+server.address().port,commit,assetsDir:directory,timeoutMs:1000};
  await run(options,requests);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
}
test('verifies release, database readiness, login, protection and exact built resources using GET only',async()=>{
 await fixture({},async(options,requests)=>{
  const report=await verifyDeployment(options);assert.equal(report.ok,true);assert.equal(report.checks.length,6);
  assert.equal(report.checks.filter(check=>check.comparedWithBuild).length,3);
  assert.equal(requests.length,6);assert(requests.every(request=>request.startsWith('GET ')));
 });
});

for(const [name,path,override,code] of [
 ['stale release','/health',{body:JSON.stringify({status:'ok',database:'ready',scope:'database_readiness',release:'b'.repeat(40)})},'STALE_RELEASE'],
 ['unavailable database','/health',{status:503},'HTTP_STATUS'],
 ['misleading healthy process','/health',{body:JSON.stringify({status:'ok',database:'unavailable',release:commit})},'INVALID_HEALTH'],
 ['HTML login error with HTTP 200','/signin',{body:'<html>Service error</html>'},'INVALID_LOGIN'],
 ['nonfunctional GET login form','/signin',{body:'<form method="get" action="/auth/login"></form>'},'INVALID_LOGIN'],
 ['public admin page','/admin',{status:200},'ADMIN_NOT_PROTECTED'],
 ['external login redirect','/admin',{location:'https://untrusted.example/signin'},'REDIRECT_TARGET'],
 ['missing built resource','/assets/client.js',{status:404},'HTTP_STATUS'],
 ['different built resource','/assets/client.js',{body:'different version'},'ASSET_MISMATCH'],
 ['wrong response type','/assets/portal.css',{type:'text/html'},'CONTENT_TYPE'],
 ['oversized health response','/health',{body:' '.repeat(17000)},'RESPONSE_TOO_LARGE'],
])test('rejects '+name,async()=>{
 await fixture({[path]:override},async options=>{
  const report=await verifyDeployment(options);assert.equal(report.ok,false);assert(report.checks.some(check=>check.error===code));
 });
});

test('does not follow external redirects',async()=>{
 await fixture({'/admin':{location:'https://untrusted.example/signin'}},async(options,requests)=>{
  const report=await verifyDeployment(options);assert.equal(report.ok,false);assert.equal(requests.length,6);
 });
});
test('timeouts terminate a stalled endpoint',async()=>{
 await fixture({'/health':{hang:true}},async options=>{
  const report=await verifyDeployment({...options,timeoutMs:100});assert.equal(report.ok,false);assert(report.checks.some(check=>check.name==='health'&&check.error==='TIMEOUT'));
 });
});
test('missing local resources fail instead of silently skipping comparison',async()=>{
 await fixture({},async options=>{
  const report=await verifyDeployment({...options,assetsDir:join(options.assetsDir,'missing')});assert.equal(report.ok,false);assert.equal(report.checks.filter(check=>check.error==='ASSET_UNAVAILABLE').length,3);
 });
});
test('omitting a local build explicitly reports resources were not compared',async()=>{
 await fixture({},async options=>{
  const report=await verifyDeployment({...options,assetsDir:undefined});assert.equal(report.ok,true);assert.equal(report.checks.filter(check=>check.comparedWithBuild===false).length,3);
 });
});
test('invalid or credential-bearing origins and incomplete commits fail before requests',async()=>{
 let requests=0;const fetchImpl=()=>{requests++;throw Error('Must not send request');};
 for(const options of [{origin:'http://remote.example',commit},{origin:'https://user:password@example.test',commit},{origin:'https://example.test/path',commit},{origin:'https://example.test',commit:'abc123'}])await assert.rejects(verifyDeployment({...options,fetchImpl}));
 assert.equal(requests,0);
});

test('certificate verification errors remain failures and do not expose raw connection details',async()=>{
 const fetchImpl=async()=>{throw Object.assign(Error('synthetic-private-connection-detail'),{cause:{code:'SELF_SIGNED_CERT_IN_CHAIN'}});};
 const report=await verifyDeployment({origin:'https://example.test',commit,fetchImpl});
 assert.equal(report.ok,false);assert(report.checks.every(check=>check.error==='TLS_VERIFY_FAILED'));
 assert.equal(JSON.stringify(report).includes('synthetic-private-connection-detail'),false);
});
