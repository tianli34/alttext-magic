// P2-01: 领域常量与共享类型
/**
/**
 * 扫描知情同意文案版本号
 * 用于前端展示与后端记录用户是否已阅读最新版的扫描说明、数据留存与 AI 边界声明
 */
export const SCAN_NOTICE_VERSION = '1.3'; // 建议与意图书版本保持一致，后续随文案迭代递增
/**
 * 分布式锁默认配置（用于控制扫描/生成/写回互斥）
 */
export const LOCK_DEFAULTS = {
    /** 锁默认存活时间：30 分钟 */
    TTL_MS: 30 * 60 * 1000,
    /** 心跳续期间隔：5 分钟 */
    HEARTBEAT_INTERVAL_MS: 5 * 60 * 1000
};
/**
 * 额度初始化常量（对应意图书 P9 定价与计费策略）
 */
export const QUOTA_INIT = {
    /** 安装即赠欢迎额度 */
    WELCOME: 50,
    /** Free 计划基础月配额 */
    FREE_MONTHLY_INCLUDED: 25
};
