import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readSource, SourceError, failureInfo, failureSummary } from './source-fetch.mjs';

const NEW_TAIPEI_API = "https://data.ntpc.gov.tw/api/datasets/078cb722-15ac-4e1e-b541-e75bfe0aa440/json?page=0&size=10000";
const NEW_TAIPEI_SOURCE = "https://www.health.ntpc.gov.tw/basic/?node=19348";
const NEW_TAIPEI_NEWS = "https://www.health.ntpc.gov.tw/news/";
const KAOHSIUNG_LIST = "https://health.kcg.gov.tw/News.aspx?n=A354A5298C8A4AA8&sms=26BD5515159837CE";
const LOCAL_PARSE_VERSION = 2;
const RISK_TERMS = ["不合格", "不符", "違規", "超標", "下架", "回收", "裁罰", "處分", "開罰", "停止販售", "停止使用", "問題產品", "問題油"];
const FOOD_TERMS = ["食品", "食安", "食用", "抽驗", "產品", "油", "茶", "肉", "蛋", "奶", "乳", "農藥", "添加物", "重金屬", "毒素", "菌", "回收", "下架"];

const text = (value) => String(value ?? "").replace(/[\t\u00a0]+/g, " ").replace(/ +/g, " ").trim();
const decodeHtml = (value) => String(value ?? "")
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&nbsp;|&ensp;|&emsp;/gi, " ").replace(/&mu;/gi, "μ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
const stripHtml = (value) => text(decodeHtml(String(value ?? "")
  .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/p>|<\/li>|<\/tr>|<\/div>/gi, "\n").replace(/<[^>]+>/g, " ")));
const compact = (value) => text(value).toLowerCase().replace(/[\s　\p{P}\p{S}]/gu, "");
const hasRisk = (value) => RISK_TERMS.some((term) => compact(value).includes(compact(term)));
const isFoodRiskTitle = (value) => hasRisk(value) && FOOD_TERMS.some((term) => compact(value).includes(compact(term)))
  && (!/(全數|全部|均|皆)合格/.test(value) || /不合格|不符|超標/.test(value));

const fetchText = async (url) => readSource(url, { timeout: 20_000 });
const fetchJson = async (url) => JSON.parse(await fetchText(url));

function absoluteLinks(html, baseUrl, pattern = /\.pdf(?:$|[?#])/i) {
  const links = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = new URL(decodeHtml(match[1]), baseUrl).href;
      if (pattern.test(url)) links.push({ url, title: stripHtml(match[2]) || decodeURIComponent(url.split("/").pop() || "PDF 附件") });
    } catch { /* 略過無效連結 */ }
  }
  return [...new Map(links.map((item) => [item.url, item])).values()];
}

function westernDate(input) {
  const match = String(input ?? "").match(/(20\d{2})[\/.\-年]?(\d{2})[\/.\-月]?(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

function rocDate(input) {
  const match = String(input ?? "").match(/(?:^|\D)(\d{3})[\/.\-年](\d{1,2})[\/.\-月](\d{1,2})/);
  if (!match) return "";
  return `${Number(match[1]) + 1911}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function inPeriod(date, since, now) {
  if (!date) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return parsed >= since && parsed <= now;
}

function extractCompanies(body) {
  const normalized = body.replace(/[「」『』]/g, "");
  const pattern = /([\p{Script=Han}A-Za-z0-9．・&（）()]{2,32}?(?:股份有限公司|有限公司|企業社|合作社|商行|工廠|公司))/gu;
  const formal = [...normalized.matchAll(pattern)].map((match) => {
    const name = text(match[1]).split(/[，。；：、\s]|及|與|另|為|[()（）]/).filter(Boolean).pop() || "";
    return name.replace(/^.*(?:相關退換貨資訊可參考|接獲|通知|查獲|查明|列名|公告|針對|有關|參考)/, "").replace(/^查/, "");
  });
  const grouped = [...normalized.matchAll(/([^\n，。；：]{2,80})等(?:業者|公司)/gu)]
    .flatMap((match) => match[1].replace(/^.*(?:公告|列名|包括|包含|流向|轄內|針對|供應)/, "").split(/[、及與]/))
    .map((name) => text(name).replace(/^並已/, "").replace(/\d+.*$/, "")).filter((name) => name.length >= 2 && name.length <= 12);
  return [...new Set([...formal, ...grouped]).values()].filter((name) => name && !/本公司|該公司|業者公司|下游公司|衛生局|食品業者/.test(name));
}

function evidenceFor(body, company) {
  const index = body.indexOf(company);
  if (index < 0) return body.slice(0, 700);
  const start = Math.max(0, index - 260); const end = Math.min(body.length, index + company.length + 420);
  return text(body.slice(start, end));
}

function productFor(context, title) {
  const direct = context.match(/(?:生產之|製造之|所製|品名(?:為|是|：)?|產品(?:為|是|：)?)[「『\"]?([^，。；;、()（）「」『』\"]{2,45})/)?.[1];
  if (direct && !/規定|標準|指引|食品安全衛生管理法|下架|回收|停止|裁罰/.test(direct)) return text(direct);
  const titleProduct = title.match(/([^，。；：]{2,50}?)(?:檢出|不合格|超標)/)?.[1]
    ?.replace(/^.*(?:自主通報|接獲|抽驗|追蹤|查獲)/, "").replace(/^.*公司/, "");
  if (titleProduct && titleProduct.length <= 20) return text(titleProduct);
  const quoted = [...context.matchAll(/[「『\"]([^」』\"]{2,60})[」』\"]/g)]
    .map((match) => text(match[1])).find((value) => value.length <= 20 && FOOD_TERMS.some((term) => value.includes(term)) && !/規定|標準|指引|食安|食品安全衛生管理法|下架|回收|停止|裁罰/.test(value));
  return quoted || title;
}

function actionFor(body) {
  const actions = ["停止販售並下架回收", "停止使用並下架回收", "預防性下架回收", "下架回收", "停止販售", "停止使用", "退運", "銷毀", "裁罰"];
  const direct = actions.find((action) => body.includes(action));
  if (direct) return direct;
  if (/下架[、，並及\s]*(?:封存[、，並及\s]*)?回收/.test(body)) return "下架回收";
  if (/停止販售|停止銷售/.test(body)) return "停止販售";
  return "";
}

function checkpoint(metadata) {
  return { kind: "地方衛生局官方食安事件", product: metadata.title, company: "", manufacturer: "", date: metadata.date, authority: metadata.authority, reason: "已解析公告與附件，未發現可納入自動比對的不合格證據", action: "", url: metadata.url, city: metadata.city, sourceLayer: metadata.sourceLayer, media: metadata.title, parseStatus: "qualified", parseVersion: LOCAL_PARSE_VERSION, matchable: false };
}

function relevantRiskText(body) {
  const pages = body.split(/\n\f\n/).map(text).filter(Boolean);
  const selected = pages.filter((page) => hasRisk(page) && !(/(?:全數|全部|均|皆)合格/.test(page) && !/不合格|不符|超標/.test(page)));
  return text((selected.length ? selected : hasRisk(body) ? [body] : []).join("\n"));
}

export function recordsFromDocument(body, metadata) {
  const riskText = relevantRiskText(body);
  if (!riskText) return [];
  const searchableText = `${metadata.title}\n${riskText}`;
  const companies = extractCompanies(searchableText);
  const base = {
    kind: "地方衛生局官方食安事件",
    manufacturer: "",
    date: metadata.date,
    authority: metadata.authority,
    action: actionFor(riskText),
    url: metadata.url,
    city: metadata.city,
    sourceLayer: metadata.sourceLayer,
    media: metadata.title,
    attachmentUrl: metadata.attachmentUrl || "",
    parseStatus: "parsed",
    parseVersion: LOCAL_PARSE_VERSION,
    matchable: true,
  };
  if (!companies.length) return [{ ...base, product: metadata.title, company: "", reason: riskText.slice(0, 900) }];
  return companies.map((company) => {
    const evidence = evidenceFor(searchableText, company);
    return { ...base, product: productFor(evidence, metadata.title), company, reason: evidence.slice(0, 900) };
  });
}

export async function extractPdfText(url) {
  const data = await readSource(url, { timeout: 30_000, binary: true });
  if (data.byteLength > 25 * 1024 * 1024) throw new SourceError('attachment', "PDF 超過 25 MB 上限");
  let document;
  try { document = await getDocument({ data, disableWorker: true, isEvalSupported: false }).promise; }
  catch { throw new SourceError('attachment', '附件不是可讀取的 PDF'); }
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines = new Map();
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const y = Math.round(item.transform?.[5] || 0);
        const x = item.transform?.[4] || 0;
        const line = lines.get(y) || [];
        line.push({ x, width: item.width || 0, value: item.str }); lines.set(y, line);
      }
      pages.push([...lines.entries()].sort((a, b) => b[0] - a[0]).map(([, line]) => {
        const ordered = line.sort((a, b) => a.x - b.x);
        return ordered.reduce((result, item, index) => {
          if (!index) return item.value;
          const previous = ordered[index - 1]; const gap = item.x - (previous.x + previous.width);
          return `${result}${gap <= 2 ? "" : gap <= 12 ? " " : " | "}${item.value}`;
        }, "");
      }).join("\n"));
    }
  } catch { throw new SourceError('attachment', 'PDF 文字解析失敗'); }
  finally { await document.destroy(); }
  const body = pages.join("\n\f\n");
  if (!body.trim()) throw new SourceError('attachment', 'PDF 沒有可讀文字，需人工確認或文字辨識');
  return body;
}

function newTaipeiDate(item) {
  return westernDate(item.date) || westernDate(decodeURIComponent(item.domainname || ""));
}

async function parseNewTaipeiItem(item) {
  const date = newTaipeiDate(item);
  const title = text(item.filename);
  const sourceUrl = item.domainname;
  let body = ""; let pdfs = [];
  if (/\.pdf(?:$|[?#])/i.test(sourceUrl)) pdfs = [{ url: sourceUrl, title }];
  else {
    const html = await fetchText(sourceUrl);
    const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] || html.match(/<div[^>]+class=["'][^"']*content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || "";
    body = stripHtml(main);
    pdfs = absoluteLinks(main || html, sourceUrl);
  }
  if (!body && !pdfs.length) throw new SourceError('parse', "公告頁未提供可解析正文或 PDF");
  const records = [];
  if (hasRisk(body)) records.push(...recordsFromDocument(body, { title, date, authority: "新北市政府衛生局", city: "新北市", sourceLayer: "新北市衛生局公告／PDF", url: sourceUrl }));
  for (const pdf of pdfs) {
    const pdfBody = await extractPdfText(pdf.url);
    records.push(...recordsFromDocument(pdfBody, { title: pdf.title || title, date, authority: "新北市政府衛生局", city: "新北市", sourceLayer: "新北市衛生局公告／PDF", url: sourceUrl, attachmentUrl: pdf.url }));
  }
  return records.length ? records : [checkpoint({ title, date, authority: "新北市政府衛生局", city: "新北市", sourceLayer: "新北市衛生局公告／PDF", url: sourceUrl })];
}

export function parseNewTaipeiNewsList(html) {
  const items = [];
  const pattern = /<span[^>]+class=["'][^"']*date[^"']*["'][^>]*>(\d{2})\.(\d{2})<\/span>[\s\S]*?<span[^>]+class=["'][^"']*yymm[^"']*["'][^>]*>\s*(\d{4})\s*<\/span>[\s\S]*?<h3[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) items.push({ date: `${match[3]}-${match[1]}-${match[2]}`, url: new URL(decodeHtml(match[4]), NEW_TAIPEI_NEWS).href, title: stripHtml(match[5]) });
  return items;
}

export function parseNewTaipeiNewsDetail(html, fallback) {
  const title = stripHtml(html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1]) || fallback.title;
  const date = westernDate(stripHtml(html.match(/發布日期([\s\S]*?)<\/li>/i)?.[1])) || fallback.date;
  const bodyHtml = html.match(/<div[^>]+class=["'][^"']*entry-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || "";
  return { title, date, body: stripHtml(bodyHtml), pdfs: absoluteLinks(html, fallback.url) };
}

async function newTaipeiNewsItems(now, since) {
  const dateStart = since.toISOString().slice(0, 10); const dateEnd = now.toISOString().slice(0, 10);
  const found = [];
  for (const keyword of ["不合格", "不符", "超標", "下架", "回收"]) {
    for (let page = 1; page <= 10; page += 1) {
      const params = new URLSearchParams({ date_start: dateStart, date_end: dateEnd, keywords: keyword, mode: "search", language: "tw" });
      const url = `${NEW_TAIPEI_NEWS}${page > 1 ? `${page}/` : ""}?${params}`;
      const items = parseNewTaipeiNewsList(await fetchText(url));
      found.push(...items);
      if (!items.length) break;
    }
  }
  return [...new Map(found.filter((item) => inPeriod(item.date, since, now) && isFoodRiskTitle(item.title)).map((item) => [item.url, item])).values()];
}

async function parseNewTaipeiNewsItem(item) {
  const detail = parseNewTaipeiNewsDetail(await fetchText(item.url), item);
  if (!detail.body && !detail.pdfs.length) throw new SourceError('parse', "新聞公告未提供可解析正文或 PDF");
  const combined = [detail.body];
  for (const pdf of detail.pdfs) combined.push(await extractPdfText(pdf.url));
  const parsed = recordsFromDocument(combined.join("\n\f\n"), { title: detail.title, date: detail.date, authority: "新北市政府衛生局", city: "新北市", sourceLayer: "新北市衛生局公告／PDF", url: item.url, attachmentUrl: detail.pdfs.map((pdf) => pdf.url).join("｜") });
  return parsed.length ? parsed : [checkpoint({ title: detail.title, date: detail.date, authority: "新北市政府衛生局", city: "新北市", sourceLayer: "新北市衛生局公告／PDF", url: item.url })];
}

export function parseKaohsiungList(html) {
  const items = [];
  const rowPattern = /<tr[^>]*>[\s\S]*?<p>(\d{3})-(\d{2})-(\d{2})<\/p>[\s\S]*?<a[^>]+href=["']([^"']*News_Content\.aspx[^"']+)["'][^>]*title=["']([^"']+)["']/gi;
  for (const match of html.matchAll(rowPattern)) {
    items.push({ date: `${Number(match[1]) + 1911}-${match[2]}-${match[3]}`, url: new URL(decodeHtml(match[4]), KAOHSIUNG_LIST).href, title: stripHtml(match[5]).replace(/\[另開新視窗\]$/, "") });
  }
  return items;
}

export function parseKaohsiungDetail(html, fallback) {
  const rawTitle = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const title = rawTitle.replace(/^.*?衛生局[-－]\s*/, "") || fallback.title;
  const date = rocDate(stripHtml(html.match(/資料更新時間[：:]([\s\S]*?)<\/ul>/i)?.[1])) || fallback.date;
  const bodyHtml = html.match(/<div[^>]+class=["'][^"']*data_midlle_news_box02[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || "";
  const imageText = [...html.matchAll(/<(?:img|a)\b[^>]*(?:alt|title)=["']([^"']+)["'][^>]*>/gi)].map((match) => decodeHtml(match[1])).filter(hasRisk).join("\n");
  return { title, date, body: text(`${stripHtml(bodyHtml)}\n${imageText}`), pdfs: absoluteLinks(html, fallback.url) };
}

const announcementKey = title => compact(title).replace(/^新北市政府衛生局食品抽驗名冊/, '').replace(/名冊$/, '');

export function exactReplacement(original, candidates) {
  const matches = candidates.filter(candidate => {
    try {
      const url = new URL(candidate.url);
      return url.origin === 'https://www.health.ntpc.gov.tw' && /^\/(?:article|news)\//.test(url.pathname)
        && url.href !== new URL(original.url).href && candidate.date === original.date
        && announcementKey(candidate.title) === announcementKey(original.title);
    } catch { return false; }
  });
  const unique = [...new Map(matches.map(item => [new URL(item.url).href, item])).values()];
  return unique.length === 1 ? unique[0] : null;
}

export function replaceAnnouncement(records, originalUrl, replacements) {
  // 同一公告的新結果取代舊失敗標記；其他公告及人工核准資料不動。
  const urls = new Set([originalUrl, ...replacements.map(item => item.url)]);
  const retained = replacements.every(item => item.parseStatus === 'failed')
    ? records.filter(item => urls.has(item.url) && item.parseStatus !== 'failed').map(item => ({ ...item, retainedFromPrevious: true })) : [];
  return [...records.filter(item => !urls.has(item.url) && item.originalUrl !== originalUrl), ...retained, ...replacements];
}

function failedAnnouncement(item, error, city) {
  const failure = failureInfo(error);
  const next = failure.code === 'missing' ? '未確認同一公告的新網址，保留待確認，不作違規判定' : '下次更新會重試；未取得資料仍待確認';
  return { kind: '地方衛生局官方食安事件', product: item.title, company: '', manufacturer: '', date: item.date, authority: `${city}政府衛生局`, reason: `${failure.label}；${next}`, action: '', url: item.url, city, sourceLayer: `${city}衛生局公告／PDF`, media: item.title, parseStatus: 'failed', parseVersion: LOCAL_PARSE_VERSION, matchable: false, failureCode: failure.code, parseMessage: failure.label };
}

async function recoverNewTaipei(item, candidates, searchCache) {
  let candidate = exactReplacement(item, candidates);
  if (!candidate) {
    const params = new URLSearchParams({ keywords: item.title, mode: 'search', language: 'tw' });
    if (!searchCache.has(item.title)) searchCache.set(item.title, fetchText(`${NEW_TAIPEI_NEWS}?${params}`).then(parseNewTaipeiNewsList).catch(() => []));
    candidate = exactReplacement(item, await searchCache.get(item.title));
  }
  if (!candidate) return null;
  // 再讀候選正文核對日期及標題，不能只靠搜尋結果相似就改網址。
  const detail = parseNewTaipeiNewsDetail(await fetchText(candidate.url), { title: '', date: '', url: candidate.url });
  if (detail.date !== item.date || announcementKey(detail.title) !== announcementKey(item.title)) return null;
  const parsed = new URL(candidate.url).pathname.startsWith('/news/')
    ? await parseNewTaipeiNewsItem(candidate)
    : await parseNewTaipeiItem({ filename: candidate.title, date: candidate.date, domainname: candidate.url });
  return parsed.map(record => ({ ...record, originalUrl: item.url, recoveryNote: '已核對官方公告標題與發布日期，更新原失效網址' }));
}

async function collectNewTaipei(now, since, previousRecords) {
  const lists = await Promise.allSettled([fetchJson(NEW_TAIPEI_API), newTaipeiNewsItems(now, since)]);
  const listFailures = lists.flatMap((result, index) => result.status === 'rejected' ? [{ url: index ? NEW_TAIPEI_NEWS : NEW_TAIPEI_API, ...failureInfo(result.reason) }] : []);
  const items = lists[0].status === 'fulfilled' ? lists[0].value.filter(item => inPeriod(newTaipeiDate(item), since, now)) : [];
  const newsItems = lists[1].status === 'fulfilled' ? lists[1].value : [];
  const successful = new Set(previousRecords.filter((item) => item.sourceLayer === "新北市衛生局公告／PDF" && item.parseVersion === LOCAL_PARSE_VERSION && item.parseStatus !== "failed").map((item) => item.url));
  let records = previousRecords.filter(item => item.sourceLayer === '新北市衛生局公告／PDF' && inPeriod(item.date, since, now));
  for (const record of records) if (record.parseStatus !== 'failed' && record.originalUrl) successful.add(record.originalUrl);
  for (const record of records) if (record.parseStatus === 'failed') successful.delete(record.url);
  const candidates = [...items.map(item => ({ title: item.filename, date: newTaipeiDate(item), url: item.domainname, api: item })), ...newsItems];
  // 即使清單暫時漏列，之前失敗的公告仍保留在重試佇列。
  for (const record of records.filter(item => item.parseStatus === 'failed')) if (!candidates.some(item => item.url === record.url)) candidates.push({ title: record.media || record.product, date: record.date, url: record.url, api: { filename: record.media || record.product, date: record.date, domainname: record.url } });
  const searchCache = new Map();
  for (const item of [...new Map(candidates.map(item => [item.url, item])).values()].filter(item => !successful.has(item.url))) {
    try {
      const parsed = item.api ? await parseNewTaipeiItem(item.api) : await parseNewTaipeiNewsItem(item);
      records = replaceAnnouncement(records, item.url, parsed);
    } catch (error) {
      const recovered = failureInfo(error).code === 'missing' ? await recoverNewTaipei(item, candidates, searchCache).catch(() => null) : null;
      records = replaceAnnouncement(records, item.url, recovered || [failedAnnouncement(item, error, '新北市')]);
    }
  }
  const failures = [...listFailures, ...records.filter(item => item.parseStatus === 'failed').map(item => ({ url: item.url, code: item.failureCode || 'parse', label: item.parseMessage || '資料格式無法解析' }))];
  return { records, source: { city: '新北市', datasetUrl: NEW_TAIPEI_NEWS, mode: '公告與 PDF 內文自動解析', status: failures.length ? '部分內容取得失敗' : '已連線', recordCount: records.filter(item => item.matchable !== false).length, failures, message: failures.length ? `${failureSummary(failures)}；已成功收錄的資料保留，未取得資料仍待確認` : undefined } };
}

async function collectKaohsiung(now, since, previousRecords) {
  const maxPages = Math.max(1, Number(process.env.KAOHSIUNG_NEWS_MAX_PAGES || 30));
  const listItems = []; let failedLists = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    try {
      const url = `${KAOHSIUNG_LIST}&page=${page}&PageSize=100`;
      const items = parseKaohsiungList(await fetchText(url));
      listItems.push(...items);
      if (!items.length || items.some((item) => new Date(`${item.date}T00:00:00Z`) < since)) break;
    } catch { failedLists += 1; }
  }
  const candidates = [...new Map(listItems.filter((item) => inPeriod(item.date, since, now) && isFoodRiskTitle(item.title)).map((item) => [item.url, item])).values()];
  const successful = new Set(previousRecords.filter((item) => item.sourceLayer === "高雄市衛生局公告／PDF" && item.parseVersion === LOCAL_PARSE_VERSION && item.parseStatus !== "failed").map((item) => item.url));
  let records = previousRecords.filter((item) => item.sourceLayer === "高雄市衛生局公告／PDF" && inPeriod(item.date, since, now));
  for (const record of records.filter(item => item.parseStatus === 'failed')) {
    successful.delete(record.url);
    if (!candidates.some(item => item.url === record.url)) candidates.push({ title: record.media || record.product, date: record.date, url: record.url });
  }
  let failedDetails = 0;
  for (const item of candidates.filter((candidate) => !successful.has(candidate.url))) {
    try {
      const detail = parseKaohsiungDetail(await fetchText(item.url), item);
      if (!detail.body && !detail.pdfs.length) throw new SourceError('parse', '公告缺少正文或 PDF');
      const combined = [detail.body];
      for (const pdf of detail.pdfs) combined.push(await extractPdfText(pdf.url));
      const parsed = recordsFromDocument(combined.join("\n\f\n"), { title: detail.title, date: detail.date, authority: "高雄市政府衛生局", city: "高雄市", sourceLayer: "高雄市衛生局公告／PDF", url: item.url, attachmentUrl: detail.pdfs.map((pdf) => pdf.url).join("｜") });
      records = replaceAnnouncement(records, item.url, parsed.length ? parsed : [checkpoint({ title: detail.title, date: detail.date, authority: "高雄市政府衛生局", city: "高雄市", sourceLayer: "高雄市衛生局公告／PDF", url: item.url })]);
    } catch (error) { failedDetails += 1; records = replaceAnnouncement(records, item.url, [failedAnnouncement(item, error, '高雄市')]); }
  }
  failedDetails = records.filter(item => item.parseStatus === 'failed').length;
  const failed = failedLists + failedDetails;
  return { records, source: { city: "高雄市", datasetUrl: KAOHSIUNG_LIST, mode: "公告與 PDF 內文自動解析", status: failed ? "部分內容取得失敗" : "已連線", recordCount: records.filter((item) => item.matchable !== false).length, message: failed ? `清單失敗 ${failedLists} 頁、公告或 PDF 失敗 ${failedDetails} 篇；下次每日更新會重試` : undefined } };
}

export async function collectLocalAnnouncements(now, since, previousRecords = []) {
  const results = await Promise.allSettled([collectNewTaipei(now, since, previousRecords), collectKaohsiung(now, since, previousRecords)]);
  const fallbackSources = [
    { city: "新北市", datasetUrl: NEW_TAIPEI_SOURCE, mode: "公告與 PDF 內文自動解析" },
    { city: "高雄市", datasetUrl: KAOHSIUNG_LIST, mode: "公告與 PDF 內文自動解析" },
  ];
  return results.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    const records = previousRecords.filter(item => item.sourceLayer === `${fallbackSources[index].city}衛生局公告／PDF` && inPeriod(item.date, since, now));
    return { records, source: { ...fallbackSources[index], status: '本次更新失敗', recordCount: records.filter(item => item.matchable !== false).length, message: `${failureInfo(result.reason).label}；保留上次成功資料，未取得資料仍待確認` } };
  });
}
