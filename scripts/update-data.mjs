import { readFile, writeFile } from "node:fs/promises";
import { updateLocalOfficial } from "./update-local-data.mjs";
import { applyNewsCorrections, loadNewsCorrections, restoreNewsOriginal } from "./news-corrections.mjs";

const ADS_URL = "https://data.fda.gov.tw/data/opendata/22/json";
const IMPORTS_URL = "https://data.fda.gov.tw/data/opendata/52/json";
const ADS_PAGE = "https://data.gov.tw/dataset/6949";
const IMPORTS_PAGE = "https://data.gov.tw/dataset/6133";
const NEWS_FILE = new URL("../public/data/news.json", import.meta.url);
const OFFICIAL_FILE = new URL("../public/data/official.json", import.meta.url);
const RISK_TERMS = ["違規", "裁罰", "誇大", "下架", "不合格", "回收", "處分", "遭罰", "開罰"];
const ARTICLE_PARSE_LIMIT = 60;
const NEWS_PARSE_VERSION = 2;
const COMPANY_SUFFIX = "(?:股份有限公司|有限公司|企業社|商行|商號|油行|油廠|食品廠|工廠|合作社|農場|實業|企業|公司)";

const value = (row, key) => String(row[key] ?? "").trim();
const compact = (text) => String(text).toLowerCase().replace(/[\s　\p{P}\p{S}]/gu, "");
const decodeXml = (text) => text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const tag = (item, name) => decodeXml(item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"))?.[1]?.trim() || "");
const decodeHtml = (text) => String(text || "")
  .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;|&#34;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
const stripHtml = (html) => decodeHtml(String(html || "").replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const uniqueText = (items, limit = 12) => [...new Set(items.map((item) => String(item || "").replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, limit);

function jsonLdArticles(html) {
  const found = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
    if (types.some((type) => /(?:NewsArticle|Article|ReportageNewsArticle)/i.test(String(type || "")))) found.push(node);
    Object.values(node).forEach(visit);
  };
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(decodeHtml(match[1]).trim())); } catch { /* 部分網站的 JSON-LD 並非合法 JSON */ }
  }
  return found;
}

function metaContent(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i"),
  ];
  return decodeHtml(patterns.map((pattern) => html.match(pattern)?.[1]).find(Boolean) || "").trim();
}

function articleTextFromHtml(html) {
  const articles = jsonLdArticles(html);
  const structuredBody = articles.map((item) => item.articleBody || item.description).find((item) => typeof item === "string" && item.length >= 80);
  if (structuredBody) return stripHtml(structuredBody);
  const articleHtml = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] || html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] || "";
  const paragraphs = [...(articleHtml || html).matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((match) => stripHtml(match[1])).filter((text) => text.length >= 20);
  const body = paragraphs.join(" ");
  return body.length >= 100 ? body : metaContent(html, "description") || metaContent(html, "og:description");
}

function externalArticleUrl(html, fallback) {
  const normalized = html.replace(/\\u0026/g, "&").replace(/\\u003d/g, "=").replace(/\\\//g, "/");
  const candidates = [
    ...[...normalized.matchAll(/data-n-au=["'](https?:\/\/[^"']+)["']/gi)].map((match) => match[1]),
    ...[...normalized.matchAll(/<a[^>]+href=["'](https?:\/\/[^"']+)["']/gi)].map((match) => match[1]),
  ].map(decodeHtml).filter((url) => {
    try { const host = new URL(url).hostname; return !/(^|\.)(google|googleusercontent|gstatic|youtube)\./i.test(host); } catch { return false; }
  });
  return candidates[0] || fallback;
}

async function decodeGoogleNewsUrl(sourceUrl, signal) {
  const parsed = new URL(sourceUrl);
  const parts = parsed.pathname.split("/").filter(Boolean);
  const id = parts.at(-1);
  if (!id || !["articles", "read"].includes(parts.at(-2))) throw new Error("不是可解析的 Google 新聞網址");
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.7",
  };
  const paramsResponse = await fetch(`https://news.google.com/rss/articles/${id}`, { headers, signal });
  if (!paramsResponse.ok) throw new Error(`Google 新聞解碼參數 HTTP ${paramsResponse.status}`);
  const paramsHtml = await paramsResponse.text();
  const signature = paramsHtml.match(/data-n-a-sg=["']([^"']+)["']/i)?.[1];
  const timestamp = paramsHtml.match(/data-n-a-ts=["']([^"']+)["']/i)?.[1];
  if (!signature || !timestamp) throw new Error("Google 新聞未提供解碼參數");
  const request = ["Fbv4je", `["garturlreq",[["X","X",["X","X"],null,null,1,1,"TW:zh-Hant",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${timestamp},"${signature}"]`];
  const response = await fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
    method: "POST", signal,
    headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "Origin": "https://news.google.com", "Referer": "https://news.google.com/" },
    body: `f.req=${encodeURIComponent(JSON.stringify([[request]]))}`,
  });
  if (!response.ok) throw new Error(`Google 新聞解碼 HTTP ${response.status}`);
  const payload = await response.text();
  for (const chunk of payload.split("\n\n")) {
    try {
      const rows = JSON.parse(chunk);
      for (const row of rows) {
        if ((row?.[0] === "wrb.fr" || row?.[0] === "w779db") && row?.[1] === "Fbv4je") {
          const decoded = JSON.parse(row[2])?.[1];
          if (/^https?:\/\//.test(decoded)) return decoded;
        }
      }
    } catch { /* 回應中混有長度標記，不是每段都是 JSON */ }
  }
  throw new Error("Google 新聞沒有回傳原始網址");
}

async function fetchArticle(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const originalUrl = /news\.google\.com$/i.test(new URL(url).hostname) ? await decodeGoogleNewsUrl(url, controller.signal) : url;
    let response = await fetch(originalUrl, { redirect: "follow", signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; food-compliance-checker/1.0; +https://github.com/what0369/food-compliance-checker)", "Accept-Language": "zh-TW,zh;q=0.9" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    let html = await response.text();
    let articleUrl = response.url || originalUrl;
    if (/news\.google\.com$/i.test(new URL(articleUrl).hostname)) {
      const resolved = externalArticleUrl(html, "");
      if (!resolved) throw new Error("Google 新聞未提供可讀取的原始網址");
      response = await fetch(resolved, { redirect: "follow", signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; food-compliance-checker/1.0)", "Accept-Language": "zh-TW,zh;q=0.9" } });
      if (!response.ok) throw new Error(`原文 HTTP ${response.status}`);
      html = await response.text(); articleUrl = response.url || resolved;
    }
    const text = articleTextFromHtml(html).slice(0, 60_000);
    if (text.length < 100) throw new Error("原文沒有可解析的內文");
    return { articleUrl, text };
  } finally { clearTimeout(timer); }
}

function extractEntities(title, articleText) {
  const text = `${title}。${articleText}`.replace(/\s+/g, " ");
  const companies = uniqueText([
    ...[...text.matchAll(new RegExp(`(?:製造商|製造業者|進口商|供應商|來源業者|原料來源|油品來源|販售業者|業者|委製商|委託|出品)(?:為|是)?[：:、，,\\s「『]*(.{2,28}?${COMPANY_SUFFIX})`, "g"))].map((match) => match[1]),
    ...[...text.matchAll(new RegExp(`(?:^|[「『（(、，,；;。：:\\s])([\p{Script=Han}A-Za-z0-9．・&（）()\-]{2,20}${COMPANY_SUFFIX})`, "gu"))].map((match) => match[1]),
  ].map((item) => item.replace(/^[為是「『（(、，,：:\s]+|[」』）)、，,。；;：:\s]+$/g, "")), 15);
  const labelledProducts = [...text.matchAll(/(?:產品|商品|品名|不合格品項|下架品項|回收品項|抽驗品項)[為是：:\s「『]*([^。；;，,]{2,45})/g)].map((match) => match[1]);
  const quotedProducts = [...text.matchAll(/[「『]([^」』]{2,35})[」』]/g)].map((match) => match[1]).filter((item) => RISK_TERMS.some((term) => text.includes(`${item}`)) && !/衛生局|食藥署|政府|新聞/.test(item));
  const products = uniqueText([...labelledProducts, ...quotedProducts].map((item) => item.replace(/(?:等|共\d+件|遭.*|被.*)$/g, "").trim()).filter((item) => item.length <= 45 && !/^(?:共計|均已|是否|應|管理|規定|限量|回收|下架|調查|來源|食品添加物|登錄|業者)/.test(item)), 15);
  const brands = uniqueText([...text.matchAll(/(?:品牌|牌名)[為是：:\s「『]*([^。；;，,」』]{2,30})/g)].map((match) => match[1]), 10);
  const sentences = text.split(/(?<=[。！？!?；;])\s*/).map((item) => item.trim()).filter((item) => item.length >= 12 && item.length <= 260);
  const names = [...companies, ...products, ...brands];
  const evidence = uniqueText(sentences.filter((sentence) => RISK_TERMS.some((term) => sentence.includes(term)) && (names.length === 0 || names.some((name) => sentence.includes(name)))).map((sentence) => sentence.slice(0, 220)), 3);
  return { products, companies, brands, evidence };
}

async function enrichNewsItem(item) {
  try {
    const { articleUrl, text } = await fetchArticle(item.url);
    const entities = extractEntities(item.title, text);
    const { parseMessage: _oldMessage, ...cleanItem } = item;
    return { ...cleanItem, articleUrl, parseStatus: "parsed", parseVersion: NEWS_PARSE_VERSION, parsedAt: new Date().toISOString(), ...entities };
  } catch (error) {
    const entities = extractEntities(item.title, "");
    return { ...item, parseStatus: "titleOnly", parseVersion: NEWS_PARSE_VERSION, parsedAt: new Date().toISOString(), parseMessage: error instanceof Error ? error.message.slice(0, 160) : "無法解析新聞內文", ...entities };
  }
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length); let cursor = 0;
  async function worker() { while (cursor < items.length) { const index = cursor++; results[index] = await mapper(items[index], index); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function parseDate(input) {
  const normalized = String(input || "").replace(/\s+/g, " ").trim();
  const parsed = new Date(normalized);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  const ymd = normalized.match(/(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})/);
  if (ymd) return new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
  const mdy = normalized.match(/^(\d{1,2})\s+(\d{1,2})\s+(\d{4})/);
  return mdy ? new Date(Number(mdy[3]), Number(mdy[1]) - 1, Number(mdy[2])) : null;
}
const isoDate = (input) => parseDate(input)?.toISOString().slice(0, 10) || String(input || "");

async function firstZipFile(buffer) {
  const bytes = new Uint8Array(buffer); const view = new DataView(buffer); let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("找不到 ZIP 目錄");
  const central = view.getUint32(eocd + 16, true);
  const method = view.getUint16(central + 10, true);
  const size = view.getUint32(central + 20, true);
  const local = view.getUint32(central + 42, true);
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  const compressed = bytes.slice(start, start + size);
  if (method === 0) return compressed;
  if (method !== 8) throw new Error("不支援的 ZIP 格式");
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function fetchRows(url, zipped = false) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} 回應 ${response.status}`);
  if (!zipped) return response.json();
  return JSON.parse(new TextDecoder().decode(await firstZipFile(await response.arrayBuffer())));
}

async function updateOfficial(now, since) {
  const [adsRows, importRows] = await Promise.all([fetchRows(ADS_URL, true), fetchRows(IMPORTS_URL)]);
  const inRange = (raw) => { const date = parseDate(raw); return date && date >= since && date <= now; };
  const ads = adsRows.filter((row) => inRange(value(row, "處分日期") || value(row, "刊播日期"))).map((row) => ({
    kind: "違規食品廣告", product: value(row, "違規產品名稱"), company: value(row, "違規廠商名稱或負責人"), date: isoDate(value(row, "處分日期") || value(row, "刊播日期")), authority: value(row, "處分機關"), reason: value(row, "處分法條"), media: [value(row, "刊播媒體類別"), value(row, "刊播媒體")].filter(Boolean).join("／"), action: value(row, "查處情形"), url: ADS_PAGE,
  }));
  const imports = importRows.filter((row) => inRange(value(row, "發布日期"))).map((row) => ({
    kind: "不符合食品資訊", product: value(row, "主旨"), company: value(row, "進口商名稱"), date: isoDate(value(row, "發布日期")), authority: "衛生福利部食品藥物管理署", reason: value(row, "不合格原因暨檢出量詳細說明") || value(row, "原因"), manufacturer: value(row, "製造廠或出口商名稱"), brand: value(row, "牌名"), action: value(row, "處置情形"), url: IMPORTS_PAGE,
  }));
  await writeFile(OFFICIAL_FILE, JSON.stringify({ updatedAt: now.toISOString(), adsAvailable: true, importsAvailable: true, ads, imports }));
}

async function fetchNews(query, since) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  const response = await fetch(url, { headers: { "User-Agent": "food-compliance-checker/1.0" } });
  if (!response.ok) throw new Error(`新聞來源回應 ${response.status}`);
  const xml = await response.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].flatMap((match) => {
    const date = new Date(tag(match[1], "pubDate")); const title = tag(match[1], "title");
    if (Number.isNaN(date.getTime()) || date < since || !RISK_TERMS.some((term) => compact(title).includes(compact(term)))) return [];
    return [{ title, url: tag(match[1], "link"), date: date.toISOString().slice(0, 10), source: tag(match[1], "source") || "Google 新聞" }];
  });
}

async function updateNews(now, since) {
  const previous = JSON.parse(await readFile(NEWS_FILE, "utf8").catch(() => '{"items":[]}'));
  const previousItems = (previous.items || []).map(restoreNewsOriginal);
  const queries = ["食品 違規", "食品 裁罰", "食品 誇大廣告", "食品 不合格", "食品 回收", "食品 下架"];
  const fresh = (await Promise.all(queries.map((query) => fetchNews(query, since)))).flat();
  const oldByKey = new Map(previousItems.map((item) => [`${compact(item.title)}|${item.date}`, item]));
  const merged = [...fresh, ...previousItems].filter((item) => new Date(item.date) >= since).map((item) => ({ ...item, ...(oldByKey.get(`${compact(item.title)}|${item.date}`) || {}) }));
  const unique = [...new Map(merged.map((item) => [`${compact(item.title)}|${item.date}`, item])).values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 2000);
  const candidates = unique.filter((item) => item.parseStatus !== "parsed" || item.parseVersion !== NEWS_PARSE_VERSION).slice(0, ARTICLE_PARSE_LIMIT);
  const enriched = await mapConcurrent(candidates, 4, enrichNewsItem);
  const enrichedByKey = new Map(enriched.map((item) => [`${compact(item.title)}|${item.date}`, item]));
  const parsedItems = unique.map((item) => enrichedByKey.get(`${compact(item.title)}|${item.date}`) || item);
  const items = applyNewsCorrections(parsedItems, await loadNewsCorrections());
  const parsedCount = items.filter((item) => item.parseStatus === "parsed").length;
  await writeFile(NEWS_FILE, JSON.stringify({ updatedAt: now.toISOString(), available: true, parsedCount, titleOnlyCount: items.length - parsedCount, items }));
}

const now = new Date();
// 年度制：查核本年度與前一完整年度；例如 2026 年為 2025-01-01 至今。
const since = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1));
await Promise.all([updateOfficial(now, since), updateNews(now, since), updateLocalOfficial(now)]);
console.log(`完成：中央官方、地方衛生局與新聞資料更新至 ${now.toISOString()}`);
