import { readFile, writeFile } from "node:fs/promises";
import { collectHealthBureauNews } from "./update-health-news.mjs";

const OUTPUT = new URL("../public/data/local-official.json", import.meta.url);
const DATASETS = {
  taipei: "https://data.gov.tw/dataset/132330",
  newTaipei: "https://data.ntpc.gov.tw/datasets/078cb722-15ac-4e1e-b541-e75bfe0aa440",
  taoyuan: "https://data.gov.tw/dataset/168689",
  taichung: "https://data.gov.tw/dataset/176956",
  tainan: "https://data.gov.tw/dataset/177649",
  kaohsiung: "https://health.kcg.gov.tw/Content_List.aspx?Create=1&n=9DF844BC2089D2FD",
};

const text = (value) => String(value ?? "").trim();
const compact = (value) => text(value).toLowerCase().replace(/[\s　\p{P}\p{S}]/gu, "");
const first = (row, names) => {
  const key = Object.keys(row).find((candidate) => names.some((name) => compact(candidate).includes(compact(name))));
  return key ? text(row[key]) : "";
};

function parseCsv(input) {
  const rows = []; let row = []; let field = ""; let quoted = false;
  const source = input.replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted && char === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === ",") { row.push(field); field = ""; }
    else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field); field = ""; if (row.some((value) => value.trim())) rows.push(row); row = [];
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift()?.map((value) => value.trim()) || [];
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function parseDate(input) {
  const value = text(input).replace(/[年月.／]/g, "/").replace(/日/g, "").replace(/-/g, "/");
  const compactDate = value.match(/^(\d{3})(\d{2})(\d{2})$/);
  if (compactDate) return new Date(Number(compactDate[1]) + 1911, Number(compactDate[2]) - 1, Number(compactDate[3]));
  const roc = value.match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})/);
  if (roc && Number(roc[1]) < 1911) return new Date(Number(roc[1]) + 1911, Number(roc[2]) - 1, Number(roc[3]));
  const western = value.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (western) return new Date(Number(western[1]), Number(western[2]) - 1, Number(western[3]));
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const isoDate = (value) => parseDate(value)?.toISOString().slice(0, 10) || "";
const within = (value, since, now) => { const date = parseDate(value); return Boolean(date && date >= since && date <= now); };

async function fetchText(url) {
  const response = await fetch(url, { headers: { "User-Agent": "food-compliance-checker/1.0" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url) { return JSON.parse(await fetchText(url)); }

async function distributionUrls(datasetUrl) {
  const html = await fetchText(datasetUrl);
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const found = [];
  for (const block of blocks) {
    try {
      const data = JSON.parse(block[1]);
      const nodes = Array.isArray(data) ? data : [data];
      for (const node of nodes) for (const item of (node.distribution || [])) {
        const url = item.contentUrl || item.downloadURL;
        if (url && (/\.csv(?:$|\?)/i.test(url) || /csv/i.test(item.encodingFormat || item.format || "") || /\/download(?:$|\?)/i.test(url))) found.push(url);
      }
    } catch { /* 略過頁面中非標準 JSON-LD */ }
  }
  return [...new Set(found)];
}

function record(city, row, sourceUrl) {
  const rawDate = first(row, ["抽驗日期", "稽查日期", "日期"]);
  return {
    kind: "地方食品抽驗不符",
    product: first(row, ["檢體名稱", "產品名稱", "品名", "物品名稱"]),
    company: first(row, ["受稽查廠商", "抽驗廠商名稱", "廠商名稱", "業者名稱", "市招名稱"]),
    manufacturer: first(row, ["廠商提供來源名稱", "來源廠商", "製造廠商"]),
    date: isoDate(rawDate),
    authority: `${city}政府衛生局`,
    reason: first(row, ["檢驗值/限量標準", "檢驗數值及標準", "不合格原因", "檢驗項目", "結果"]),
    action: first(row, ["後續處辦情形", "處辦結果", "處理情形"]),
    url: sourceUrl,
    city,
    sourceLayer: "地方衛生局直接資料",
    matchable: true,
  };
}

async function csvDataset(city, datasetUrl, since, now, maxFiles = 18) {
  const urls = (await distributionUrls(datasetUrl)).slice(-maxFiles);
  const settled = await Promise.allSettled(urls.map(async (url) => ({ url, rows: parseCsv(await fetchText(url)) })));
  const records = settled.flatMap((result) => result.status === "fulfilled" ? result.value.rows.map((row) => record(city, row, result.value.url)) : [])
    .filter((item) => item.product && item.date && within(item.date, since, now))
    .filter((item) => !/(^|[^不未])合格/.test(item.reason) || /不合格|不符|超標|檢出/.test(item.reason));
  if (!urls.length) throw new Error("找不到可讀取的 CSV");
  return records;
}

async function tainan(since, now) {
  const urls = [
    "https://soa.tainan.gov.tw/Api/Service/Get/e6f948cf-e7b9-4be9-9be4-f6d3992311d0",
    "https://soa.tainan.gov.tw/Api/Service/Get/51b3d901-697b-413f-95d6-105b868bcde5",
  ];
  const payloads = await Promise.all(urls.map(fetchJson));
  return payloads.flatMap((payload, index) => (payload.data || payload || []).map((row) => record("臺南市", row, urls[index])))
    .filter((item) => item.product && item.date && within(item.date, since, now));
}

async function taichung(since, now) {
  const url = "https://newdatacenter.taichung.gov.tw/api/v1/no-auth/resource.download?rid=73318d49-c0b6-4b1e-8a9d-91af77ef9032";
  const rows = await fetchJson(url);
  return (Array.isArray(rows) ? rows : rows.data || []).map((row) => record("臺中市", row, url))
    .filter((item) => item.product && item.date && within(item.date, since, now) && !/^合格$/.test(item.reason));
}

export async function updateLocalOfficial(now = new Date()) {
  // 年度制：查核本年度與前一完整年度；例如 2026 年為 2025-01-01 至今。
  const since = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1));
  const previous = JSON.parse(await readFile(OUTPUT, "utf8").catch(() => '{"records":[]}'));
  const jobs = [
    { city: "臺北市", datasetUrl: DATASETS.taipei, mode: "結構化開放資料", run: () => csvDataset("臺北市", DATASETS.taipei, since, now) },
    { city: "新北市", datasetUrl: DATASETS.newTaipei, mode: "官方檔案索引", run: null },
    { city: "桃園市", datasetUrl: DATASETS.taoyuan, mode: "結構化開放資料", run: () => csvDataset("桃園市", DATASETS.taoyuan, since, now) },
    { city: "臺中市", datasetUrl: DATASETS.taichung, mode: "結構化開放資料", run: () => taichung(since, now) },
    { city: "臺南市", datasetUrl: DATASETS.tainan, mode: "結構化開放資料", run: () => tainan(since, now) },
    { city: "高雄市", datasetUrl: DATASETS.kaohsiung, mode: "官方公告索引", run: null },
  ];
  const runWithLimit = (job) => Promise.race([
    job.run(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("來源處理超過 35 秒")), 35_000)),
  ]);
  const results = await Promise.all(jobs.map(async (job) => {
    if (!job.run) return { job, items: null };
    try { return { job, items: await runWithLimit(job) }; }
    catch (error) { return { job, error }; }
  }));
  const records = []; const sources = [];
  for (const result of results) {
    const { job } = result;
    if (result.items === null) sources.push({ city: job.city, datasetUrl: job.datasetUrl, mode: job.mode, status: "僅供人工開啟查閱", recordCount: 0 });
    else if (result.error) sources.push({ city: job.city, datasetUrl: job.datasetUrl, mode: job.mode, status: "本次更新失敗", recordCount: 0, message: result.error instanceof Error ? result.error.message : "未知錯誤" });
    else { records.push(...result.items); sources.push({ city: job.city, datasetUrl: job.datasetUrl, mode: job.mode, status: "已連線", recordCount: result.items.length }); }
  }
  const healthNews = await collectHealthBureauNews(now, since, previous.records || []);
  records.push(...healthNews.records);
  sources.push(healthNews.source);
  const unique = [...new Map(records.map((item) => [`${compact(item.city)}|${compact(item.product)}|${compact(item.company)}|${item.date}|${compact(item.reason)}`, item])).values()]
    .sort((a, b) => b.date.localeCompare(a.date));
  await writeFile(OUTPUT, JSON.stringify({ updatedAt: now.toISOString(), periodStart: since.toISOString().slice(0, 10), periodEnd: now.toISOString().slice(0, 10), records: unique, sources }));
  return { records: unique, sources };
}
