const STORAGE_KEY = "neuroclaw.operatorId";
export const DEFAULT_OPERATOR_ID = "local_operator";

/**
 * 当前操作员身份(审批 reviewerId 来源,audit P0-D3 修复):
 * P0 尚无登录会话,先以本地持久化的操作员标识替代硬编码,
 * 后续接入 OIDC/session 时改为从服务端会话读取。
 */
export function getOperatorId(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) || DEFAULT_OPERATOR_ID;
  } catch {
    return DEFAULT_OPERATOR_ID;
  }
}

export function setOperatorId(operatorId: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, operatorId);
  } catch {
    // storage unavailable — identity stays in-memory for this page only
  }
}
