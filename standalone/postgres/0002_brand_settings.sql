ALTER TABLE portal_private.brands ADD COLUMN language TEXT NOT NULL DEFAULT 'zh-CN' CHECK (language IN ('zh-CN','en','ms'));
ALTER TABLE portal_private.brands ADD COLUMN support_url TEXT NOT NULL DEFAULT '' CHECK (length(support_url)<=1000);
