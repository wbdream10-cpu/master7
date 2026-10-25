// The deployed support portal must never expose game or money routes by accident.
// Only isolated automated tests may exercise those modules, and a host marker
// takes precedence over NODE_ENV=test so a misconfigured deployment stays safe.
const hostedMarkers = [
  'RENDER', 'RENDER_EXTERNAL_URL', 'RENDER_SERVICE_ID',
  'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_ENVIRONMENT_NAME',
  'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID',
  'VERCEL', 'NETLIFY', 'FLY_APP_NAME', 'K_SERVICE',
];

export function serviceOnlyMode(env = process.env) {
  if (env.NODE_ENV !== 'test') return true;
  return hostedMarkers.some(name => Boolean(env[name]));
}
