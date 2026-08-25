const LIST_URL = "https://www.fda.gov.tw/tc/csmNews.aspx";
const SOURCE_URL = "https://www.fda.gov.tw/tc/csmNews.aspx";
const RISK_TERMS = ["不合格", "不符", "違規", "超標", "下架", "回收", "裁罰", "處分", "開罰", "重罰", "問題", "異常", "查獲", "停售", "停止使用", "受影響", "流向", "自主通報"];

const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const decodeHtml = (value) => String(value ?? "")
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&nbsp;|&ensp;|&emsp;/gi, " ")
  .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
const stripHtml = (value) => text(decodeHtml(String(value ?? "")
  .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, " ")));
const compact = (value) => text(value).toLowerCase().replace(/[\s　\p{P}\p{S}]/gu, "");

async function fetchText(url) {
  const response = await fetch(url, { headers: { "User-Agent": "food-compliance-checker/1.0" }, signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`${url} 回應 HTTP ${response.status}`);
  return response.text();
}

async function createPagingSession() {
  const response = await fetch(LIST_URL, { headers: { "User-Agent": "food-compliance-checker/1.0" }, signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`${LIST_URL} 回應 HTTP ${response.status}`);
  const html = await response.text();
  const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie") || ""];
  const cookie = cookies.map((item) => item.split(";")[0]).filter(Boolean).join("; ");
  const hidden = {};
  for (const tag of html.matchAll(/<input[^>]+type="hidden"[^>]*>/gi)) {
    const name = tag[0].match(/name="([^"]+)"/i)?.[1];
    const value = tag[0].match(/value="([^"]*)"/i)?.[1] || "";
    if (name?.startsWith("__")) hidden[name] = decodeHtml(value);
  }
  const total = Number(stripHtml(html).match(/共\s*([\d,]+)\s*筆資料/)?.[1]?.replaceAll(",", "") || 0);
  return { html, cookie, hidden, totalPages: total ? Math.ceil(total / 10) : 1 };
}

async function fetchListPage(page, session) {
  if (page === 1) return parseList(session.html);
  const form = new URLSearchParams(session.hidden);
  form.set("__EVENTTARGET", "ctl00$ContentPlaceHolder1$ListPageControlBox$GoPageButton");
  form.set("__EVENTARGUMENT", "");
  form.set("ctl00$ContentPlaceHolder1$ListPageControlBox$SetPage", String(page));
  const response = await fetch(LIST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "food-compliance-checker/1.0", Cookie: session.cookie, Referer: LIST_URL },
    body: form,
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`第 ${page} 頁回應 HTTP ${response.status}`);
  return parseList(await response.text());
}

function parseList(html) {
  const items = [];
  const pattern = /<a href="(csmnewsContent\.aspx\?[^"]+)" title="([^"]*)">[\s\S]*?<\/a><\/td><td[^>]*>([\s\S]*?)<\/td><td[^>]*>(\d{4}\/\d{2}\/\d{2})<\/td>/gi;
  for (const match of html.matchAll(pattern)) {
    items.push({
      url: new URL(decodeHtml(match[1]), LIST_URL).href,
      title: stripHtml(match[2]),
      authority: stripHtml(match[3]),
      date: match[4].replaceAll("/", "-"),
    });
  }
  return items;
}

function extractCompanies(body) {
  const normalized = body.replace(/[「」『』]/g, "");
  const pattern = /([\p{Script=Han}A-Za-z0-9．・&（）()]{2,24}?(?:股份有限公司|有限公司|公司|企業社|商行|工廠))/gu;
  return [...new Set([...normalized.matchAll(pattern)].map((match) => text(match[1]).split(/[，。；：、\s]|及|與|另|為|[()（）]/).filter(Boolean).pop() || "")
    .filter((name) => name && !/本公司|該公司|業者公司|下游公司/.test(name)))];
}

function contextFor(body, company) {
  return body.split(/[。\n]/).map(text).find((sentence) => sentence.includes(company)) || body.slice(0, 500);
}

function productFor(context, company, companies, title) {
  const markers = [`${company}之`, `${company}的`, `${company}製造之`, `${company}所製`];
  const marker = markers.find((item) => context.includes(item));
  if (!marker) return title;
  let direct = context.slice(context.indexOf(marker) + marker.length);
  const stops = ["；", "。", ...companies.filter((item) => item !== company).flatMap((item) => [`及${item}之`, `與${item}之`, `、${item}之`, `，${item}之`])];
  const stopAt = stops.map((stop) => direct.indexOf(stop)).filter((index) => index >= 0).sort((a, b) => a - b)[0];
  if (stopAt !== undefined) direct = direct.slice(0, stopAt);
  return text(direct.replace(/(?:業者|均已|已經|並已).*$/g, "").replace(/[；，、]$/g, "")) || title;
}

function actionFor(body) {
  const actions = ["預防性下架回收", "停止使用並下架回收", "下架回收", "停止販售", "停止使用", "退運", "銷毀", "裁罰"];
  return actions.find((action) => body.includes(action)) || "";
}

function fallbackRecord(fallback, body = "", matchable = true) {
  return {
    kind: "地方衛生局官方食安事件",
    product: fallback.title,
    company: "",
    manufacturer: "",
    date: fallback.date,
    authority: fallback.authority,
    reason: body.slice(0, 500) || "官方公告內文暫時無法取得，請開啟來源人工確認",
    action: actionFor(body),
    url: fallback.url,
    city: fallback.authority.replace(/(?:政府)?衛生局.*$/g, "").trim(),
    sourceLayer: "食藥署國內衛生局新聞",
    media: fallback.title,
    matchable,
  };
}

export function parseHealthNewsDetail(html, fallback) {
  const title = stripHtml(html.match(/<span class="fdtitle">([\s\S]*?)<\/span>/i)?.[1]) || fallback.title;
  const meta = stripHtml(html.match(/<h3 class="dataTitle">([\s\S]*?)<\/h3>/i)?.[1]);
  const date = meta.match(/發布日期[:：]\s*(\d{4})\/(\d{2})\/(\d{2})/)?.slice(1, 4).join("-") || fallback.date;
  const authority = meta.match(/發布單位[:：]\s*([^|(]+)/)?.[1]?.trim() || fallback.authority;
  const body = stripHtml(html.match(/<div class="edit marginBot">([\s\S]*?)<\/div>/i)?.[1]);
  if (!body) return [fallbackRecord({ ...fallback, title, date, authority }, "", false)];
  const companies = extractCompanies(body);
  const action = actionFor(body);
  if (!companies.length) return [fallbackRecord({ ...fallback, title, date, authority }, body, true)];
  return companies.map((company) => {
    const context = contextFor(body, company);
    return {
      kind: "地方衛生局官方食安事件",
      product: productFor(context, company, companies, title),
      company,
      manufacturer: "",
      date,
      authority,
      reason: context.slice(0, 500),
      action,
      url: fallback.url,
      city: authority.replace(/(?:政府)?衛生局.*$/g, "").trim(),
      sourceLayer: "食藥署國內衛生局新聞",
      media: title,
      matchable: true,
    };
  });
}

async function mapConcurrent(items, limit, mapper) {
  const results = new Array(items.length); let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next; next += 1;
      try { results[index] = await mapper(items[index]); }
      catch (error) { results[index] = { error: error instanceof Error ? error.message : String(error), item: items[index] }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function withRetry(task, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await task(); }
    catch (error) { lastError = error; }
  }
  throw lastError;
}

export async function collectHealthBureauNews(now, since, previousRecords = []) {
  const previous = previousRecords.filter((item) => item.sourceLayer === "食藥署國內衛生局新聞" && new Date(item.date) >= since && new Date(item.date) <= now);
  // 第一次建立資料庫時回溯到前一年度 1 月 1 日；之後每日重掃最新頁面並保留查核期間紀錄。
  const coverageTarget = new Date(since); coverageTarget.setDate(coverageTarget.getDate() + 14);
  const hasYearCoverage = previous.some((item) => new Date(item.date) <= coverageTarget);
  // 每日重掃至足以涵蓋前一年度 1 月的頁數；既有內文不重複下載，失敗的歷史頁會自動補抓。
  const maxPages = Math.max(1, Number(process.env.HEALTH_NEWS_MAX_PAGES || 100));
  const session = await createPagingSession();
  const pages = Array.from({ length: Math.min(maxPages, session.totalPages) }, (_, index) => index + 1);
  // WebForms 分頁狀態綁定 Session；每一頁使用獨立 Session，避免平行請求互相覆蓋頁碼。
  const pageResults = await mapConcurrent(pages, 4, async (page) => withRetry(async () => page === 1 ? parseList(session.html) : fetchListPage(page, await createPagingSession())));
  const listItems = pageResults.flatMap((result) => Array.isArray(result) ? result : [])
    .filter((item) => new Date(item.date) >= since && new Date(item.date) <= now)
    .filter((item) => RISK_TERMS.some((term) => compact(item.title).includes(compact(term))))
    .filter((item) => !/(全數|全部|均|皆)合格/.test(item.title) || /不合格|超標|異常/.test(item.title));
  const existingUrls = new Set(previousRecords.filter((item) => item.sourceLayer === "食藥署國內衛生局新聞" && item.matchable !== false).map((item) => item.url));
  const freshList = [...new Map(listItems.filter((item) => !existingUrls.has(item.url)).map((item) => [item.url, item])).values()];
  const detailResults = await mapConcurrent(freshList, 5, async (item) => withRetry(async () => parseHealthNewsDetail(await fetchText(item.url), item)));
  const freshRecords = detailResults.flatMap((result) => Array.isArray(result) ? result : result?.item ? [fallbackRecord(result.item, "", false)] : []);
  const successfulUrls = new Set(detailResults.flatMap((result) => Array.isArray(result) && result.some((item) => item.matchable !== false) ? result.map((item) => item.url) : []));
  const records = [...freshRecords, ...previous.filter((item) => !(item.matchable === false && successfulUrls.has(item.url)))];
  const unique = [...new Map(records.map((item) => [`${item.url}|${compact(item.company)}|${compact(item.product)}`, item])).values()]
    .sort((a, b) => b.date.localeCompare(a.date));
  const failedPages = pageResults.filter((result) => !Array.isArray(result)).length;
  const failedDetails = detailResults.filter((result) => !Array.isArray(result)).length;
  const scannedAllPages = pages.length >= session.totalPages;
  const reachedPeriodStart = listItems.some((item) => new Date(item.date) <= coverageTarget);
  const backfillComplete = hasYearCoverage || scannedAllPages || reachedPeriodStart;
  return {
    records: unique,
    source: {
      city: "全國",
      datasetUrl: SOURCE_URL,
      mode: "食藥署國內衛生局新聞自動收集",
      status: failedPages || failedDetails ? "部分內容取得失敗" : backfillComplete ? "已連線" : "已連線（回溯中）",
      recordCount: unique.length,
      message: failedPages || failedDetails ? `清單失敗 ${failedPages} 頁、內文失敗 ${failedDetails} 篇；下次每日更新會重試` : backfillComplete ? undefined : "已收錄近期資料；下一次每日更新會繼續回溯到前一年度 1 月 1 日",
    },
  };
}
