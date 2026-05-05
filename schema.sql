-- ============================================================
--  成绩查询系统 D1 数据库初始化脚本
--  使用方式：
--    wrangler d1 execute <DB_NAME> --file=schema.sql
-- ============================================================

-- 配置表（替代原来的 config:* KV key）
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 成绩表（核心数据）
-- exam_id + uid 联合主键，天然支持 UPSERT，无需先查后写
CREATE TABLE IF NOT EXISTS scores (
  exam_id   TEXT    NOT NULL,
  uid       TEXT    NOT NULL,
  fields    TEXT    NOT NULL DEFAULT '{}',   -- JSON，存储动态学生信息字段
  direction TEXT    NOT NULL DEFAULT '',
  scores    TEXT    NOT NULL DEFAULT '{}',   -- JSON，存储各科成绩
  PRIMARY KEY (exam_id, uid)
);

-- uid 索引：加速"查某学生全部历史成绩"（/api/pub/query 历史记录功能）
CREATE INDEX IF NOT EXISTS idx_scores_uid ON scores(uid);

-- exam_id 索引：加速"按批次列出/删除成绩"（管理后台 list / deleteExam）
CREATE INDEX IF NOT EXISTS idx_scores_exam ON scores(exam_id);
