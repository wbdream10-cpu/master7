import { createRequire } from 'node:module';
import { mkdirSync,readFileSync,writeFileSync,copyFileSync } from 'node:fs';
const {build}=createRequire(import.meta.url)('esbuild');mkdirSync('standalone/dist',{recursive:true});
await build({entryPoints:['app/api/portal/route.ts'],bundle:true,platform:'node',format:'esm',outfile:'standalone/dist/api.mjs',packages:'external',plugins:[{name:'standalone-adapters',setup(b){b.onResolve({filter:/chatgpt-auth$/},()=>({path:'auth',namespace:'adapter'}));b.onResolve({filter:/lib\/access$/},()=>({path:'access',namespace:'adapter'}));b.onResolve({filter:/^\.\.\/\.\.\/\.\.\/db$/},()=>({path:'db',namespace:'adapter'}));b.onLoad({filter:/.*/,namespace:'adapter'},({path})=>({contents:path==='auth'?"export {getUser as getChatGPTUser} from '../runtime.mjs'":path==='access'?"export {owner as isOwner} from '../runtime.mjs'":"import {database} from '../runtime.mjs'; export function getDb(){return database}",resolveDir:process.cwd()+'/standalone/dist'}));b.onResolve({filter:/^\.\.\/runtime\.mjs$/,namespace:'adapter'},()=>({path:'../runtime.mjs',external:true}));}}]});
await build({entryPoints:['standalone/client.tsx'],bundle:true,platform:'browser',format:'esm',outfile:'standalone/dist/client.js',minify:true,define:{'process.env.NODE_ENV':'"production"'}});
writeFileSync('standalone/dist/portal.css',readFileSync('app/globals.css','utf8').replace(/@import url\([^;]+;/g,''));
copyFileSync('public/brand/master7-logo.jpg','standalone/dist/master7-logo.jpg');
console.log('Standalone API, shared front/admin UI and CSS built.');
