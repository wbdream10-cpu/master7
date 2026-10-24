import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {configuredWebOrigin} from './production.mjs';

const assets=[['/assets/client.js','client.js','javascript'],['/assets/portal.css','portal.css','text/css'],['/brand/master7-logo.jpg','master7-logo.jpg','image/jpeg']];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function bytes(response,limit){
 const reader=response.body?.getReader();if(!reader)throw Error('EMPTY_RESPONSE');
 let size=0;const chunks=[];
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>limit){await reader.cancel();throw Error('RESPONSE_TOO_LARGE');}chunks.push(part.value);}}
 finally{reader.releaseLock();}
 return Buffer.concat(chunks);
}

export async function verifyDeployment({origin,commit,assetsDir,timeoutMs=45000,fetchImpl=fetch}){
 const base=configuredWebOrigin(origin,'Deployment origin').origin;
 if(!/^[a-f0-9]{40}$/.test(commit||''))throw Error('Expected a full lowercase 40-character commit SHA.');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw Error('Invalid verification timeout.');
 const checks=[];
 async function check(name,run){
  try{const detail=await run();checks.push({name,ok:true,...detail});}
  catch(error){const known=new Set(['HTTP_STATUS','CONTENT_TYPE','INVALID_HEALTH','STALE_RELEASE','INVALID_LOGIN','ADMIN_NOT_PROTECTED','REDIRECT_TARGET','RESPONSE_TOO_LARGE','EMPTY_RESPONSE','ASSET_MISMATCH','ASSET_UNAVAILABLE']);const tlsCodes=new Set(['CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);checks.push({name,ok:false,error:known.has(error.message)?error.message:error.name==='TimeoutError'?'TIMEOUT':tlsCodes.has(error.cause?.code)?'TLS_VERIFY_FAILED':'REQUEST_FAILED'});}
 }
 async function get(path){return fetchImpl(base+path,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(timeoutMs),headers:{accept:'*/*'}});}
 async function content(path,type,limit){
  const response=await get(path);
  if(response.status!==200){await response.body?.cancel();throw Error('HTTP_STATUS');}
  if(!(response.headers.get('content-type')||'').toLowerCase().includes(type)){await response.body?.cancel();throw Error('CONTENT_TYPE');}
  const data=await bytes(response,limit);if(!data.length)throw Error('EMPTY_RESPONSE');return data;
 }
 await Promise.all([
  check('health',async()=>{
   const body=await content('/health','application/json',16384);let data;try{data=JSON.parse(body.toString('utf8'));}catch{throw Error('INVALID_HEALTH');}
   if(data?.status!=='ok'||data.database!=='ready'||data.scope!=='database_readiness')throw Error('INVALID_HEALTH');
   if(data.release!==commit)throw Error('STALE_RELEASE');return {release:data.release,database:data.database};
  }),
  check('signin',async()=>{
   const body=(await content('/signin','text/html',256*1024)).toString('utf8');
   if(!/<form\b(?=[^>]*\saction\s*=\s*["']\/auth\/login["'])(?=[^>]*\smethod\s*=\s*["']post["'])[^>]*>/i.test(body))throw Error('INVALID_LOGIN');return {};
  }),
  check('anonymous-admin',async()=>{
   const response=await get('/admin');await response.body?.cancel();
   if(response.status!==303)throw Error('ADMIN_NOT_PROTECTED');
   let target;try{target=new URL(response.headers.get('location')||'',base);}catch{throw Error('REDIRECT_TARGET');}
   if(target.origin!==base||target.pathname!=='/signin'||target.search||target.hash)throw Error('REDIRECT_TARGET');return {status:303};
  }),
  ...assets.map(([path,file,type])=>check(file,async()=>{
   const data=await content(path,type,5*1024*1024);const digest=hash(data);
   if(assetsDir){let local;try{local=await readFile(resolve(assetsDir,file));}catch{throw Error('ASSET_UNAVAILABLE');}if(hash(local)!==digest)throw Error('ASSET_MISMATCH');}
   return {bytes:data.length,sha256:digest,comparedWithBuild:Boolean(assetsDir)};
  })),
 ]);
 checks.sort((a,b)=>a.name.localeCompare(b.name));
 return {origin:base,expectedCommit:commit,observedAt:new Date().toISOString(),ok:checks.every(check=>check.ok),checks,limitations:['Public checks do not verify authenticated workflows, backup/restore, provider acceptance, or real transactions.']};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const {values}=parseArgs({options:{origin:{type:'string'},commit:{type:'string'},'assets-dir':{type:'string'}},strict:true});
  const report=await verifyDeployment({origin:values.origin,commit:values.commit,assetsDir:values['assets-dir']});
  console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=1;
 }catch{console.error('Invalid verification configuration. Use --origin HTTPS_ORIGIN --commit FULL_SHA [--assets-dir BUILD_DIRECTORY].');process.exitCode=2;}
}
