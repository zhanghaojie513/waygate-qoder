/**
 * Qoder CN 客户端登录态 → 凭证明文。
 *
 * 客户端把登录态放在 Chromium 的 `auth.v1.dat`（os_crypt v10：AES-256-GCM，密钥由
 * Windows DPAPI 保护）。解密链（与社区实现同源、本项目生产验证过）：
 *   Local State 的 `os_crypt.encrypted_key`（base64，去 5 字节前缀 "DPAPI"）
 *     → PowerShell 调 DPAPI Unprotect（CurrentUser）→ 32 字节 AES key
 *     → 解 auth.v1.dat：[3B "v10"][12B nonce][ct…][16B tag]
 *
 * 只读本机文件、只在本机解密；令牌仅写到本机 `~/.waygate/qoc/`，不上传任何地方。
 */
/** Qoder 客户端身份材料（`providers/<id>.key` 的同形 JSON）。 */
export interface QoderIdentity {
    /** 访问令牌（`dt-…`）。 */
    token: string;
    /** 刷新令牌（`drt-…`）。 */
    refreshToken: string;
    uid: string;
    name: string;
    userType: string;
}
/** 客户端数据目录（可用 QODER_APP_DIR 覆盖，便于便携部署/异机取证）。 */
export declare function qoderAppDir(): string;
/** 平台是否支持（DPAPI 是 Windows 专有）。 */
export declare function isSupportedPlatform(): boolean;
/**
 * 从本机客户端登录态解出身份材料。
 * 失败一律抛 `CredentialError`（人话描述，CLI 直接展示，不抛栈）。
 */
export declare function readQoderIdentity(): QoderIdentity;
