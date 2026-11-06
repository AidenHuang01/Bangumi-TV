// Tests may exercise injected mocks, but must never use a real danmaku service.
export const isDanmakuTestContext = () => Boolean(process.env.NODE_TEST_CONTEXT) || process.env.BANGUMI_NO_DANMAKU_NETWORK === '1';
export function assertDanmakuNetworkAllowed() {
  if (isDanmakuTestContext()) throw Object.assign(new Error('Live danmaku requests are disabled in tests to protect the daily API quota.'),
    { code: 'ERR_DANMAKU_TEST_NETWORK', publicMessage: '测试禁止请求在线弹幕，以保护每日 API 额度。' });
}
