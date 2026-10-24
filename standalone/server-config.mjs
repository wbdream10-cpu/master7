import {webConfig} from './production.mjs';

// Imported before runtime.mjs so invalid web configuration cannot run migrations.
export const {origin,allowedOrigins}=webConfig();
