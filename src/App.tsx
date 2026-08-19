"use client";

import { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";

type UploadRow = { product: string; supplier: string; brand: string; manufacturer: string; taxId: string; adUrl: string; claimText: string; keyword?: string };
type Status = "產品紀錄命中" | "供應商紀錄命中" | "新聞疑似命中" | "本次未命中" | "資料不足";
type Evidence = { kind: string; title: string; date: string; source: string; url: string; basis: string; reason?: string; recordCompany?: string; recordProduct?: string; media?: string; action?: string };
type Result = UploadRow & { status: Status; count: number; latest: string; note: string; query: string; evidence: Evidence[] };
type OfficialItem = { kind: string; product: string; company: string; date: string; authority: string; reason: string; url: string; manufacturer?: string; brand?: string; media?: string; action?: string; city?: string; sourceLayer?: string; matchable?: boolean };
type LocalSource = { city: string; datasetUrl: string; mode: string; status: string; recordCount: number; message?: string };
type NewsItem = { title: string; url: string; date: string; source: string; region?: string; manual?: boolean };
type ManualNewsItem = NewsItem & { note?: string; approvedAt?: string; issueUrl?: string };
type NewsSubmission = { url: string; note: string };
type DatabaseTab = "official" | "local" | "manual" | "daily";
type DatabaseData = { official: OfficialItem[]; local: OfficialItem[]; localSources: LocalSource[]; manual: ManualNewsItem[]; daily: NewsItem[]; officialUpdatedAt: string; localUpdatedAt: string; manualUpdatedAt: string; dailyUpdatedAt: string };

const LAW_URL = "https://www.fda.gov.tw/TC/newsContent.aspx?cid=3&id=30551";
const ARTICLE_28_URL = "https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=L0040001&flno=28";
const ADS_DATASET_URL = "https://data.gov.tw/dataset/6949";
const IMPORTS_DATASET_URL = "https://data.gov.tw/dataset/6133";
const GOOGLE_NEWS_URL = "https://news.google.com/home?hl=zh-TW&gl=TW&ceid=TW:zh-Hant";
const LOCAL_HEALTH_URL = "https://service.mohw.gov.tw/HealthCenter/";
const NEW_ISSUE_URL = "https://github.com/what0369/food-compliance-checker/issues/new";
const ISSUES_URL = "https://github.com/what0369/food-compliance-checker/issues";
const STORAGE_KEY = "food-compliance-free-check-v5";
const SAMPLE_ROWS: UploadRow[] = [
  { product: "Slimmit食事對抗酵素", supplier: "健康生活商行", brand: "Slimmit", manufacturer: "", taxId: "", adUrl: "", claimText: "六個月降低體重，促進代謝並降低膽固醇。" },
  { product: "原味燕麥片", supplier: "日常食品股份有限公司", brand: "日日好食", manufacturer: "", taxId: "", adUrl: "", claimText: "" },
  { product: "媽媽蔛 3包組合", supplier: "美好購物網", brand: "媽媽蔛", manufacturer: "", taxId: "", adUrl: "", claimText: "" },
];

const clean = (value: unknown) => String(value ?? "").trim();
const compact = (value: string) => value.toLowerCase().replace(/[\s　\p{P}\p{S}]/gu, "");
const companyCore = (value: string) => compact(value).replace(/股份有限公司|有限公司|企業社|商行|公司$/g, "");
const nonEmpty = (value: string) => value.length > 0;
function findValue(row: Record<string, unknown>, names: string[]) { const key = Object.keys(row).find((item) => names.some((name) => item.replace(/\s/g, "").includes(name))); return key ? clean(row[key]) : ""; }
function makeQuery(row: UploadRow) { return [...new Set([row.keyword, row.brand, row.product, row.supplier, row.manufacturer].filter(Boolean))].slice(0, 3).join(" "); }
function newsKey(row: UploadRow) { return row.keyword || row.supplier || row.manufacturer || row.brand || row.product; }
function newsMatches(row: UploadRow, items: NewsItem[]) {
  const keyword = compact(row.keyword || "");
  const candidates = [...[row.supplier, row.manufacturer].map(companyCore).filter((value) => value.length >= 3), ...(keyword.length >= 2 ? [companyCore(keyword)] : [])];
  const productCandidates = [...[row.product, row.brand].map(compact).filter((value) => value.length >= 4), ...(keyword.length >= 2 ? [keyword] : [])];
  return items.filter((item) => {
    const title = compact(item.title);
    return candidates.some((name) => title.includes(name)) || productCandidates.some((name) => title.includes(name));
  }).slice(0, 3);
}
function searchUrl(kind: "official" | "news", query: string) {
  const exact = query || "食品";
  if (kind === "news") return `https://news.google.com/search?q=${encodeURIComponent(`${exact} 違規 OR 裁罰 OR 誇大廣告`)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  return `https://www.google.com/search?q=${encodeURIComponent(`site:fda.gov.tw OR site:gov.tw ${exact} 違規 裁罰 食品`)}`;
}
function strongProductMatch(left: string, right: string) {
  if (!left || !right) return false;
  if (left === right) return left.length >= 3;
  const shorter = Math.min(left.length, right.length);
  const longer = Math.max(left.length, right.length);
  return shorter >= 6 && shorter / longer >= 0.75 && (left.includes(right) || right.includes(left));
}
function officialMatches(row: UploadRow, items: OfficialItem[]) {
  const keyword = compact(row.keyword || "");
  const companies = [...[row.supplier, row.manufacturer].map(companyCore).filter((v) => v.length >= 3), ...(keyword.length >= 2 ? [companyCore(keyword)] : [])];
  const products = [...[row.product].map(compact).filter((v) => v.length >= 4), ...(keyword.length >= 3 ? [keyword] : [])];
  const brands = [...[row.brand].map(compact).filter((v) => v.length >= 3), ...(keyword.length >= 2 ? [keyword] : [])];
  return items.flatMap((item) => {
    const itemCompanies = [item.company, item.manufacturer || ""].map(companyCore).filter(nonEmpty);
    const itemProducts = [item.product].map(compact).filter(nonEmpty);
    const itemBrands = [item.brand || ""].map(compact).filter(nonEmpty);
    const companyHit = companies.some((name) => itemCompanies.some((candidate) => candidate === name));
    const productHit = products.some((name) => itemProducts.some((candidate) => strongProductMatch(name, candidate) || (keyword.length >= 3 && (candidate.includes(keyword) || keyword.includes(candidate)))));
    const brandHit = brands.some((name) => itemBrands.some((candidate) => candidate === name || (keyword.length >= 3 && candidate.includes(keyword))));
    if (companyHit) return [{ item, basis: productHit || brandHit ? "業者名稱及產品／品牌相符" : "業者名稱相符（可能是該業者的其他產品）" }];
    if (productHit) return [{ item, basis: brandHit ? "產品名稱及品牌相符" : "產品名稱高度相符（請確認業者）" }];
    return [];
  }).slice(0, 5);
}
function uniqueOfficial(items: OfficialItem[]) {
  return [...new Map(items.map((item) => [`${compact(item.product)}|${companyCore(item.company || item.manufacturer || "")}|${item.date}|${compact(item.reason)}`, item])).values()];
}
export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [sourceWarning, setSourceWarning] = useState("");
  const [filter, setFilter] = useState<"all" | "official" | Status>("all");
  const [selectedEvidence, setSelectedEvidence] = useState<Evidence | null>(null);
  const [submittingNews, setSubmittingNews] = useState(false);
  const [newsSubmission, setNewsSubmission] = useState<NewsSubmission>({ url: "", note: "" });
  const [databaseOpen, setDatabaseOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [databaseLoading, setDatabaseLoading] = useState(false);
  const [databaseError, setDatabaseError] = useState("");
  const [databaseTab, setDatabaseTab] = useState<DatabaseTab>("official");
  const [databaseQuery, setDatabaseQuery] = useState("");
  const [databaseData, setDatabaseData] = useState<DatabaseData | null>(null);
  const shown = useMemo(() => filter === "all" ? results : filter === "official" ? results.filter((item) => item.status === "產品紀錄命中" || item.status === "供應商紀錄命中") : results.filter((item) => item.status === filter), [results, filter]);
  const stats = useMemo(() => ({ total: results.length, official: results.filter((item) => item.status === "產品紀錄命中" || item.status === "供應商紀錄命中").length, news: results.filter((item) => item.status === "新聞疑似命中").length, noHit: results.filter((item) => item.status === "本次未命中").length, insufficient: results.filter((item) => item.status === "資料不足").length }), [results]);
  const databaseFiltered = useMemo(() => {
    if (!databaseData) return [] as (OfficialItem | ManualNewsItem)[];
    const items: (OfficialItem | ManualNewsItem)[] = databaseTab === "official" ? databaseData.official : databaseTab === "local" ? databaseData.local : databaseTab === "manual" ? databaseData.manual : databaseData.daily;
    const query = compact(databaseQuery);
    return items.filter((item) => !query || compact("product" in item ? [item.kind, item.product, item.brand, item.company, item.manufacturer, item.authority, item.reason, item.media, item.action].filter(Boolean).join(" ") : [item.title, item.source, item.region, item.note].filter(Boolean).join(" ")).includes(query)).sort((a, b) => b.date.localeCompare(a.date));
  }, [databaseData, databaseQuery, databaseTab]);
  const today = new Date(); const since = new Date(today); since.setFullYear(today.getFullYear() - 1); const dateLabel = `${since.toISOString().slice(0, 10)} 至 ${today.toISOString().slice(0, 10)}`;

  async function readFile(file: File) {
    setError(""); setSourceWarning("");
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("檔案超過 10 MB 上限。");
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
      const targetName = workbook.SheetNames.find((name) => name.includes("網站查核匯入")) || workbook.SheetNames[0];
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[targetName], { defval: "" });
      const parsed = raw.map((row) => ({ product: findValue(row, ["產品名稱", "子產品名稱", "產品", "品名", "商品"]), supplier: findValue(row, ["供應商名稱", "供應商", "業者名稱", "公司名稱", "業者"]), brand: findValue(row, ["品牌完整名稱", "品牌名稱", "品牌"]), manufacturer: findValue(row, ["製造商／進口商名稱", "製造商/進口商名稱", "製造商", "進口商"]), taxId: findValue(row, ["統一編號", "統編"]), adUrl: findValue(row, ["商品／廣告網址", "商品/廣告網址", "廣告網址", "商品網址", "網址"]), claimText: findValue(row, ["購物頁宣稱文字", "廣告宣稱文字", "宣稱文字", "廣告文字"]) })).filter((row) => row.product || row.supplier || row.brand || row.manufacturer);
      if (!parsed.length) throw new Error("找不到產品、品牌、供應商或製造商欄位。");
      setRows(parsed); setResults([]); setFileName(file.name); setProgress("");
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const data = JSON.parse(saved) as { fileName: string; rowCount: number; results: Result[] };
        if (data.fileName === file.name && data.rowCount === parsed.length) { setResults(data.results); setProgress("已恢復這份清單上次的查核結果。"); }
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Excel 讀取失敗。"); }
  }

  async function checkRows(targetRows: UploadRow[], sourceName: string) {
    if (!targetRows.length) return;
    setRows(targetRows); setFileName(sourceName); setResults([]); setFilter("all");
    setLoading(true); setError(""); setSourceWarning("");
    try {
      setProgress("1/3 下載食藥署與地方衛生局一年內官方資料…");
      const base = import.meta.env.BASE_URL;
      const [officialResponse, localResponse] = await Promise.all([fetch(`${base}data/official.json`, { cache: "no-store" }), fetch(`${base}data/local-official.json`, { cache: "no-store" })]);
      if (!officialResponse.ok) throw new Error("食藥署資料暫時無法讀取，請稍後重試。");
      const official = await officialResponse.json() as { ads: OfficialItem[]; imports: OfficialItem[]; adsAvailable: boolean; importsAvailable: boolean };
      const local = localResponse.ok ? await localResponse.json() as { records: OfficialItem[]; sources: LocalSource[] } : { records: [], sources: [] };
      const officialItems = uniqueOfficial([...official.ads, ...official.imports, ...local.records.filter((item) => item.matchable !== false)]);
      setProgress("2/3 讀取每日新聞與人工核准線索庫…");
      const [newsResponse, manualNewsResponse] = await Promise.all([fetch(`${base}data/news.json`, { cache: "no-store" }), fetch(`${base}data/manual-news.json`, { cache: "no-store" })]);
      const newsPayload = newsResponse.ok ? await newsResponse.json() as { items: NewsItem[]; available: boolean } : { items: [], available: false };
      const manualNewsPayload = manualNewsResponse.ok ? await manualNewsResponse.json() as { items: NewsItem[] } : { items: [] };
      const newsItems = [...manualNewsPayload.items, ...newsPayload.items];
      setProgress("3/3 整理命中證據並保存結果…");
      const checked = targetRows.map<Result>((row) => {
        const query = makeQuery(row);
        if (!query) return { ...row, query, status: "資料不足", count: 0, latest: "—", note: "至少需要產品、品牌、供應商或製造商名稱之一。", evidence: [] };
        const matched = officialMatches(row, officialItems);
        const news = newsMatches(row, newsItems);
        const officialEvidence = matched.map<Evidence>(({ item, basis }) => ({ kind: item.kind, title: item.product || item.company, date: item.date, source: item.authority, url: item.url, reason: item.reason, basis, recordCompany: item.company || item.manufacturer, recordProduct: item.product, media: item.media, action: item.action }));
        const newsEvidence = news.map<Evidence>((item) => ({ kind: item.manual ? "人工核准新聞線索" : "新聞搜尋線索", title: item.title, date: item.date, source: [item.source || "Google 新聞", item.region].filter(Boolean).join("／"), url: item.url, basis: `新聞標題明確包含「${newsKey(row)}」及風險事件詞` }));
        if (officialEvidence.length) {
          const productLevel = officialEvidence.some((item) => item.basis.includes("產品名稱") || item.basis.includes("產品／品牌相符"));
          return { ...row, query, status: productLevel ? "產品紀錄命中" : "供應商紀錄命中", count: officialEvidence.length, latest: officialEvidence.map((item) => item.date).sort().reverse()[0], note: productLevel ? "官方紀錄與產品名稱高度相符，仍請核對包裝與業者。" : "這是同一供應商的違規紀錄，可能是其他產品；不代表本商品本身違規。", evidence: [...officialEvidence, ...newsEvidence] };
        }
        if (newsEvidence.length) return { ...row, query, status: "新聞疑似命中", count: newsEvidence.length, latest: newsEvidence[0].date, note: "新聞僅為查核線索，須開啟原文並核對事件、日期與同一性。", evidence: newsEvidence };
        return { ...row, query, status: "本次未命中", count: 0, latest: "—", note: "本次官方資料與新聞線索未命中；不代表絕對無違規。誇大不實以主管機關官方資料為主要依據。", evidence: [] };
      });
      setResults(checked);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ fileName: sourceName, rowCount: targetRows.length, results: checked, checkedAt: new Date().toISOString() }));
      if (!official.adsAvailable || !official.importsAvailable || !newsPayload.available || !localResponse.ok || local.sources.some((item) => item.status === "本次更新失敗")) setSourceWarning("部分資料來源本次未成功更新；結果不可視為完整查核，請查看資料來源狀態或使用人工搜尋入口補查。");
      setProgress(`完成：${checked.length} 筆結果已保存在此瀏覽器。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "自動查核失敗，請稍後再試。"); }
    finally { setLoading(false); }
  }

  async function runCheck() { await checkRows(rows, fileName); }
  async function runKeywordCheck() {
    const value = clean(keyword);
    if (value.length < 2) { setError("請輸入至少 2 個字的產品、品牌或供應商名稱。"); return; }
    await checkRows([{ product: "", supplier: "", brand: "", manufacturer: "", taxId: "", adUrl: "", claimText: "", keyword: value }], `快速查核：${value}`);
  }

  function useSample() { setRows(SAMPLE_ROWS); setResults([]); setFileName("範例_供應商產品清單.xlsx"); setError(""); setProgress(""); }
  function downloadTemplate() {
    const sheet = XLSX.utils.json_to_sheet([{ "產品名稱": "範例產品", "供應商名稱": "範例供應商股份有限公司", "品牌完整名稱": "範例品牌", "製造商／進口商名稱": "", "統一編號（選填）": "" }]);
    const guide = XLSX.utils.aoa_to_sheet([["欄位", "必要性", "說明"], ["產品／品牌／供應商／製造商", "至少一項", "名稱越完整，比對越準確"], ["統一編號", "選填", "未提供仍可用名稱初篩"], ["判讀原則", "—", "誇大不實以食藥署等主管機關官方資料為主要依據，新聞僅作補充線索"]]);
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, "查詢清單"); XLSX.utils.book_append_sheet(book, guide, "填寫說明"); XLSX.writeFile(book, "食品違規查核_免費自動查核範本.xlsx");
  }
  function exportResults() {
    const sheet = XLSX.utils.json_to_sheet(results.map((item) => ({ "快速查核關鍵字": item.keyword || "", "產品名稱": item.product, "品牌": item.brand, "供應商": item.supplier, "製造商／進口商": item.manufacturer, "統編（選填）": item.taxId, "查核狀態": item.status, "一年內命中筆數": item.count, "最新日期": item.latest, "證據關聯理由": item.evidence.map((e) => e.basis).join("｜"), "官方紀錄產品": item.evidence.map((e) => e.recordProduct || "").filter(Boolean).join("｜"), "官方紀錄業者": item.evidence.map((e) => e.recordCompany || "").filter(Boolean).join("｜"), "處分法條／原因": item.evidence.map((e) => e.reason || "").filter(Boolean).join("｜"), "證據標題": item.evidence.map((e) => e.title).join("｜"), "證據網址": item.evidence.map((e) => e.url).join("｜"), "官方人工搜尋": searchUrl("official", item.query), "新聞人工搜尋": searchUrl("news", item.query), "備註": item.note })));
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, "查核結果"); XLSX.writeFile(book, `一年內免費自動查核結果_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }
  function submitNewsForReview() {
    const data = { url: clean(newsSubmission.url), note: clean(newsSubmission.note) };
    if (!data.url || !data.note) { setError("請貼上新聞網址，並填寫產品、品牌或事件說明。"); return; }
    let parsed: URL;
    try { parsed = new URL(data.url); if (!/^https?:$/.test(parsed.protocol)) throw new Error(); } catch { setError("請輸入完整的 http 或 https 新聞網址。"); return; }
    const source = parsed.hostname.replace(/^www\./, "");
    const date = new Date().toISOString().slice(0, 10);
    const title = data.note.split(/\r?\n/).find(Boolean)?.slice(0, 80) || `新聞線索（${source}）`;
    const safeNote = data.note.replace(/^## /gm, "＃＃ ");
    const body = [`## 新聞標題`, title, ``, `## 新聞網址`, data.url, ``, `## 發布日期`, date, ``, `## 地區／主管機關`, `待確認`, ``, `## 新聞來源`, source, ``, `## 補充說明`, safeNote, ``, `---`, `系統已由網址自動整理來源及提交日期。管理者確認原文、日期、地區與同一性後，請留言：/收錄`].join("\n");
    window.open(`${NEW_ISSUE_URL}?title=${encodeURIComponent(`新聞線索：${title}`)}&body=${encodeURIComponent(body)}`, "_blank", "noopener,noreferrer");
    setNewsSubmission({ url: "", note: "" }); setSubmittingNews(false); setError("");
  }

  async function openDatabase() {
    setDatabaseOpen(true); setDatabaseError("");
    if (databaseData || databaseLoading) return;
    setDatabaseLoading(true);
    try {
      const base = import.meta.env.BASE_URL;
      const [officialResponse, localResponse, manualResponse, dailyResponse] = await Promise.all([fetch(`${base}data/official.json`, { cache: "no-store" }), fetch(`${base}data/local-official.json`, { cache: "no-store" }), fetch(`${base}data/manual-news.json`, { cache: "no-store" }), fetch(`${base}data/news.json`, { cache: "no-store" })]);
      if (!officialResponse.ok || !localResponse.ok || !manualResponse.ok || !dailyResponse.ok) throw new Error("部分資料暫時無法讀取，請稍後再試。");
      const official = await officialResponse.json() as { ads: OfficialItem[]; imports: OfficialItem[]; updatedAt: string };
      const local = await localResponse.json() as { records: OfficialItem[]; sources: LocalSource[]; updatedAt: string };
      const manual = await manualResponse.json() as { items: ManualNewsItem[]; updatedAt: string };
      const daily = await dailyResponse.json() as { items: NewsItem[]; updatedAt: string };
      setDatabaseData({ official: [...official.ads, ...official.imports], local: local.records, localSources: local.sources, manual: manual.items, daily: daily.items, officialUpdatedAt: official.updatedAt, localUpdatedAt: local.updatedAt, manualUpdatedAt: manual.updatedAt, dailyUpdatedAt: daily.updatedAt });
    } catch (cause) { setDatabaseError(cause instanceof Error ? cause.message : "資料庫讀取失敗。"); }
    finally { setDatabaseLoading(false); }
  }

  function displayUpdatedAt(value: string) { return value ? new Date(value).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }) : "未提供"; }

  return <main>
    <header className="topbar">
<a className="brand" href="#top">
<span>查</span>
<div>
<b>食安違規查核台</b>
<small>FREE COMPLIANCE CHECK</small>
</div>
</a>
<div className="top-actions">
<button className="database-link" onClick={() => setSourcesOpen(true)}>資料來源說明</button>
<button className="database-link" onClick={openDatabase}>查看已收錄資料</button>
<div className="period">
<i />滾動查核期間：{dateLabel}</div>
</div>
</header>
    <section className="hero" id="top">
<div className="hero-copy">
<p className="eyebrow">零額外查詢費</p>
<h1>輸入關鍵字或上傳 Excel<br/>
<em>完成官方與新聞初查</em>
</h1>
<p className="lead">輸入產品、品牌或供應商名稱即可單筆查核；大量清單則上傳 Excel。系統以食藥署一年內官方違規資料為主要依據，新聞只作補充線索。</p>
<div className="source-chips">
<span>食藥署開放資料</span>
<span>官方資料優先</span>
<span>新聞補充線索</span>
<span>瀏覽器保存進度</span>
</div>
</div>
      <div className="upload-card">
<div className="step-label">
<span>1</span>快速查核或匯入清單</div>
<div className="quick-search">
<label htmlFor="quick-keyword">不用 Excel，直接輸入名稱</label>
<div>
<input id="quick-keyword" value={keyword} onChange={(e) => { setKeyword(e.target.value); setError(""); }} onKeyDown={(e) => e.key === "Enter" && !loading && runKeywordCheck()} placeholder="例如：供應商名稱、品牌或產品名稱"/>
<button disabled={!keyword.trim() || loading} onClick={runKeywordCheck}>立即查核</button>
</div>
<small>系統會自動判別並同時比對產品與業者名稱</small>
</div>
<div className="or-divider">
<span>或批次上傳 Excel</span>
</div>
<button className={`dropzone ${fileName && !rows[0]?.keyword ? "has-file" : ""}`} onClick={() => inputRef.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const file = e.dataTransfer.files[0]; if (file) readFile(file); }}>
<input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])}/>
<span className="file-icon">{fileName && !rows[0]?.keyword ? "✓" : "XL"}</span>
<strong>{fileName && !rows[0]?.keyword ? fileName : "拖曳 Excel 到這裡，或點擊選擇"}</strong>
<small>{fileName && !rows[0]?.keyword ? `已讀取 ${rows.length} 筆有效資料` : "產品、品牌或業者至少一項｜統編選填"}</small>
</button>{error && <p className="error">{error}</p>}{sourceWarning && <p className="warning-box">{sourceWarning}</p>}<div className="upload-actions">
<button className="text-btn" onClick={downloadTemplate}>↓ 下載新版範本</button>
<button className="text-btn" onClick={useSample}>使用範例資料</button>
</div>
<button className="primary" disabled={!rows.length || loading || Boolean(rows[0]?.keyword)} onClick={runCheck}>{loading ? <>
<span className="spinner"/>免費自動查核中…</> : `批次自動查核${rows.length && !rows[0]?.keyword ? `（${rows.length} 筆）` : ""}`}</button>{progress && <p className="progress">{progress}</p>}<p className="privacy">不使用付費 AI API；Excel 在瀏覽器解析，查核結果保存在此裝置。</p>
</div>
    </section>
    <section className="workflow">
<div>
<b>01</b>
<span>
<strong>官方資料比對</strong>
<small>食藥署違規與不符合資料</small>
</span>
</div>
<i>→</i>
<div>
<b>02</b>
<span>
<strong>新聞線索補充</strong>
<small>人工核准與公開新聞</small>
</span>
</div>
<i>→</i>
<div>
<b>03</b>
<span>
<strong>人工確認同一性</strong>
<small>核對產品、品牌與業者</small>
</span>
</div>
</section>
    <section className="content">
<div className="section-head">
<div>
<p className="eyebrow">CHECK RESULTS</p>
<h2>查核結果</h2>
<p>{results.length ? `已完成 ${results.length} 筆免費初查；命中結果仍需核對同一性。` : "輸入關鍵字或上傳清單後，系統會完成可取得的免費查核。"}</p>
</div>
<div className="section-actions">
<button className="submit-news" onClick={() => setSubmittingNews(true)}>＋ 提交新聞線索</button>{results.length > 0 && <button className="export" onClick={exportResults}>↓ 匯出 Excel 結果</button>}</div>
</div>
      <div className="stats five">
<button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>
<span>全部</span>
<b>{stats.total}</b>
<small>筆對象</small>
</button>
<button className={`danger ${filter === "official" ? "active" : ""}`} onClick={() => setFilter("official")}>
<span>官方命中</span>
<b>{stats.official}</b>
<small>分產品／供應商</small>
</button>
<button className={`news ${filter === "新聞疑似命中" ? "active" : ""}`} onClick={() => setFilter("新聞疑似命中")}>
<span>新聞線索</span>
<b>{stats.news}</b>
<small>補充線索</small>
</button>
<button className={`safe ${filter === "本次未命中" ? "active" : ""}`} onClick={() => setFilter("本次未命中")}>
<span>本次未命中</span>
<b>{stats.noHit}</b>
<small>官方資料為主</small>
</button>
<button className={filter === "資料不足" ? "active" : ""} onClick={() => setFilter("資料不足")}>
<span>資料不足</span>
<b>{stats.insufficient}</b>
<small>需補名稱</small>
</button>
</div>
      <div className="result-panel">{shown.length ? <div className="table-wrap">
<table>
<thead>
<tr>
<th>狀態</th>
<th>產品／業者</th>
<th>自動找到的證據</th>
<th>人工補查</th>
<th>備註</th>
</tr>
</thead>
<tbody>{shown.map((item, index) => <tr key={`${item.keyword || item.product}-${index}`}>
<td>
<span className={`status status-${item.status}`}>{item.status}</span>
<small className="date">{item.latest}</small>
</td>
<td>
<strong>{item.keyword || item.product || item.brand || "未提供產品"}</strong>
<small>{item.keyword ? "快速關鍵字查核（自動判別產品或業者）" : [item.brand, item.supplier, item.manufacturer].filter(Boolean).join("｜") || "未提供業者"}</small>{!item.keyword && <small className="optional">統編：{item.taxId || "未提供（選填）"}</small>}</td>
<td>{item.evidence.length ? <div className="evidence-list">{item.evidence.slice(0, 3).map((e, i) => <button key={`${e.url}-${i}`} onClick={() => setSelectedEvidence(e)}>
<b>{e.kind}</b>
<span>{e.date}｜{e.title}</span>
<small>{e.basis}</small>
<em>查看完整紀錄 →</em>
</button>)}</div> : <small>本次官方資料與新聞線索未命中</small>}</td>
<td>
<div className="search-actions">
<a href={searchUrl("official", item.query)} target="_blank" rel="noreferrer">查官方 ↗</a>
<a href={searchUrl("news", item.query)} target="_blank" rel="noreferrer">查新聞 ↗</a>
</div>
</td>
<td>
<small className="note">{item.note}</small>
</td>
</tr>)}</tbody>
</table>
</div> : <div className="empty">
<div className="radar">
<i/>
<i/>
<i/>
</div>
<h3>尚未執行免費自動查核</h3>
<p>直接輸入關鍵字，或上傳 Excel 後開始查核。</p>
</div>}</div>
      <div className="method">
<div>
<span className="method-icon">i</span>
<div>
<strong>必要判讀原則</strong>
<p>誇大不實以食藥署等主管機關官方資料為主要依據；新聞僅為補充線索。未命中不代表絕對無違規，命中仍須確認是否為同一公司或產品。</p>
</div>
</div>
<div className="law-links">
<a href={ARTICLE_28_URL} target="_blank" rel="noreferrer">食安法第 28 條 ↗</a>
<a href={LAW_URL} target="_blank" rel="noreferrer">廣告認定準則 ↗</a>
</div>
</div>
    </section>
    {submittingNews && <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setSubmittingNews(false)}>
<section className="review-modal news-modal simple-news-modal" role="dialog" aria-modal="true">
<button className="close" onClick={() => setSubmittingNews(false)}>×</button>
<p className="eyebrow">NEWS SUBMISSION</p>
<h2>提交新聞線索</h2>
<p className="modal-intro">只要貼上新聞網址並簡單說明產品、品牌或事件。新聞來源與提交日期會自動整理，管理者核准後才納入共用資料庫。</p>
<div className="news-form">
<label>新聞網址<input type="url" value={newsSubmission.url} onChange={(e) => { setNewsSubmission({ ...newsSubmission, url: e.target.value }); setError(""); }} placeholder="https://..."/>
</label>
<label>補充說明<textarea value={newsSubmission.note} onChange={(e) => { setNewsSubmission({ ...newsSubmission, note: e.target.value }); setError(""); }} placeholder="例如：奧利塔就是 Olitalia；2 款橄欖油含礦物油。請寫出產品、品牌、別名或違規事件。"/>
</label>
</div>{error && <p className="error modal-error">{error}</p>}<button className="primary analyze" disabled={!newsSubmission.url.trim() || !newsSubmission.note.trim()} onClick={submitNewsForReview}>前往 GitHub 送出審核</button>
<p className="github-note">需要登入免費 GitHub 帳號。管理者確認原文後，在議題留言「/收錄」，網站就會自動更新。</p>
</section>
</div>}
    {databaseOpen && <section className="database-page" role="dialog" aria-modal="true" aria-label="已收錄資料">
<header>
<div>
<p className="eyebrow">COLLECTED DATA</p>
<h2>已收錄資料</h2>
<p>查看網站目前可以查詢的官方紀錄與新聞線索。</p>
</div>
<button className="database-close" onClick={() => setDatabaseOpen(false)}>關閉 ×</button>
</header>
<div className="database-body">{databaseLoading ? <div className="database-loading">
<span className="spinner"/>資料載入中…</div> : databaseError ? <div className="database-loading error">{databaseError}<button onClick={() => { setDatabaseData(null); openDatabase(); }}>重新讀取</button>
</div> : databaseData && <>
<div className="database-summary">
<button className={databaseTab === "official" ? "active" : ""} onClick={() => setDatabaseTab("official")}>
<strong>{databaseData.official.length.toLocaleString()}</strong>
<span>官方紀錄</span>
<small>更新：{displayUpdatedAt(databaseData.officialUpdatedAt)}</small>
</button>
<button className={databaseTab === "local" ? "active" : ""} onClick={() => setDatabaseTab("local")}>
<strong>{databaseData.local.length.toLocaleString()}</strong>
<span>六都衛生局紀錄</span>
<small>更新：{displayUpdatedAt(databaseData.localUpdatedAt)}</small>
</button>
<button className={databaseTab === "manual" ? "active" : ""} onClick={() => setDatabaseTab("manual")}>
<strong>{databaseData.manual.length.toLocaleString()}</strong>
<span>人工核准新聞</span>
<small>更新：{displayUpdatedAt(databaseData.manualUpdatedAt)}</small>
</button>
<button className={databaseTab === "daily" ? "active" : ""} onClick={() => setDatabaseTab("daily")}>
<strong>{databaseData.daily.length.toLocaleString()}</strong>
<span>每日新聞線索</span>
<small>更新：{displayUpdatedAt(databaseData.dailyUpdatedAt)}</small>
</button>
</div>
{databaseTab === "local" && <div className="local-source-status">{databaseData.localSources.map((source) => <a key={source.city} href={source.datasetUrl} target="_blank" rel="noreferrer"><b>{source.city}</b><span>{source.mode}</span><small className={source.status === "已連線" ? "ok" : ""}>{source.status}｜一年內 {source.recordCount.toLocaleString()} 筆</small></a>)}</div>}
<div className="database-toolbar">
<label htmlFor="database-search">搜尋目前資料</label>
<input id="database-search" value={databaseQuery} onChange={(e) => setDatabaseQuery(e.target.value)} placeholder="輸入商品、品牌、供應商、製造商或新聞關鍵字"/>
<span>找到 {databaseFiltered.length.toLocaleString()} 筆</span>
</div>
<div className="database-table-wrap">
<table className="database-table">
<thead>{(databaseTab === "official" || databaseTab === "local") ? <tr>
<th>類型／日期</th>
<th>商品／品牌</th>
<th>業者／製造商</th>
<th>違規原因／處理</th>
<th>來源</th>
</tr> : <tr>
<th>日期／來源</th>
<th>新聞標題</th>
<th>地區／補充說明</th>
<th>原文</th>
</tr>}</thead>
<tbody>{databaseFiltered.slice(0, 100).map((item, index) => "product" in item ? <tr key={`${item.kind}-${item.date}-${item.product}-${index}`}>
<td>
<span className="database-kind">{item.kind}</span>
<small>{item.date}</small>
</td>
<td>
<strong>{item.product || "未提供"}</strong>{item.brand && <small>品牌：{item.brand}</small>}</td>
<td>
<strong>{item.company || "未提供"}</strong>{item.manufacturer && <small>製造商：{item.manufacturer}</small>}</td>
<td>
<span>{item.reason || "未提供原因"}</span>
<small>{[item.action, item.media].filter(Boolean).join("｜")}</small>
</td>
<td>
<small>{[item.authority, item.sourceLayer].filter(Boolean).join("｜")}</small>
<a href={item.url} target="_blank" rel="noreferrer">開啟官方來源 ↗</a>
</td>
</tr> : <tr key={`${item.date}-${item.url}-${index}`}>
<td>
<strong>{item.date}</strong>
<small>{item.source}</small>
</td>
<td>
<strong>{item.title}</strong>
</td>
<td>
<span>{item.region || (databaseTab === "daily" ? "新聞搜尋線索" : "未提供")}</span>{item.note && <small>{item.note}</small>}</td>
<td>
<a href={item.url} target="_blank" rel="noreferrer">開啟新聞原文 ↗</a>{item.issueUrl && <a href={item.issueUrl} target="_blank" rel="noreferrer">審核紀錄 ↗</a>}</td>
</tr>)}</tbody>
</table>{databaseFiltered.length === 0 && <div className="database-empty">沒有符合的資料，請換一個關鍵字。</div>}</div>{databaseFiltered.length > 100 && <p className="database-limit">為保持頁面順暢，目前顯示前 100 筆；請輸入關鍵字縮小範圍。</p>}</>}</div>
</section>}
    {sourcesOpen && <section className="database-page sources-page" role="dialog" aria-modal="true" aria-label="資料來源說明">
<header>
<div>
<p className="eyebrow">DATA SOURCES</p>
<h2>資料來源說明</h2>
<p>說明網站的官方資料、新聞線索、更新方式與使用限制。</p>
</div>
<button className="database-close" onClick={() => setSourcesOpen(false)}>關閉 ×</button>
</header>
<div className="sources-body">
<div className="source-priority">
<strong>判讀優先順序</strong>
<p>
<b>官方紀錄</b>是主要查核依據；<b>新聞</b>只作補充線索。任何名稱命中仍需確認是否為同一產品、品牌、公司或事件。</p>
</div>
<div className="source-grid">
<article>
<span className="source-badge official">官方資料 1</span>
<h3>違規食品廣告資料</h3>
<dl>
<div>
<dt>提供單位</dt>
<dd>衛生福利部食品藥物管理署及各地方衛生主管機關</dd>
</div>
<div>
<dt>收錄內容</dt>
<dd>違規產品、業者、處分日期、處分機關、法條、刊播媒體及查處情形</dd>
</div>
<div>
<dt>本站範圍</dt>
<dd>每天取得資料後，只保留滾動一年內紀錄</dd>
</div>
</dl>
<a href={ADS_DATASET_URL} target="_blank" rel="noreferrer">開啟政府資料集 6949 ↗</a>
</article>
<article>
<span className="source-badge official">官方資料 2</span>
<h3>邊境查驗不符合食品資訊</h3>
<dl>
<div>
<dt>提供單位</dt>
<dd>衛生福利部食品藥物管理署</dd>
</div>
<div>
<dt>收錄內容</dt>
<dd>進口商品、品牌、進口商、製造廠或出口商、不合格原因及處置情形</dd>
</div>
<div>
<dt>本站範圍</dt>
<dd>每天取得資料後，只保留滾動一年內紀錄</dd>
</div>
</dl>
<a href={IMPORTS_DATASET_URL} target="_blank" rel="noreferrer">開啟政府資料集 6133 ↗</a>
</article>
<article>
<span className="source-badge official">官方資料 3</span>
<h3>六都衛生局第二層資料</h3>
<dl>
<div><dt>涵蓋單位</dt><dd>臺北、新北、桃園、臺中、臺南及高雄市政府衛生局</dd></div>
<div><dt>自動比對</dt><dd>只納入具有產品、業者、日期及不符合內容的結構化紀錄；PDF 或公告索引僅提供人工開啟，不直接判定命中</dd></div>
<div><dt>更新方式</dt><dd>每天逐一連線；單一城市失敗會顯示狀態，不影響其他來源</dd></div>
</dl>
<a href={LOCAL_HEALTH_URL} target="_blank" rel="noreferrer">查看全國地方衛生機關 ↗</a>
</article>
<article>
<span className="source-badge news">新聞線索</span>
<h3>Google 新聞每日搜尋</h3>
<dl>
<div>
<dt>搜尋平台</dt>
<dd>Google 新聞 RSS；實際原文來自各新聞媒體</dd>
</div>
<div>
<dt>搜尋詞</dt>
<dd>食品違規、食品裁罰、食品誇大廣告、食品不合格、食品回收、食品下架</dd>
</div>
<div>
<dt>篩選方式</dt>
<dd>保留一年內且標題包含違規、裁罰、誇大、下架、不合格、回收、處分、遭罰或開罰等事件詞的新聞</dd>
</div>
</dl>
<a href={GOOGLE_NEWS_URL} target="_blank" rel="noreferrer">開啟 Google 新聞 ↗</a>
</article>
<article>
<span className="source-badge manual">人工資料</span>
<h3>人工核准新聞線索</h3>
<dl>
<div>
<dt>資料來源</dt>
<dd>使用者提交新聞原始網址與補充說明</dd>
</div>
<div>
<dt>核准方式</dt>
<dd>管理者在 GitHub 審核原文、日期、產品或業者同一性後，留言「/收錄」才寫入共用資料</dd>
</div>
<div>
<dt>用途</dt>
<dd>補充自動新聞搜尋可能漏掉的海外新聞、品牌別名或特定產品事件</dd>
</div>
</dl>
<a href={ISSUES_URL} target="_blank" rel="noreferrer">查看 GitHub 審核紀錄 ↗</a>
</article>
</div>
<section className="source-process">
<h3>更新與查核方式</h3>
<div>
<span>
<b>每天約 08:20</b>
<small>GitHub 自動抓取食藥署、六都衛生局與新聞線索；實際完成時間可能稍有延遲。</small>
</span>
<span>
<b>滾動一年</b>
<small>查核日期會隨每天更新往前移動，不是固定年度資料。</small>
</span>
<span>
<b>名稱自動比對</b>
<small>以產品、品牌、供應商、進口商或製造商名稱比對；統編目前只保留在清單中，未作主要比對。</small>
</span>
<span>
<b>人工確認</b>
<small>新聞標題或同一業者命中，不代表清單中的特定商品本身違規。</small>
</span>
</div>
</section>
<section className="source-laws">
<h3>誇大不實的官方法規依據</h3>
<p>網站不再以購物頁關鍵詞直接判定誇大不實，主要參考主管機關違規資料及以下官方法規。</p>
<div>
<a href={ARTICLE_28_URL} target="_blank" rel="noreferrer">食品安全衛生管理法第 28 條 ↗</a>
<a href={LAW_URL} target="_blank" rel="noreferrer">食品廣告標示與認定準則 ↗</a>
</div>
</section>
<p className="source-disclaimer">資料來源網站若暫停服務、欄位變更或尚未公布案件，本網站可能暫時無法取得；「本次未命中」不等於絕對沒有違規。</p>
</div>
</section>}
    {selectedEvidence && <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setSelectedEvidence(null)}>
<section className="review-modal evidence-modal" role="dialog" aria-modal="true">
<button className="close" onClick={() => setSelectedEvidence(null)}>×</button>
<p className="eyebrow">EVIDENCE DETAIL</p>
<h2>{selectedEvidence.kind.includes("新聞") ? "新聞線索詳情" : "官方原始紀錄摘要"}</h2>
<div className="relation-box">
<strong>為什麼與清單有關？</strong>
<p>{selectedEvidence.basis}</p>{selectedEvidence.basis.includes("其他產品") && <small>這只證明該供應商一年內有違規紀錄，不代表您清單中的商品本身違規。</small>}</div>
<dl className="evidence-detail">
<div>
<dt>{selectedEvidence.kind.includes("新聞") ? "新聞標題" : "官方紀錄產品"}</dt>
<dd>{selectedEvidence.recordProduct || selectedEvidence.title}</dd>
</div>{selectedEvidence.recordCompany && <div>
<dt>官方紀錄業者</dt>
<dd>{selectedEvidence.recordCompany}</dd>
</div>}<div>
<dt>日期</dt>
<dd>{selectedEvidence.date}</dd>
</div>
<div>
<dt>來源／處分機關</dt>
<dd>{selectedEvidence.source}</dd>
</div>{selectedEvidence.reason && <div>
<dt>法條／原因</dt>
<dd>{selectedEvidence.reason}</dd>
</div>}{selectedEvidence.media && <div>
<dt>刊播媒體</dt>
<dd>{selectedEvidence.media}</dd>
</div>}{selectedEvidence.action && <div>
<dt>查處情形</dt>
<dd>{selectedEvidence.action}</dd>
</div>}</dl>
<a className="source-link" href={selectedEvidence.url} target="_blank" rel="noreferrer">{selectedEvidence.kind.includes("新聞") ? "開啟新聞原文 ↗" : "開啟政府完整資料集 ↗"}</a>{!selectedEvidence.kind.includes("新聞") && <p className="dataset-note">政府開放資料目前沒有每筆紀錄的專屬網址；上方內容是系統從該完整資料集擷取的同一筆欄位。</p>}</section>
</div>}
    <footer>
<span>食安違規查核台 · 免費採購風險初篩工具</span>
<span>查核期間：{dateLabel}</span>
</footer>
  </main>;
}
