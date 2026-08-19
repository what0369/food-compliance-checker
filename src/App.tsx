"use client";

import { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";

type UploadRow = { product: string; supplier: string; brand: string; manufacturer: string; taxId: string; adUrl: string; claimText: string; keyword?: string };
type Status = "產品紀錄命中" | "供應商紀錄命中" | "新聞疑似命中" | "待查購物頁" | "資料不足";
type Evidence = { kind: string; title: string; date: string; source: string; url: string; basis: string; reason?: string; recordCompany?: string; recordProduct?: string; media?: string; action?: string };
type Result = UploadRow & { status: Status; count: number; latest: string; note: string; query: string; evidence: Evidence[] };
type OfficialItem = { kind: string; product: string; company: string; date: string; authority: string; reason: string; url: string; manufacturer?: string; brand?: string; media?: string; action?: string };
type NewsItem = { title: string; url: string; date: string; source: string };
type ClaimFinding = { title: string; basis: string; matches: string[] };

const LAW_URL = "https://www.fda.gov.tw/TC/newsContent.aspx?cid=3&id=30551";
const ARTICLE_28_URL = "https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=L0040001&flno=28";
const STORAGE_KEY = "food-compliance-free-check-v5";
const CLAIM_RULES = [
  { title: "疑似涉及疾病預防、改善或治療", basis: "認定準則第 5 條第 1 款", terms: ["治療", "治癒", "預防癌", "抗癌", "改善糖尿病", "改善高血壓", "消炎", "止痛", "抗病毒", "改善過敏", "改善失眠", "護肝解毒"] },
  { title: "疑似涉及降低致病相關體內成分", basis: "認定準則第 5 條第 2 款", terms: ["降血糖", "降低血糖", "降血壓", "降低血壓", "降膽固醇", "降低膽固醇", "降血脂", "清除血栓", "排除毒素"] },
  { title: "疑似涉及改變人體功能或外觀", basis: "認定準則第 4 條", terms: ["燃燒脂肪", "減肥", "瘦身", "豐胸", "增高", "改善體質", "提升免疫力", "促進代謝", "調節生理機能", "改善循環", "抗氧化"] },
  { title: "疑似為無充分佐證的絕對或保證宣稱", basis: "認定準則第 4 條", terms: ["保證有效", "絕對有效", "立即見效", "零副作用", "百分之百", "100%有效", "醫師推薦", "第一名", "唯一", "最有效", "奇蹟", "根治"] },
];
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
function searchUrl(kind: "official" | "news" | "shopping", query: string) {
  const exact = query || "食品";
  if (kind === "news") return `https://news.google.com/search?q=${encodeURIComponent(`${exact} 違規 OR 裁罰 OR 誇大廣告`)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  if (kind === "shopping") return `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(`${exact} 功效`)}`;
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
function analyzeClaims(text: string): ClaimFinding[] {
  const normalized = compact(text); if (!normalized) return [];
  return CLAIM_RULES.map((rule) => ({ ...rule, matches: rule.terms.filter((term) => normalized.includes(compact(term))) })).filter((rule) => rule.matches.length).map(({ title, basis, matches }) => ({ title, basis, matches }));
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
  const [reviewing, setReviewing] = useState<Result | null>(null);
  const [selectedEvidence, setSelectedEvidence] = useState<Evidence | null>(null);
  const [claimText, setClaimText] = useState("");
  const [findings, setFindings] = useState<ClaimFinding[] | null>(null);
  const shown = useMemo(() => filter === "all" ? results : filter === "official" ? results.filter((item) => item.status === "產品紀錄命中" || item.status === "供應商紀錄命中") : results.filter((item) => item.status === filter), [results, filter]);
  const stats = useMemo(() => ({ total: results.length, official: results.filter((item) => item.status === "產品紀錄命中" || item.status === "供應商紀錄命中").length, news: results.filter((item) => item.status === "新聞疑似命中").length, shopping: results.filter((item) => item.status === "待查購物頁").length, insufficient: results.filter((item) => item.status === "資料不足").length }), [results]);
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
      setProgress("1/3 下載食藥署一年內免費開放資料…");
      const base = import.meta.env.BASE_URL;
      const officialResponse = await fetch(`${base}data/official.json`, { cache: "no-store" });
      if (!officialResponse.ok) throw new Error("食藥署資料暫時無法讀取，請稍後重試。");
      const official = await officialResponse.json() as { ads: OfficialItem[]; imports: OfficialItem[]; adsAvailable: boolean; importsAvailable: boolean };
      const officialItems = [...official.ads, ...official.imports];
      setProgress("2/3 讀取 GitHub 每日更新的新聞線索庫…");
      const newsResponse = await fetch(`${base}data/news.json`, { cache: "no-store" });
      const newsPayload = newsResponse.ok ? await newsResponse.json() as { items: NewsItem[]; available: boolean } : { items: [], available: false };
      setProgress("3/3 整理命中證據並保存結果…");
      const checked = targetRows.map<Result>((row) => {
        const query = makeQuery(row);
        if (!query) return { ...row, query, status: "資料不足", count: 0, latest: "—", note: "至少需要產品、品牌、供應商或製造商名稱之一。", evidence: [] };
        const matched = officialMatches(row, officialItems);
        const news = newsMatches(row, newsPayload.items);
        const officialEvidence = matched.map<Evidence>(({ item, basis }) => ({ kind: item.kind, title: item.product || item.company, date: item.date, source: item.authority, url: item.url, reason: item.reason, basis, recordCompany: item.company || item.manufacturer, recordProduct: item.product, media: item.media, action: item.action }));
        const newsEvidence = news.map<Evidence>((item) => ({ kind: "新聞搜尋線索", title: item.title, date: item.date, source: item.source || "Google 新聞", url: item.url, basis: `新聞標題明確包含「${newsKey(row)}」及風險事件詞` }));
        if (officialEvidence.length) {
          const productLevel = officialEvidence.some((item) => item.basis.includes("產品名稱") || item.basis.includes("產品／品牌相符"));
          return { ...row, query, status: productLevel ? "產品紀錄命中" : "供應商紀錄命中", count: officialEvidence.length, latest: officialEvidence.map((item) => item.date).sort().reverse()[0], note: productLevel ? "官方紀錄與產品名稱高度相符，仍請核對包裝與業者。" : "這是同一供應商的違規紀錄，可能是其他產品；不代表本商品本身違規。", evidence: [...officialEvidence, ...newsEvidence] };
        }
        if (newsEvidence.length) return { ...row, query, status: "新聞疑似命中", count: newsEvidence.length, latest: newsEvidence[0].date, note: "新聞僅為查核線索，須開啟原文並核對事件、日期與同一性。", evidence: newsEvidence };
        return { ...row, query, status: "待查購物頁", count: 0, latest: "—", note: "官方與免費新聞未命中不等於無違規；請繼續核對購物頁宣稱。", evidence: [] };
      });
      setResults(checked);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ fileName: sourceName, rowCount: targetRows.length, results: checked, checkedAt: new Date().toISOString() }));
      if (!official.adsAvailable || !official.importsAvailable || !newsPayload.available) setSourceWarning("部分每日資料尚未更新；結果不可視為完整查核，請使用每列的人工搜尋入口補查。");
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
    const sheet = XLSX.utils.json_to_sheet([{ "產品名稱": "範例產品", "供應商名稱": "範例供應商股份有限公司", "品牌完整名稱": "範例品牌", "製造商／進口商名稱": "", "統一編號（選填）": "", "商品／廣告網址（選填）": "", "購物頁宣稱文字（選填）": "" }]);
    const guide = XLSX.utils.aoa_to_sheet([["欄位", "必要性", "說明"], ["產品／品牌／供應商／製造商", "至少一項", "名稱越完整，比對越準確"], ["統一編號", "選填", "未提供仍可用名稱初篩"], ["商品／廣告網址", "選填", "未提供時可搜尋購物網站"], ["購物頁宣稱文字", "選填", "貼入後依食品廣告法規做關鍵詞風險初篩"]]);
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, "查詢清單"); XLSX.utils.book_append_sheet(book, guide, "填寫說明"); XLSX.writeFile(book, "食品違規查核_免費自動查核範本.xlsx");
  }
  function exportResults() {
    const sheet = XLSX.utils.json_to_sheet(results.map((item) => ({ "快速查核關鍵字": item.keyword || "", "產品名稱": item.product, "品牌": item.brand, "供應商": item.supplier, "製造商／進口商": item.manufacturer, "統編（選填）": item.taxId, "商品／廣告網址（選填）": item.adUrl, "查核狀態": item.status, "一年內命中筆數": item.count, "最新日期": item.latest, "證據關聯理由": item.evidence.map((e) => e.basis).join("｜"), "官方紀錄產品": item.evidence.map((e) => e.recordProduct || "").filter(Boolean).join("｜"), "官方紀錄業者": item.evidence.map((e) => e.recordCompany || "").filter(Boolean).join("｜"), "處分法條／原因": item.evidence.map((e) => e.reason || "").filter(Boolean).join("｜"), "證據標題": item.evidence.map((e) => e.title).join("｜"), "證據網址": item.evidence.map((e) => e.url).join("｜"), "官方人工搜尋": searchUrl("official", item.query), "新聞人工搜尋": searchUrl("news", item.query), "購物網站搜尋": searchUrl("shopping", item.query), "備註": item.note })));
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, "查核結果"); XLSX.writeFile(book, `一年內免費自動查核結果_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }
  function openReview(item: Result) { setReviewing(item); setClaimText(item.claimText); setFindings(item.claimText ? analyzeClaims(item.claimText) : null); }

  return <main>
    <header className="topbar"><a className="brand" href="#top"><span>查</span><div><b>食安違規查核台</b><small>FREE COMPLIANCE CHECK</small></div></a><div className="period"><i />滾動查核期間：{dateLabel}</div></header>
    <section className="hero" id="top"><div className="hero-copy"><p className="eyebrow">零額外查詢費</p><h1>輸入關鍵字或上傳 Excel<br/><em>完成官方與新聞初查</em></h1><p className="lead">輸入產品、品牌或供應商名稱即可單筆查核；大量清單則上傳 Excel。系統自動比對食藥署一年內公開資料與新聞線索，再提供購物頁及法規補查入口。</p><div className="source-chips"><span>食藥署開放資料</span><span>免費新聞搜尋</span><span>購物網站宣稱</span><span>瀏覽器保存進度</span></div></div>
      <div className="upload-card"><div className="step-label"><span>1</span>快速查核或匯入清單</div><div className="quick-search"><label htmlFor="quick-keyword">不用 Excel，直接輸入名稱</label><div><input id="quick-keyword" value={keyword} onChange={(e) => { setKeyword(e.target.value); setError(""); }} onKeyDown={(e) => e.key === "Enter" && !loading && runKeywordCheck()} placeholder="例如：供應商名稱、品牌或產品名稱"/><button disabled={!keyword.trim() || loading} onClick={runKeywordCheck}>立即查核</button></div><small>系統會自動判別並同時比對產品與業者名稱</small></div><div className="or-divider"><span>或批次上傳 Excel</span></div><button className={`dropzone ${fileName && !rows[0]?.keyword ? "has-file" : ""}`} onClick={() => inputRef.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const file = e.dataTransfer.files[0]; if (file) readFile(file); }}><input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])}/><span className="file-icon">{fileName && !rows[0]?.keyword ? "✓" : "XL"}</span><strong>{fileName && !rows[0]?.keyword ? fileName : "拖曳 Excel 到這裡，或點擊選擇"}</strong><small>{fileName && !rows[0]?.keyword ? `已讀取 ${rows.length} 筆有效資料` : "產品、品牌或業者至少一項｜統編與網址選填"}</small></button>{error && <p className="error">{error}</p>}{sourceWarning && <p className="warning-box">{sourceWarning}</p>}<div className="upload-actions"><button className="text-btn" onClick={downloadTemplate}>↓ 下載新版範本</button><button className="text-btn" onClick={useSample}>使用範例資料</button></div><button className="primary" disabled={!rows.length || loading || Boolean(rows[0]?.keyword)} onClick={runCheck}>{loading ? <><span className="spinner"/>免費自動查核中…</> : `批次自動查核${rows.length && !rows[0]?.keyword ? `（${rows.length} 筆）` : ""}`}</button>{progress && <p className="progress">{progress}</p>}<p className="privacy">不使用付費 AI API；Excel 在瀏覽器解析，查核結果保存在此裝置。</p></div>
    </section>
    <section className="workflow"><div><b>01</b><span><strong>官方自動比對</strong><small>兩套食藥署開放資料</small></span></div><i>→</i><div><b>02</b><span><strong>新聞自動搜尋</strong><small>一年內事件線索</small></span></div><i>→</i><div><b>03</b><span><strong>購物頁人工取得</strong><small>保留搜尋入口</small></span></div><i>→</i><div><b>04</b><span><strong>宣稱法規初篩</strong><small>第 28 條與認定準則</small></span></div></section>
    <section className="content"><div className="section-head"><div><p className="eyebrow">CHECK RESULTS</p><h2>查核結果</h2><p>{results.length ? `已完成 ${results.length} 筆免費初查；命中結果仍需核對同一性。` : "上傳清單後按一次按鈕，系統會自動完成可取得的免費查核。"}</p></div>{results.length > 0 && <button className="export" onClick={exportResults}>↓ 匯出 Excel 結果</button>}</div>
      <div className="stats five"><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}><span>全部</span><b>{stats.total}</b><small>筆對象</small></button><button className={`danger ${filter === "official" ? "active" : ""}`} onClick={() => setFilter("official")}><span>官方命中</span><b>{stats.official}</b><small>分產品／供應商</small></button><button className={`news ${filter === "新聞疑似命中" ? "active" : ""}`} onClick={() => setFilter("新聞疑似命中")}><span>新聞線索</span><b>{stats.news}</b><small>開原文確認</small></button><button className={`warning ${filter === "待查購物頁" ? "active" : ""}`} onClick={() => setFilter("待查購物頁")}><span>待查購物頁</span><b>{stats.shopping}</b><small>不可判為無違規</small></button><button className={filter === "資料不足" ? "active" : ""} onClick={() => setFilter("資料不足")}><span>資料不足</span><b>{stats.insufficient}</b><small>需補名稱</small></button></div>
      <div className="result-panel">{shown.length ? <div className="table-wrap"><table><thead><tr><th>狀態</th><th>產品／業者</th><th>自動找到的證據</th><th>人工補查</th><th>購物頁與法規</th><th>備註</th></tr></thead><tbody>{shown.map((item, index) => <tr key={`${item.keyword || item.product}-${index}`}><td><span className={`status status-${item.status}`}>{item.status}</span><small className="date">{item.latest}</small></td><td><strong>{item.keyword || item.product || item.brand || "未提供產品"}</strong><small>{item.keyword ? "快速關鍵字查核（自動判別產品或業者）" : [item.brand, item.supplier, item.manufacturer].filter(Boolean).join("｜") || "未提供業者"}</small>{!item.keyword && <small className="optional">統編：{item.taxId || "未提供（選填）"}</small>}</td><td>{item.evidence.length ? <div className="evidence-list">{item.evidence.slice(0, 3).map((e, i) => <button key={`${e.url}-${i}`} onClick={() => setSelectedEvidence(e)}><b>{e.kind}</b><span>{e.date}｜{e.title}</span><small>{e.basis}</small><em>查看完整紀錄 →</em></button>)}</div> : <small>本次免費來源未命中</small>}</td><td><div className="search-actions"><a href={searchUrl("official", item.query)} target="_blank" rel="noreferrer">查官方 ↗</a><a href={searchUrl("news", item.query)} target="_blank" rel="noreferrer">查新聞 ↗</a></div></td><td><div className="search-actions"><a className="shopping" href={item.adUrl || searchUrl("shopping", item.query)} target="_blank" rel="noreferrer">{item.adUrl ? "開啟商品頁 ↗" : "搜尋購物網站 ↗"}</a></div><button className="review-btn" onClick={() => openReview(item)}>貼入宣稱並對照法規</button></td><td><small className="note">{item.note}</small></td></tr>)}</tbody></table></div> : <div className="empty"><div className="radar"><i/><i/><i/></div><h3>尚未執行免費自動查核</h3><p>直接輸入關鍵字，或上傳 Excel 後開始查核。</p></div>}</div>
      <div className="method"><div><span className="method-icon">i</span><div><strong>必要判讀原則</strong><p>未命中不等於無違規；新聞只是線索。官方資料採名稱自動比對，仍須確認是否為同一公司或產品。購物頁關鍵詞只做風險提示，最後需人工綜合判斷。</p></div></div><div className="law-links"><a href={ARTICLE_28_URL} target="_blank" rel="noreferrer">食安法第 28 條 ↗</a><a href={LAW_URL} target="_blank" rel="noreferrer">廣告認定準則 ↗</a></div></div>
    </section>
    {reviewing && <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setReviewing(null)}><section className="review-modal" role="dialog" aria-modal="true"><button className="close" onClick={() => setReviewing(null)}>×</button><p className="eyebrow">SHOPPING CLAIM REVIEW</p><h2>購物頁宣稱 × 法規對照</h2><p className="review-product"><strong>{reviewing.product || reviewing.brand}</strong><span>{reviewing.supplier || reviewing.manufacturer}</span></p><div className="review-searches"><a href={searchUrl("official", reviewing.query)} target="_blank" rel="noreferrer"><b>1</b><span><strong>查官方紀錄</strong><small>政府網站 ↗</small></span></a><a href={searchUrl("news", reviewing.query)} target="_blank" rel="noreferrer"><b>2</b><span><strong>查新聞網站</strong><small>事件原文 ↗</small></span></a><a href={reviewing.adUrl || searchUrl("shopping", reviewing.query)} target="_blank" rel="noreferrer"><b>3</b><span><strong>搜尋購物網站</strong><small>取得實際文案 ↗</small></span></a></div><label className="claim-label" htmlFor="claim-text">貼入品名、功效文案與圖片文字</label><textarea id="claim-text" value={claimText} onChange={(e) => { setClaimText(e.target.value); setFindings(null); }} placeholder="例如：促進代謝、降低膽固醇、改善睡眠……"/><button className="primary analyze" disabled={!claimText.trim()} onClick={() => setFindings(analyzeClaims(claimText))}>依食品廣告法規初篩</button>{findings && <div className={`findings ${findings.length ? "has-risk" : "no-risk"}`}><strong>{findings.length ? `發現 ${findings.length} 類疑似風險` : "未命中內建高風險詞句"}</strong><p>{findings.length ? "請核對全文、圖片、證據及產品屬性後，由人工判定。" : "這不等於法規合格，仍須依頁面整體表現人工審查。"}</p>{findings.map((f) => <div className="finding" key={f.title}><b>{f.title}</b><small>{f.basis}</small><span>{f.matches.join("、")}</span></div>)}</div>}<div className="legal-note"><strong>法規基準</strong><p>食品廣告不得有不實、誇張、易生誤解或醫療效能宣稱；須依頁面整體表現判斷。</p><div><a href={ARTICLE_28_URL} target="_blank" rel="noreferrer">食品安全衛生管理法第 28 條 ↗</a><a href={LAW_URL} target="_blank" rel="noreferrer">認定準則與附件 ↗</a></div></div></section></div>}
    {selectedEvidence && <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setSelectedEvidence(null)}><section className="review-modal evidence-modal" role="dialog" aria-modal="true"><button className="close" onClick={() => setSelectedEvidence(null)}>×</button><p className="eyebrow">EVIDENCE DETAIL</p><h2>{selectedEvidence.kind === "新聞搜尋線索" ? "新聞線索詳情" : "官方原始紀錄摘要"}</h2><div className="relation-box"><strong>為什麼與清單有關？</strong><p>{selectedEvidence.basis}</p>{selectedEvidence.basis.includes("其他產品") && <small>這只證明該供應商一年內有違規紀錄，不代表您清單中的商品本身違規。</small>}</div><dl className="evidence-detail"><div><dt>{selectedEvidence.kind === "新聞搜尋線索" ? "新聞標題" : "官方紀錄產品"}</dt><dd>{selectedEvidence.recordProduct || selectedEvidence.title}</dd></div>{selectedEvidence.recordCompany && <div><dt>官方紀錄業者</dt><dd>{selectedEvidence.recordCompany}</dd></div>}<div><dt>日期</dt><dd>{selectedEvidence.date}</dd></div><div><dt>來源／處分機關</dt><dd>{selectedEvidence.source}</dd></div>{selectedEvidence.reason && <div><dt>法條／原因</dt><dd>{selectedEvidence.reason}</dd></div>}{selectedEvidence.media && <div><dt>刊播媒體</dt><dd>{selectedEvidence.media}</dd></div>}{selectedEvidence.action && <div><dt>查處情形</dt><dd>{selectedEvidence.action}</dd></div>}</dl><a className="source-link" href={selectedEvidence.url} target="_blank" rel="noreferrer">{selectedEvidence.kind === "新聞搜尋線索" ? "開啟新聞原文 ↗" : "開啟政府完整資料集 ↗"}</a>{selectedEvidence.kind !== "新聞搜尋線索" && <p className="dataset-note">政府開放資料目前沒有每筆紀錄的專屬網址；上方內容是系統從該完整資料集擷取的同一筆欄位。</p>}</section></div>}
    <footer><span>食安違規查核台 · 免費採購風險初篩工具</span><span>查核期間：{dateLabel}</span></footer>
  </main>;
}
