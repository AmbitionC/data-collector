const PLAN_ATTENTION_ERROR = /AUTH_REQUIRED|BRIDGE_UPDATE_REQUIRED|CONTENT_EMPTY|CONTENT_COVERAGE_INCOMPLETE|AUTHOR_IDENTITY_UNPROVEN|PUBLISHED_AT_UNPROVEN|ZSXQ_API_SIGNATURE_INVALID|登录|完整状态/u;

/** Errors that require a visible, retryable plan outcome instead of an opaque failed batch. */
export function planErrorNeedsAttention(message: string): boolean {
  return PLAN_ATTENTION_ERROR.test(message);
}
