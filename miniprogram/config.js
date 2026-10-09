"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isCloudEnvPlaceholder = exports.cloudEnv = void 0;
/**
 * 云开发环境配置。
 *
 * cloudEnv 是云环境 ID 占位符:部署前请替换为你自己的云环境 ID
 * (微信开发者工具 → 云开发 控制台首页可查看,形如 cloud1-xxxx)。
 * 未替换时 app.ts 会在启动时如实提示,云函数调用将无法成功。
 */
exports.cloudEnv = "mine-d2gk3n3fq609fb244";
/** cloudEnv 是否仍是占位符(用于启动时如实提醒配置缺失) */
exports.isCloudEnvPlaceholder = exports.cloudEnv === "YOUR_ENV_ID";
