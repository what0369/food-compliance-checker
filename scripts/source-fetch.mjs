export class SourceError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function failureInfo(error) {
  const code = error?.code || error?.cause?.code;
  const message = String(error?.message || error || '未知錯誤');
  if (/Timeout|Abort/.test(error?.name || '') || /TIMEOUT|TIMEDOUT/.test(code || '') || /逾時|超過.*秒/.test(message)) return { code: 'timeout', label: '連線逾時' };
  if (code === 'missing') return { code, label: '原頁失效' };
  if (code === 'blocked') return { code, label: '來源限制存取' };
  if (code === 'attachment') return { code, label: '附件無法解析' };
  if (code === 'parse' || error instanceof SyntaxError) return { code: 'parse', label: '資料格式無法解析' };
  return { code: 'network', label: '來源連線失敗' };
}

export function assertReadablePage(html) {
  if (/(?:location(?:\.href)?\s*=|location\.(?:replace|assign)\s*\()["'][^"']*(?:mode=404|\/404(?:[/?"']))/i.test(html)
    || /<title[^>]*>[^<]*(?:404|頁面不存在|找不到網頁)/i.test(html)) {
    throw new SourceError('missing', '官方原頁已失效，需核對新網址');
  }
}

// 只重試暫時性連線錯誤；404、權限限制與格式錯誤不重複請求。
export async function readSource(url, { timeout = 15_000, attempts = 2, binary = false, fetcher = fetch } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(timeout), headers: { 'User-Agent': 'food-compliance-checker/1.0' } });
      if ([404, 410].includes(response.status)) throw new SourceError('missing', '官方原頁已失效');
      if ([401, 403].includes(response.status)) throw new SourceError('blocked', '官方來源限制存取');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (binary) return new Uint8Array(await response.arrayBuffer());
      const html = await response.text();
      assertReadablePage(html);
      return html;
    } catch (error) {
      if (attempt + 1 === attempts || !['timeout', 'network'].includes(failureInfo(error).code)) throw error;
    }
  }
}

export async function settleResources(resources, loader) {
  const results = await Promise.allSettled(resources.map(loader));
  return {
    records: results.flatMap(result => result.status === 'fulfilled' ? result.value : []),
    successfulUrls: resources.filter((_, index) => results[index].status === 'fulfilled').map(item => item.url),
    failures: results.flatMap((result, index) => result.status === 'rejected' ? [{ url: resources[index].url, ...failureInfo(result.reason) }] : []),
  };
}

export function preserveFailedResources(current, previous, now, previousUpdatedAt) {
  const failed = new Set(current.failures.map(item => item.url));
  const successful = new Set(current.successfulUrls);
  const retained = previous.filter(item => failed.has(item.url) || (!successful.has(item.url) && current.discoveryFailed))
    .map(item => ({ ...item, retainedFromPrevious: true, lastRetrievedAt: item.lastRetrievedAt || previousUpdatedAt || null }));
  const fresh = current.records.map(item => ({ ...item, retainedFromPrevious: false, lastRetrievedAt: now.toISOString() }));
  return { records: [...retained, ...fresh], retainedCount: retained.length };
}

export function failureSummary(failures) {
  const groups = new Map();
  for (const failure of failures) groups.set(failure.label, (groups.get(failure.label) || 0) + 1);
  return [...groups].map(([label, count]) => `${label} ${count} 份`).join('、');
}
