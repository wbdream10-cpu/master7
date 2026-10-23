import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const notices=sqliteTable('notices',{id:text('id').primaryKey(),tenantId:text('tenant_id').notNull().default('main'),title:text('title').notNull(),body:text('body').notNull(),published:integer('published',{mode:'boolean'}).notNull().default(false),createdAt:text('created_at').notNull()});
export const tickets=sqliteTable('tickets',{id:text('id').primaryKey(),tenantId:text('tenant_id').notNull().default('main'),userId:text('user_id').notNull(),name:text('name').notNull(),subject:text('subject').notNull(),body:text('body').notNull(),status:text('status').notNull().default('待处理'),reply:text('reply').notNull().default(''),createdAt:text('created_at').notNull()});
export const audit=sqliteTable('audit',{id:text('id').primaryKey(),tenantId:text('tenant_id').notNull().default('main'),actor:text('actor').notNull(),action:text('action').notNull(),createdAt:text('created_at').notNull()});

export const brands=sqliteTable('brands',{id:text('id').primaryKey(),name:text('name').notNull(),tagline:text('tagline').notNull().default('欢迎来到服务中心'),color:text('color').notNull().default('#2165e8'),logo:text('logo').notNull().default(''),language:text('language',{enum:['zh-CN','en','ms']}).notNull().default('zh-CN'),supportUrl:text('support_url').notNull().default(''),createdAt:text('created_at').notNull()});
export const members=sqliteTable('members',{email:text('email').primaryKey(),tenantId:text('tenant_id').notNull(),createdAt:text('created_at').notNull()});
// Minimal server-side identity projections used when headquarters assigns an
// already-approved main member to a named brand. Password and recovery fields
// deliberately remain outside this API module.
export const portalUsers=sqliteTable('portal_users',{id:text('id').primaryKey(),email:text('email').notNull(),role:text('role').notNull()});
export const portalSessions=sqliteTable('portal_sessions',{tokenHash:text('token_hash').primaryKey(),userId:text('user_id').notNull()});
export const portalStaff=sqliteTable('portal_staff',{userId:text('user_id').primaryKey(),tenantId:text('tenant_id').notNull(),role:text('role').notNull()});
