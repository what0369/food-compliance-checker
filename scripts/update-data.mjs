import { readFile, writeFile } from "node:fs/promises";

const ADS_URL = "https://data.fda.gov.tw/data/opendata/22/json";
const IMPORTS_URL = "https://data.fda.gov.tw/data/opendata/52/json";
const ADS_PAGE = "https://data.gov.tw/dataset/6949";
const IMPORTS_PAGE = "https://data.gov.tw/dataset/6133";
const NEWS_FILE = new URL("../public/data/news.json", import.meta.url);
const OFFICIAL_FILE = new URL("../public/data/official.json", import.meta.url);
const RISK_TERMS = ["違規", "裁罰", "誇大", "下架", "不合格", "回收", "處分", "遭罰", "開罰"];

const value = (row, key) => String(row[key] ?? "").trim();
const compact = (text) => String(text).toLowerCase().replace(/[\s　\p{P}\p{S}]/gu, "");
const decodeXml = (text) => text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const tag = (item, name) => decodeXml(item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"))?.[1]?.trim() || "");

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
  const queries = ["食品 違規", "食品 裁罰", "食品 誇大廣告", "食品 不合格", "食品 回收", "食品 下架"];
  const fresh = (await Promise.all(queries.map((query) => fetchNews(query, since)))).flat();
  const merged = [...fresh, ...(previous.items || [])].filter((item) => new Date(item.date) >= since);
  const unique = [...new Map(merged.map((item) => [`${compact(item.title)}|${item.date}`, item])).values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 2000);
  await writeFile(NEWS_FILE, JSON.stringify({ updatedAt: now.toISOString(), available: true, items: unique }));
}

const now = new Date(); const since = new Date(now); since.setFullYear(since.getFullYear() - 1);
await Promise.all([updateOfficial(now, since), updateNews(now, since)]);
console.log(`完成：官方與新聞資料更新至 ${now.toISOString()}`);
