// Hosted environments must never silently use an ephemeral local database.
export function isProduction(env=process.env){
 return env.NODE_ENV==='production'||Boolean(env.RENDER||env.RAILWAY_ENVIRONMENT_ID||env.RAILWAY_ENVIRONMENT_NAME||env.RAILWAY_PROJECT_ID||env.RAILWAY_SERVICE_ID);
}

export function validateStorageConfig(env=process.env){
 if(env.PORTAL_TEST_POSTGRES==='1'&&isProduction(env))throw Error('The embedded Postgres test driver cannot be used in production.');
 if(isProduction(env)&&!env.PORTAL_POSTGRES_URL?.trim())throw Error('Production requires PORTAL_POSTGRES_URL; refusing ephemeral SQLite storage.');
 if(Object.hasOwn(env,'PORTAL_POSTGRES_URL')&&!env.PORTAL_POSTGRES_URL?.trim())throw Error('PORTAL_POSTGRES_URL is empty.');
}

export function configuredWebOrigin(value,name,{production=false}={}){
 const raw=String(value||'').trim();
 let parsed;try{parsed=new URL(raw);}catch{throw Error(`${name} must be a valid HTTP(S) origin.`);}
 if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash)throw Error(`${name} must contain only an HTTP(S) origin, without credentials, path, query, or fragment.`);
 if(parsed.protocol!=='https:'&&(production||!new Set(['127.0.0.1','localhost','[::1]']).has(parsed.hostname)))throw Error(`${name} must use HTTPS outside local development.`);
 return parsed;
}

export function webConfig(env=process.env){
 const production=isProduction(env);
 if(production&&!env.PUBLIC_ORIGIN?.trim())throw Error('Production requires an explicit HTTPS PUBLIC_ORIGIN.');
 const origin=configuredWebOrigin(env.PUBLIC_ORIGIN||'http://127.0.0.1:8080','PUBLIC_ORIGIN',{production});
 const allowedOrigins=new Set([origin.origin]);
 const configured=String(env.PORTAL_ALLOWED_ORIGINS||'').trim();
 if(configured.length>2000)throw Error('PORTAL_ALLOWED_ORIGINS is too long.');
 if(configured){
  const entries=configured.split(',').map(value=>value.trim());
  if(entries.length>20||entries.some(value=>!value))throw Error('PORTAL_ALLOWED_ORIGINS must contain at most 20 comma-separated origins.');
  for(const entry of entries){
   const allowed=configuredWebOrigin(entry,'PORTAL_ALLOWED_ORIGINS',{production});
   if(allowed.protocol!==origin.protocol)throw Error('PORTAL_ALLOWED_ORIGINS must use the same protocol as PUBLIC_ORIGIN.');
   allowedOrigins.add(allowed.origin);
  }
 }
 return {origin,allowedOrigins};
}
