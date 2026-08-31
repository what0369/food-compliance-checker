import test from 'node:test';
import assert from 'node:assert/strict';
import { readSource, SourceError, assertReadablePage, failureInfo, settleResources, preserveFailedResources } from './source-fetch.mjs';
import { tainan } from './update-local-data.mjs';
import { exactReplacement, replaceAnnouncement, extractPdfText } from './update-local-announcements.mjs';
const now = new Date('2026-08-31T00:00:00Z');
const since = new Date('2025-01-01T00:00:00Z');
test('HTTP 200 的軟性404仍辨識原頁失效', () => {
  assert.throws(() => assertReadablePage('<script>location.href="/page/?mode=404";</script>'), error => error.code === 'missing');
  assert.doesNotThrow(() => assertReadablePage('<main>公告正文</main>'));
});
test('三類失敗分開標示', () => {
  assert.equal(failureInfo(new DOMException('timeout', 'TimeoutError')).code, 'timeout');
  assert.equal(failureInfo(new SourceError('missing', '404')).label, '原頁失效');
  assert.equal(failureInfo(new SourceError('attachment', '無文字')).label, '附件無法解析');
});
test('暫時錯誤重試，404不重試', async () => {
  let calls = 0;
  assert.equal(await readSource('https://test.invalid', { fetcher: async () => { if (++calls === 1) throw new TypeError('fetch failed'); return new Response('成功'); } }), '成功');
  assert.equal(calls, 2); calls = 0;
  await assert.rejects(readSource('https://test.invalid', { fetcher: async () => { calls++; return new Response('', { status: 404 }); } }), error => error.code === 'missing');
  assert.equal(calls, 1);
});
test('部分成功先收錄，失敗資源保留原擷取日期', async () => {
  const result = await settleResources([{ url: 'A' }, { url: 'B' }], async item => { if (item.url === 'B') throw new TypeError('fetch failed'); return [{ url: 'A', product: '新資料' }]; });
  const merged = preserveFailedResources(result, [{ url: 'A', product: '舊資料' }, { url: 'B', product: '保留' }], now, '2026-08-20');
  assert.equal(merged.records.length, 2);
  assert.equal(merged.retainedCount, 1);
  assert.equal(merged.records.find(x => x.url === 'B').lastRetrievedAt, '2026-08-20');
  assert.equal(merged.records.find(x => x.url === 'A').product, '新資料');
});
test('目錄整批故障保留全部；成功空清單不保留過期內容', () => {
  assert.equal(preserveFailedResources({ records: [], successfulUrls: [], failures: [{ url: '目錄' }], discoveryFailed: true }, [{ url: 'A' }, { url: 'B' }], now).retainedCount, 2);
  assert.equal(preserveFailedResources({ records: [], successfulUrls: ['A'], failures: [] }, [{ url: 'A' }], now).records.length, 0);
});
const firstId = 'e6f948cf-e7b9-4be9-9be4-f6d3992311d0';
test('臺南同資源 CSV 備援與民國日期轉換', async () => {
  const result = await tainan(since, now, async url => {
    if (url.includes(firstId)) return JSON.stringify({ data: [{ 抽驗日期: '1150108', 產品名稱: '測試產品', 受稽查廠商: '測試業者' }] });
    if (url.includes('/Api/')) throw new DOMException('timeout', 'TimeoutError');
    return '抽驗日期,產品名稱,受稽查廠商\r\n1150401,測試產品二,測試業者二';
  });
  assert.equal(result.records.length, 2);
  assert.equal(result.failures.length, 0);
  assert.equal(result.records[0].date, '2026-01-08');
  assert.equal(result.records[1].date, '2026-04-01');
  assert.equal(result.records[1].fallbackReason, '連線逾時');
  assert.match(result.records[1].downloadUrl, /ResourceCsvDownload/);
});
test('臺南某季完全失敗仍保留另一季', async () => {
  const result = await tainan(since, now, async url => {
    if (!url.includes(firstId)) throw new Error('fetch failed');
    return JSON.stringify({ data: [{ 抽驗日期: '1150108', 產品名稱: '測試產品' }] });
  });
  assert.equal(result.records.length, 1); assert.equal(result.failures.length, 1);
});
test('CSV回傳HTML不算成功', async () => {
  const result = await tainan(since, now, async url => url.includes('/Api/') ? '{}' : '<html>錯誤</html>');
  assert.equal(result.failures.length, 2); assert.equal(result.records.length, 0);
});
test('替換網址須同標題、日期、官方來源且唯一', () => {
  const original = { title: '115年4月【後市場-農藥】', date: '2026-05-07', url: 'https://www.health.ntpc.gov.tw/article/old' };
  const good = { ...original, url: 'https://www.health.ntpc.gov.tw/article/new' };
  assert.deepEqual(exactReplacement(original, [good]), good);
  for (const bad of [{ ...good, date: '2026-05-08' }, { ...good, title: '其他農藥新聞' }, { ...good, url: 'https://example.com/article/new' }]) assert.equal(exactReplacement(original, [bad]), null);
  assert.equal(exactReplacement(original, [good, { ...good, url: 'https://www.health.ntpc.gov.tw/article/another' }]), null);
});
test('成功移除舊失敗；失敗仍保留舊成功證據', () => {
  const rows = replaceAnnouncement([{ url: 'A', parseStatus: 'failed' }, { url: 'B', parseStatus: 'parsed' }], 'A', [{ url: 'A', parseStatus: 'parsed' }]);
  assert.equal(rows.length, 2); assert.equal(rows.some(x => x.parseStatus === 'failed'), false);
  const retained = replaceAnnouncement([{ url: 'A', parseStatus: 'parsed', matchable: true }], 'A', [{ url: 'A', parseStatus: 'failed', matchable: false }]);
  assert.equal(retained.filter(x => x.matchable).length, 1); assert.equal(retained[0].retainedFromPrevious, true);
});
test('損壞PDF不能當作查無違規', async () => {
  const originalFetch = globalThis.fetch;
  try { globalThis.fetch = async () => new Response('not a pdf'); await assert.rejects(extractPdfText('https://test.invalid/file.pdf'), error => error.code === 'attachment'); }
  finally { globalThis.fetch = originalFetch; }
});
