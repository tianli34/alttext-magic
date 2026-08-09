-- AltCandidateStatus 枚举值 MISSING 更名为 INITIAL(语义对齐:初始态而非"缺失")
-- RENAME VALUE 自动更新存量数据并保持枚举顺序;列默认值需显式更新
ALTER TYPE "AltCandidateStatus" RENAME VALUE 'MISSING' TO 'INITIAL';

ALTER TABLE "alt_candidate" ALTER COLUMN "status" SET DEFAULT 'INITIAL';
