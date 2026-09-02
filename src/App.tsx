"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";

type UploadRow = { product: string; contents: string; supplier: string; brand: string; manufacturer: string; taxId: string; adUrl: string; claimText: string; keyword?: string };
type Status = "同商品紀錄" | "相關品類，需加強查證" | "同品牌／供應商其他商品" | "新聞線索" | "本次未命中" | "資料不足";
type Relation = "sameProduct" | "relatedCategory" | "sameParty" | "news";
type Evidence = { kind: string; title: string; date: string; source: string; url: string; basis: string; relation: Relation; reason?: string; recordCompany?: string; recordProduct?: string; media?: string; action?: string; parsedProducts?: string[]; parsedCompanies?: string[]; evidenceSentence?: string; parseStatus?: "parsed" | "titleOnly" };
type OfficialMatch = { item: OfficialItem; relation: Exclude<Relation, "news">; basis: string };
type Result = UploadRow & { status: Status; count: number; latest: string; note: string; query: string; evidence: Evidence[] };
type OfficialItem = { kind: string; product: string; company: string; date: string; authority: string; reason: string; url: string; manufacturer?: string; brand?: string; media?: string; action?: string; city?: string; sourceLayer?: string; matchable?: boolean; parseStatus?: string; correctionIssueUrl?: string; correctionNote?: string; correctionApprovedAt?: string };
type LocalSource = { city: string; datasetUrl: string; mode: string; status: string; recordCount: number; message?: string };
type NewsItem = { title: string; url: string; articleUrl?: string; date: string; source: string; region?: string; manual?: boolean; note?: string; products?: string[]; companies?: string[]; brands?: string[]; manufacturers?: string[]; importers?: string[]; suppliers?: string[]; retailers?: string[]; otherCompanies?: string[]; evidence?: string[]; parseStatus?: "parsed" | "titleOnly"; parseMessage?: string; correctionIssueUrl?: string; correctionNote?: string; correctionApprovedAt?: string; originalParsedEntities?: { products?: string[]; companies?: string[]; brands?: string[]; manufacturers?: string[]; importers?: string[]; suppliers?: string[]; retailers?: string[]; otherCompanies?: string[]; evidence?: string[] } };
type ManualNewsItem = NewsItem & { note?: string; approvedAt?: string; issueUrl?: string };
type NewsSubmission = { url: string; note: string };
type LocalCorrectionSubmission = { product: string; company: string; manufacturer: string; reason: string };
type NewsCorrectionSubmission = { products: string; brands: string; manufacturers: string; importers: string; suppliers: string; retailers: string; companies: string; evidence: string; reason: string };
type ReviewKind = "news" | "correction" | "newsCorrection";
type GitHubReviewIssue = { number: number; title: string; body: string | null; html_url: string; created_at: string; user?: { login?: string }; pull_request?: unknown };
type DatabaseTab = "official" | "local" | "manual" | "daily";
type DatabaseData = { official: OfficialItem[]; local: OfficialItem[]; localPending: OfficialItem[]; localRawCount: number; localRetryCount: number; localNoEvidenceCount: number; localSources: LocalSource[]; manual: ManualNewsItem[]; daily: NewsItem[]; officialUpdatedAt: string; localUpdatedAt: string; manualUpdatedAt: string; dailyUpdatedAt: string };

const LAW_URL = "https://www.fda.gov.tw/TC/newsContent.aspx?cid=3&id=30551";
const ARTICLE_28_URL = "https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=L0040001&flno=28";
const ADS_DATASET_URL = "https://data.gov.tw/dataset/6949";
const IMPORTS_DATASET_URL = "https://data.gov.tw/dataset/6133";
const GOOGLE_NEWS_URL = "https://news.google.com/home?hl=zh-TW&gl=TW&ceid=TW:zh-Hant";
const LOCAL_HEALTH_URL = "https://service.mohw.gov.tw/HealthCenter/";
const HEALTH_NEWS_URL = "https://www.fda.gov.tw/tc/csmnews.aspx";
const NEW_ISSUE_URL = "https://github.com/what0369/food-compliance-checker/issues/new";
const ANONYMOUS_NEWS_URL = "https://script.google.com/macros/s/AKfycbz1VZ1mwm4Q-6r6DdXcaR0kp51iGLmg-0PjmXv98Ok02uDaz_uxhy5B-ND66l0w5XM/exec";
const ISSUES_URL = "https://github.com/what0369/food-compliance-checker/issues";
const ADMIN_HASH = "#/admin-review";
const GITHUB_OWNER = "what0369";
const GITHUB_REPO = "food-compliance-checker";
const GITHUB_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";
const STORAGE_KEY = "food-compliance-free-check-v6";
const VERSION_LABEL = `v${__APP_VERSION__}`;
const BUILD_LABEL = __BUILD_ID__ === "local" ? "本機預覽" : __BUILD_ID__;
const SAMPLE_ROWS: UploadRow[] = [
  { product: "Slimmit食事對抗酵素", contents: "", supplier: "健康生活商行", brand: "Slimmit", manufacturer: "", taxId: "", adUrl: "", claimText: "六個月降低體重，促進代謝並降低膽固醇。" },
  { product: "原味燕麥片", contents: "燕麥", supplier: "日常食品股份有限公司", brand: "日日好食", manufacturer: "", taxId: "", adUrl: "", claimText: "" },
  { product: "媽媽蔛 3包組合", contents: "", supplier: "美好購物網", brand: "媽媽蔛", manufacturer: "", taxId: "", adUrl: "", claimText: "" },
];

const clean = (value: unknown) => String(value ?? "").trim();
const compact = (value: string) => value.toLowerCase().replace(/[\s　\p{P}\p{S}]/gu, "");
const companyCore = (value: string) => compact(value).replace(/股份有限公司|有限公司|企業社|商行|公司$/g, "");
const nonEmpty = (value: string) => value.length > 0;
const normalizedHeader = (value: string) => value.replace(/[\s　]/g, "").replace(/[／/]/g, "／");
function findValue(row: Record<string, unknown>, names: string[]) {
  const keys = Object.keys(row);
  for (const name of names) {
    const target = normalizedHeader(name);
    const key = keys.find((item) => normalizedHeader(item).includes(target));
    if (key && clean(row[key])) return clean(row[key]);
  }
  return "";
}
function parseWorkbookRows(workbook: XLSX.WorkBook) {
  const productHeaders = ["品項名稱", "產品名稱", "子產品名稱", "商品名稱", "品名"];
  const partyHeaders = ["品牌完整名稱", "供應商名稱", "公司登記名稱", "商戶名稱", "商家名稱", "業者名稱"];
  const parsed: UploadRow[] = [];
  const matchedSheets: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const preview = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", range: 0 }).slice(0, 20);
    const headerIndex = preview.findIndex((cells) => {
      const headers = cells.map((cell) => normalizedHeader(clean(cell)));
      return productHeaders.some((name) => headers.some((header) => header.includes(normalizedHeader(name)))) && partyHeaders.some((name) => headers.some((header) => header.includes(normalizedHeader(name))));
    });
    if (headerIndex < 0) continue;
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", range: headerIndex });
    const rows = raw.map((row) => ({
      product: findValue(row, ["品項名稱", "產品名稱", "子產品名稱", "商品名稱", "品名", "產品", "商品"]),
      contents: findValue(row, ["完整內容物", "內容物名稱", "內容物", "成分"]),
      supplier: findValue(row, ["商戶名稱(提案公司二)", "公司登記名稱", "供應商名稱", "供應商", "業者名稱", "公司名稱", "業者"]),
      brand: findValue(row, ["品牌完整名稱", "商家名稱", "品牌名稱", "品牌"]),
      manufacturer: findValue(row, ["製造商／進口商名稱", "製造商/進口商名稱", "製造商", "進口商"]),
      taxId: findValue(row, ["統一編號", "統編"]),
      adUrl: findValue(row, ["商品／廣告網址", "商品/廣告網址", "廣告網址", "商品網址", "網址"]),
      claimText: findValue(row, ["購物頁宣稱文字", "廣告宣稱文字", "宣稱文字", "廣告文字"]),
    })).filter((row) => row.product || row.supplier || row.brand || row.manufacturer);
    if (rows.length) { parsed.push(...rows); matchedSheets.push(sheetName); }
  }
  return { parsed, matchedSheets };
}
function makeQuery(row: UploadRow) { return [...new Set([row.keyword, row.brand, row.product, row.supplier, row.manufacturer].filter(Boolean))].slice(0, 3).join(" "); }
function newsKey(row: UploadRow) { return row.keyword || row.supplier || row.manufacturer || row.brand || row.product; }
const NEWS_CATEGORY_SUFFIX = /(?:泡菜|食品|美食|料理|烘焙|糕餅|油品|製油|茶葉|農產|伴手禮)$/;
function newsNameTerms(value: string, minimumLength = 3) {
  const full = companyCore(value);
  const withoutCategory = full.replace(NEWS_CATEGORY_SUFFIX, "");
  return [...new Set([full, withoutCategory])].filter((term) => term.length >= minimumLength);
}
function newsSearchable(item: NewsItem) {
  return compact([item.title, item.note || "", ...(item.products || []), ...allNewsCompanies(item), ...(item.brands || []), ...(item.evidence || [])].join(" "));
}
function newsRoleCompanies(item: NewsItem) { return [...new Set([...(item.manufacturers || []), ...(item.importers || []), ...(item.suppliers || []), ...(item.retailers || [])])]; }
function otherNewsCompanies(item: NewsItem) {
  if (Array.isArray(item.otherCompanies) && (item.otherCompanies.length || !(item.companies?.length))) return item.otherCompanies;
  const roleKeys = new Set(newsRoleCompanies(item).map(compact));
  return (item.companies || []).filter((company) => !roleKeys.has(compact(company)));
}
function allNewsCompanies(item: NewsItem) { return [...new Set([...(item.companies || []), ...newsRoleCompanies(item), ...otherNewsCompanies(item)])]; }
function newsMatches(row: UploadRow, items: NewsItem[]) {
  const keyword = row.keyword || "";
  const candidates = [...[row.supplier, row.manufacturer].flatMap((value) => newsNameTerms(value)), ...newsNameTerms(keyword, 2)];
  const productCandidates = [...[row.product, row.brand].flatMap((value) => newsNameTerms(value, 4)), ...[row.brand].flatMap((value) => newsNameTerms(value, 3)), ...newsNameTerms(keyword, 2)];
  return items.filter((item) => {
    const searchable = newsSearchable(item);
    return candidates.some((name) => searchable.includes(name)) || productCandidates.some((name) => searchable.includes(name));
  }).slice(0, 3);
}
function newsMatchBasis(row: UploadRow, item: NewsItem) {
  const fields = [row.keyword, row.supplier, row.manufacturer, row.brand, row.product].filter(Boolean) as string[];
  const title = compact(item.title);
  const bodyFields = compact([item.note || "", ...(item.products || []), ...allNewsCompanies(item), ...(item.brands || []), ...(item.evidence || [])].join(" "));
  const match = fields.flatMap((field) => newsNameTerms(field, field === row.keyword ? 2 : 3).map((term) => ({ field, term }))).find(({ term }) => title.includes(term) || bodyFields.includes(term));
  if (!match) return `新聞名稱與「${newsKey(row)}」可能相關；仍須開啟原文核對`;
  if (match.term !== compact(match.field)) return `新聞名稱「${match.term}」與清單名稱「${match.field}」部分相符；僅列新聞線索，須人工核對是否為同一品牌或業者`;
  if (bodyFields.includes(match.term) && !title.includes(match.term)) return `新聞內文解析出「${match.field}」；屬新聞線索，仍須開啟證據句核對`;
  return `新聞標題包含「${match.field}」及風險事件詞`;
}
function newsEvidenceSentence(row: UploadRow, item: NewsItem) {
  const fields = [row.keyword, row.supplier, row.manufacturer, row.brand, row.product].filter((field): field is string => Boolean(field)).flatMap((field) => newsNameTerms(field, field === row.keyword ? 2 : 3));
  return item.evidence?.find((sentence) => fields.some((field) => compact(sentence).includes(field))) || item.evidence?.[0];
}
function searchUrl(kind: "official" | "news", query: string) {
  const exact = query || "食品";
  if (kind === "news") return `https://news.google.com/search?q=${encodeURIComponent(`${exact} 違規 OR 裁罰 OR 誇大廣告`)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  return `https://www.google.com/search?q=${encodeURIComponent(`site:fda.gov.tw OR site:gov.tw ${exact} 違規 裁罰 食品`)}`;
}
function buildLocalCorrectionIssue(item: OfficialItem, correction: LocalCorrectionSubmission) {
  const shown = (value?: string) => clean(value) || "未提供";
  const safeReason = clean(correction.reason).replace(/^## /gm, "＃＃ ").slice(0, 1500);
  const body = [
    "## 官方來源", item.url,
    "", "## 目前網站資料",
    `- 日期：${shown(item.date)}`,
    `- 商品：${shown(item.product)}`,
    `- 業者：${shown(item.company)}`,
    `- 製造商：${shown(item.manufacturer)}`,
    `- 主管機關：${shown(item.authority)}`,
    "", "## 請填寫正確內容",
    `- 商品：${clean(correction.product)}`,
    `- 業者：${clean(correction.company)}`,
    `- 製造商：${clean(correction.manufacturer)}`,
    "", "## 修正理由或原文位置",
    safeReason,
    "", "---",
    "管理者核對官方來源後，在本 Issue 留言「/套用修正」即可核准；系統會保存人工修正，不直接覆寫官方原始資料。",
  ].join("\n");
  const titleName = clean(item.product || item.company).slice(0, 45) || "地方衛生局紀錄";
  return { body, url: `${NEW_ISSUE_URL}?${new URLSearchParams({ title: `資料欄位修正：${titleName}`, body }).toString()}` };
}

function issueList(value: string) {
  return value.split(/\r?\n/).map(clean).filter(Boolean).join("｜");
}

function buildNewsCorrectionIssue(item: NewsItem, correction: NewsCorrectionSubmission) {
  const shown = (values?: string[]) => values?.length ? values.join("｜") : "未提供";
  const safeReason = clean(correction.reason).replace(/^## /gm, "＃＃ ").slice(0, 1500);
  const body = [
    "## 新聞來源資料",
    `- 日期：${item.date}`,
    `- 標題：${clean(item.title)}`,
    `- 新聞網址：${item.url}`,
    `- 原文網址：${item.articleUrl || item.url}`,
    "", "## 目前解析結果",
    `- 商品／產品：${shown(item.products)}`,
    `- 品牌：${shown(item.brands)}`,
    `- 製造商：${shown(item.manufacturers)}`,
    `- 進口商：${shown(item.importers)}`,
    `- 供應商／來源業者：${shown(item.suppliers)}`,
    `- 販售商／通路：${shown(item.retailers)}`,
    `- 其他相關業者：${shown(otherNewsCompanies(item))}`,
    `- 證據句：${shown(item.evidence)}`,
    "", "## 請填寫正確內容",
    `- 商品／產品：${issueList(correction.products)}`,
    `- 品牌：${issueList(correction.brands)}`,
    `- 製造商：${issueList(correction.manufacturers)}`,
    `- 進口商：${issueList(correction.importers)}`,
    `- 供應商／來源業者：${issueList(correction.suppliers)}`,
    `- 販售商／通路：${issueList(correction.retailers)}`,
    `- 其他相關業者：${issueList(correction.companies)}`,
    `- 證據句：${issueList(correction.evidence)}`,
    "", "## 修正理由或原文位置",
    safeReason,
    "", "---",
    "管理者核對新聞原文後，在本 Issue 留言「/套用新聞修正」即可核准；系統保留原始解析結果並於每日更新後重新套用修正。",
  ].join("\n");
  const titleName = clean(item.title).replace(/\s+-\s+[^-]+$/, "").slice(0, 55) || "每日新聞線索";
  const title = `新聞解析修正：${titleName}`;
  return { title, body, url: `${NEW_ISSUE_URL}?${new URLSearchParams({ title, body }).toString()}` };
}
function strongProductMatch(left: string, right: string) {
  if (!left || !right) return false;
  if (left === right) return left.length >= 3;
  const shorter = Math.min(left.length, right.length);
  const longer = Math.max(left.length, right.length);
  return shorter >= 6 && shorter / longer >= 0.75 && (left.includes(right) || right.includes(left));
}
const CATEGORY_FAMILIES = [
  ["辣椒", "脆椒", "辣油", "椒麻", "川辣"], ["花椒", "麻辣"], ["胡椒"], ["咖哩", "香料"],
  ["芝麻", "麻仁"], ["花生"], ["堅果"], ["食用油", "沙拉油", "調和油", "橄欖油"],
  ["牛肉"], ["豬肉"], ["雞肉", "雞精"], ["魚", "鱈魚"], ["蝦"], ["蟹"],
  ["米", "米果"], ["茶"], ["咖啡"], ["蜂蜜"], ["燕窩"], ["蛋"], ["乳", "奶"], ["菇", "菌"],
];
function relatedCategoryMatch(row: UploadRow, item: OfficialItem) {
  const rowText = compact([row.product, row.contents].filter(Boolean).join(" "));
  const itemText = compact(item.product);
  if (!rowText || !itemText) return false;
  return CATEGORY_FAMILIES.some((family) => family.some((term) => rowText.includes(term)) && family.some((term) => itemText.includes(term)));
}
function officialMatches(row: UploadRow, items: OfficialItem[]) {
  const keyword = compact(row.keyword || "");
  const companies = [...[row.supplier, row.manufacturer].map(companyCore).filter((v) => v.length >= 3), ...(keyword.length >= 2 ? [companyCore(keyword)] : [])];
  const products = [...[row.product].map(compact).filter((v) => v.length >= 4), ...(keyword.length >= 3 ? [keyword] : [])];
  const brands = [...[row.brand].map(compact).filter((v) => v.length >= 3), ...(keyword.length >= 2 ? [keyword] : [])];
  return items.reduce<OfficialMatch[]>((matches, item) => {
    const itemCompanies = [item.company, item.manufacturer || ""].map(companyCore).filter(nonEmpty);
    const itemProducts = [item.product].map(compact).filter(nonEmpty);
    const itemBrands = [item.brand || ""].map(compact).filter(nonEmpty);
    const companyHit = companies.some((name) => itemCompanies.some((candidate) => candidate === name));
    const productHit = products.some((name) => itemProducts.some((candidate) => strongProductMatch(name, candidate) || (keyword.length >= 3 && (candidate.includes(keyword) || keyword.includes(candidate)))));
    const brandHit = brands.some((name) => itemBrands.some((candidate) => candidate === name || (keyword.length >= 3 && candidate.includes(keyword))));
    if (companyHit && productHit) matches.push({ item, relation: "sameProduct", basis: "業者名稱及商品名稱均相符；仍須核對批號與規格" });
    else if (productHit && brandHit) matches.push({ item, relation: "sameProduct", basis: "品牌及商品名稱均相符；仍須核對業者、批號與規格" });
    else if (companyHit && relatedCategoryMatch(row, item)) matches.push({ item, relation: "relatedCategory", basis: "同一業者，且官方紀錄與清單內容物屬相關品類；建議查驗目前批次" });
    else if (companyHit) matches.push({ item, relation: "sameParty", basis: brandHit ? "同一業者／品牌，但官方紀錄是其他商品" : "同一業者，但官方紀錄是其他商品" });
    else if (productHit) matches.push({ item, relation: "sameProduct", basis: "商品名稱高度相符，但業者尚未確認；須人工核對" });
    return matches;
  }, []).slice(0, 5);
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
  const [newsSubmitStatus, setNewsSubmitStatus] = useState("");
  const [correctionItem, setCorrectionItem] = useState<OfficialItem | null>(null);
  const [correctionForm, setCorrectionForm] = useState<LocalCorrectionSubmission>({ product: "", company: "", manufacturer: "", reason: "" });
  const [correctionSubmitStatus, setCorrectionSubmitStatus] = useState("");
  const [correctionError, setCorrectionError] = useState("");
  const [newsCorrectionItem, setNewsCorrectionItem] = useState<NewsItem | null>(null);
  const [newsCorrectionForm, setNewsCorrectionForm] = useState<NewsCorrectionSubmission>({ products: "", brands: "", manufacturers: "", importers: "", suppliers: "", retailers: "", companies: "", evidence: "", reason: "" });
  const [newsCorrectionSubmitStatus, setNewsCorrectionSubmitStatus] = useState("");
  const [newsCorrectionError, setNewsCorrectionError] = useState("");
  const [databaseOpen, setDatabaseOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(() => window.location.hash === ADMIN_HASH);
  const [adminToken, setAdminToken] = useState("");
  const [adminUser, setAdminUser] = useState("");
  const [adminIssues, setAdminIssues] = useState<GitHubReviewIssue[]>([]);
  const [selectedIssues, setSelectedIssues] = useState<number[]>([]);
  const [rejectReason, setRejectReason] = useState("");
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [adminStatus, setAdminStatus] = useState("");
  const [databaseLoading, setDatabaseLoading] = useState(false);
  const [databaseError, setDatabaseError] = useState("");
  const [databaseTab, setDatabaseTab] = useState<DatabaseTab>("official");
  const [databaseQuery, setDatabaseQuery] = useState("");
  const [databaseData, setDatabaseData] = useState<DatabaseData | null>(null);
  const officialStatuses: Status[] = ["同商品紀錄", "相關品類，需加強查證", "同品牌／供應商其他商品"];
  const shown = useMemo(() => filter === "all" ? results : filter === "official" ? results.filter((item) => officialStatuses.includes(item.status)) : results.filter((item) => item.status === filter), [results, filter]);
  const stats = useMemo(() => ({ total: results.length, official: results.filter((item) => officialStatuses.includes(item.status)).length, news: results.filter((item) => item.status === "新聞線索").length, noHit: results.filter((item) => item.status === "本次未命中").length, insufficient: results.filter((item) => item.status === "資料不足").length }), [results]);
  const databaseFiltered = useMemo(() => {
    if (!databaseData) return [] as (OfficialItem | ManualNewsItem)[];
    const items: (OfficialItem | ManualNewsItem)[] = databaseTab === "official" ? databaseData.official : databaseTab === "local" ? databaseData.local : databaseTab === "manual" ? databaseData.manual : databaseData.daily;
    const query = compact(databaseQuery);
    return items.filter((item) => !query || compact("product" in item ? [item.kind, item.product, item.brand, item.company, item.manufacturer, item.authority, item.reason, item.media, item.action].filter(Boolean).join(" ") : [item.title, item.source, item.region, item.note, ...(item.products || []), ...allNewsCompanies(item), ...(item.brands || []), ...(item.evidence || [])].filter(Boolean).join(" ")).includes(query)).sort((a, b) => b.date.localeCompare(a.date));
  }, [databaseData, databaseQuery, databaseTab]);
  const today = new Date();
  const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const periodStart = `${today.getFullYear() - 1}-01-01`;
  const dateLabel = `${periodStart} 至 ${localDate(today)}`;

  useEffect(() => {
    const syncAdminPage = () => {
      const isAdminPage = window.location.hash === ADMIN_HASH;
      setAdminOpen(isAdminPage);
      if (!isAdminPage) {
        setAdminToken("");
        setAdminUser("");
        setAdminIssues([]);
        setSelectedIssues([]);
        setRejectReason("");
        setAdminError("");
        setAdminStatus("");
      }
    };
    window.addEventListener("hashchange", syncAdminPage);
    return () => window.removeEventListener("hashchange", syncAdminPage);
  }, []);

  function openAdmin() {
    window.location.hash = "/admin-review";
    setAdminOpen(true);
  }

  function closeAdmin() {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#top`);
    setAdminOpen(false);
    setAdminToken("");
    setAdminUser("");
    setAdminIssues([]);
    setSelectedIssues([]);
    setRejectReason("");
    setAdminError("");
    setAdminStatus("");
  }

  function reviewKind(issue: GitHubReviewIssue): ReviewKind | null {
    if (issue.title.startsWith("新聞線索：")) return "news";
    if (issue.title.startsWith("資料欄位修正：")) return "correction";
    if (issue.title.startsWith("新聞解析修正：")) return "newsCorrection";
    return null;
  }

  function reviewCommand(issue: GitHubReviewIssue) {
    const kind = reviewKind(issue);
    if (kind === "correction") return "/套用修正";
    if (kind === "newsCorrection") return "/套用新聞修正";
    return "/收錄";
  }

  function issueSourceUrl(issue: GitHubReviewIssue) {
    return issue.body?.match(/https?:\/\/[^\s)]+/)?.[0] || issue.html_url;
  }

  async function githubRequest(path: string, token: string, init: RequestInit = {}) {
    return fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.headers || {}),
      },
    });
  }

  async function waitForIssueClosure(issueNumber: number, timeoutMs = 180_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => window.setTimeout(resolve, 4_000));
      const response = await githubRequest(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${issueNumber}`, adminToken.trim());
      if (response.ok) {
        const issue = await response.json() as { state?: string };
        if (issue.state === "closed") return true;
      }
    }
    return false;
  }

  async function loadAdminIssues(token = adminToken) {
    const response = await githubRequest(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues?state=open&per_page=100&sort=created&direction=desc`, token);
    if (!response.ok) throw new Error(response.status === 401 ? "GitHub 憑證無效或已過期。" : "目前無法讀取待審核清單，請稍後再試。");
    const items = await response.json() as GitHubReviewIssue[];
    setAdminIssues(items.filter((issue) => !issue.pull_request && reviewKind(issue)));
  }

  async function signInAdmin() {
    const token = adminToken.trim();
    if (!token) { setAdminError("請先輸入 GitHub 存取憑證。"); return; }
    setAdminLoading(true); setAdminError(""); setAdminStatus("");
    try {
      const response = await githubRequest("/user", token);
      if (!response.ok) throw new Error("GitHub 憑證無效或已過期。");
      const user = await response.json() as { login?: string };
      if (user.login?.toLowerCase() !== GITHUB_OWNER) throw new Error(`此管理頁只接受 ${GITHUB_OWNER} 帳號。`);
      await loadAdminIssues(token);
      setAdminUser(user.login);
      setAdminStatus("身分驗證完成。請核對原始來源後，可勾選一件或多件案件進行核准或拒絕。");
    } catch (cause) { setAdminError(cause instanceof Error ? cause.message : "管理者登入失敗。"); }
    finally { setAdminLoading(false); }
  }

  function toggleSelectedIssue(issueNumber: number) {
    setSelectedIssues((items) => items.includes(issueNumber) ? items.filter((number) => number !== issueNumber) : [...items, issueNumber]);
    setAdminError("");
  }

  async function approveSelectedIssues() {
    const issues = adminIssues.filter((item) => selectedIssues.includes(item.number));
    if (!issues.length) { setAdminError("請先勾選至少一件待審核案件。"); return; }
    const issueList = issues.map((issue) => `#${issue.number} ${issue.title}`).join("\n");
    if (!window.confirm(`確定已逐一核對原始來源，並核准這 ${issues.length} 筆案件嗎？\n\n${issueList}`)) return;
    setAdminLoading(true); setAdminError(""); setAdminStatus("");
    const completed: number[] = [];
    const failed: number[] = [];
    let permissionError = false;
    try {
      for (let index = 0; index < issues.length; index += 1) {
        const issue = issues[index];
        const response = await githubRequest(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${issue.number}/comments`, adminToken.trim(), {
          method: "POST",
          body: JSON.stringify({ body: reviewCommand(issue) }),
        });
        if (response.ok) {
          setAdminStatus(`已送出第 ${index + 1}/${issues.length} 筆核准，等待資料更新完成後再處理下一筆；請保持此頁開啟。`);
          if (await waitForIssueClosure(issue.number)) completed.push(issue.number);
          else {
            failed.push(...issues.slice(index).map((item) => item.number));
            break;
          }
        } else {
          if (response.status === 403) permissionError = true;
          failed.push(issue.number);
        }
      }
      setAdminIssues((items) => items.filter((item) => !completed.includes(item.number)));
      setSelectedIssues(failed);
      if (completed.length) setAdminStatus(`已核准 ${completed.length} 筆案件；GitHub 會依序更新資料庫並重新發布網站。`);
      if (failed.length) setAdminError(permissionError ? "這個憑證沒有 Issues 讀寫權限，失敗案件已保留勾選。" : `${failed.length} 筆核准指令送出失敗，已保留勾選，請稍後重試。`);
    } catch (cause) { setAdminError(cause instanceof Error ? cause.message : "核准失敗。"); }
    finally { setAdminLoading(false); }
  }

  async function rejectSelectedIssues() {
    const issues = adminIssues.filter((item) => selectedIssues.includes(item.number));
    if (!issues.length) { setAdminError("請先勾選至少一件待審核案件。"); return; }
    const reason = rejectReason.trim();
    const issueList = issues.map((issue) => `#${issue.number} ${issue.title}`).join("\n");
    if (!window.confirm(`確定拒絕並關閉這 ${issues.length} 筆案件嗎？\n拒絕後不會寫入資料庫，也不會重新發布網站。\n\n${issueList}`)) return;
    setAdminLoading(true); setAdminError(""); setAdminStatus("");
    const completed: number[] = [];
    const failed: number[] = [];
    let permissionError = false;
    try {
      for (const issue of issues) {
        const comment = await githubRequest(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${issue.number}/comments`, adminToken.trim(), {
          method: "POST",
          body: JSON.stringify({ body: reason ? `管理者審核結果：拒絕\n\n原因：${reason}\n\n此案件未寫入資料庫，亦未觸發網站重新發布。` : "管理者審核結果：拒絕。此案件未寫入資料庫，亦未觸發網站重新發布。" }),
        });
        if (!comment.ok) {
          if (comment.status === 403) permissionError = true;
          failed.push(issue.number);
          continue;
        }
        const close = await githubRequest(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${issue.number}`, adminToken.trim(), {
          method: "PATCH",
          body: JSON.stringify({ state: "closed", state_reason: "not_planned" }),
        });
        if (close.ok) completed.push(issue.number); else failed.push(issue.number);
      }
      setAdminIssues((items) => items.filter((item) => !completed.includes(item.number)));
      setSelectedIssues(failed);
      if (completed.length) {
        setAdminStatus(`已拒絕並關閉 ${completed.length} 筆案件；未寫入資料庫，也未觸發網站重新發布。`);
        setRejectReason("");
      }
      if (failed.length) setAdminError(permissionError ? "這個憑證沒有 Issues 讀寫權限，失敗案件已保留勾選。" : `${failed.length} 筆拒絕操作失敗，已保留勾選，請稍後重試。`);
    } catch (cause) { setAdminError(cause instanceof Error ? cause.message : "拒絕操作失敗。"); }
    finally { setAdminLoading(false); }
  }

  async function readFile(file: File) {
    setError(""); setSourceWarning("");
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("檔案超過 10 MB 上限。");
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
      const { parsed, matchedSheets } = parseWorkbookRows(workbook);
      if (!parsed.length) throw new Error("無法自動辨識資料表。請確認表內有品項／產品名稱，以及品牌、商戶或供應商名稱。");
      setRows(parsed); setResults([]); setFileName(file.name); setProgress(`已自動辨識 ${matchedSheets.length} 張資料表（${matchedSheets.join("、")}），共 ${parsed.length.toLocaleString()} 筆。`);
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
      setProgress("1/3 下載前一年度 1 月 1 日至今的官方資料…");
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
        const officialEvidence = matched.map<Evidence>(({ item, basis, relation }) => ({ kind: item.kind, title: item.product || item.company, date: item.date, source: item.authority, url: item.url, reason: item.reason, basis, relation, recordCompany: item.company || item.manufacturer, recordProduct: item.product, media: item.media, action: item.action }));
        const newsEvidence = news.map<Evidence>((item) => ({ kind: item.manual ? "人工核准新聞線索" : item.parseStatus === "parsed" ? "新聞內文已解析" : "新聞搜尋線索（僅標題）", title: item.title, date: item.date, source: [item.source || "Google 新聞", item.region].filter(Boolean).join("／"), url: item.articleUrl || item.url, basis: newsMatchBasis(row, item), relation: "news", parsedProducts: item.products, parsedCompanies: allNewsCompanies(item), evidenceSentence: newsEvidenceSentence(row, item), parseStatus: item.parseStatus }));
        if (officialEvidence.length) {
          const relation: Relation = officialEvidence.some((item) => item.relation === "sameProduct") ? "sameProduct" : officialEvidence.some((item) => item.relation === "relatedCategory") ? "relatedCategory" : "sameParty";
          const status: Status = relation === "sameProduct" ? "同商品紀錄" : relation === "relatedCategory" ? "相關品類，需加強查證" : "同品牌／供應商其他商品";
          const note = relation === "sameProduct" ? "官方紀錄與商品名稱高度相符，但尚不能確認為同一批號；請核對批號、規格及業者。" : relation === "relatedCategory" ? "同一業者曾有相關原料或品類紀錄；不代表本商品違規，建議索取目前供貨批次檢驗報告。" : "只有品牌或業者相同，官方事件是其他商品；本商品不得因此判定為高風險。";
          return { ...row, query, status, count: officialEvidence.length, latest: officialEvidence.map((item) => item.date).sort().reverse()[0], note, evidence: [...officialEvidence, ...newsEvidence] };
        }
        if (newsEvidence.length) return { ...row, query, status: "新聞線索", count: newsEvidence.length, latest: newsEvidence[0].date, note: "新聞僅為補充線索，不等同官方違規；須開啟原文並核對事件、日期與同一性。", evidence: newsEvidence };
        return { ...row, query, status: "本次未命中", count: 0, latest: "—", note: "本次官方資料與新聞線索未命中；不代表絕對無違規。誇大不實以主管機關官方資料為主要依據。", evidence: [] };
      });
      setResults(checked);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ fileName: sourceName, rowCount: targetRows.length, results: checked, checkedAt: new Date().toISOString() }));
      if (!official.adsAvailable || !official.importsAvailable || !newsPayload.available || !localResponse.ok || local.sources.some((item) => item.status.includes("失敗"))) setSourceWarning("部分資料來源本次未成功更新；結果不可視為完整查核，請查看資料來源狀態或使用人工搜尋入口補查。");
      setProgress(`完成：${checked.length} 筆結果已保存在此瀏覽器。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "自動查核失敗，請稍後再試。"); }
    finally { setLoading(false); }
  }

  async function runCheck() { await checkRows(rows, fileName); }
  async function runKeywordCheck() {
    const value = clean(keyword);
    if (value.length < 2) { setError("請輸入至少 2 個字的產品、品牌或供應商名稱。"); return; }
    await checkRows([{ product: "", contents: "", supplier: "", brand: "", manufacturer: "", taxId: "", adUrl: "", claimText: "", keyword: value }], `快速查核：${value}`);
  }

  function useSample() { setRows(SAMPLE_ROWS); setResults([]); setFileName("範例_供應商產品清單.xlsx"); setError(""); setProgress(""); }
  function downloadTemplate() {
    const sheet = XLSX.utils.json_to_sheet([{ "產品名稱": "範例產品", "供應商名稱": "範例供應商股份有限公司", "品牌完整名稱": "範例品牌", "製造商／進口商名稱": "", "統一編號（選填）": "" }]);
    const guide = XLSX.utils.aoa_to_sheet([["欄位", "必要性", "說明"], ["產品／品牌／供應商／製造商", "至少一項", "名稱越完整，比對越準確"], ["統一編號", "選填", "未提供仍可用名稱初篩"], ["判讀原則", "—", "誇大不實以食藥署等主管機關官方資料為主要依據，新聞僅作補充線索"]]);
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, "查詢清單"); XLSX.utils.book_append_sheet(book, guide, "填寫說明"); XLSX.writeFile(book, "食品違規查核_免費自動查核範本.xlsx");
  }
  function exportResults() {
    const sheet = XLSX.utils.json_to_sheet(results.map((item) => ({ "快速查核關鍵字": item.keyword || "", "產品名稱": item.product, "品牌": item.brand, "供應商": item.supplier, "製造商／進口商": item.manufacturer, "統編（選填）": item.taxId, "查核狀態": item.status, "查核期間命中筆數": item.count, "最新日期": item.latest, "證據關聯理由": item.evidence.map((e) => e.basis).join("｜"), "官方紀錄產品": item.evidence.map((e) => e.recordProduct || "").filter(Boolean).join("｜"), "官方紀錄業者": item.evidence.map((e) => e.recordCompany || "").filter(Boolean).join("｜"), "處分法條／原因": item.evidence.map((e) => e.reason || "").filter(Boolean).join("｜"), "證據標題": item.evidence.map((e) => e.title).join("｜"), "證據網址": item.evidence.map((e) => e.url).join("｜"), "官方人工搜尋": searchUrl("official", item.query), "新聞人工搜尋": searchUrl("news", item.query), "備註": item.note })));
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, "查核結果"); XLSX.writeFile(book, `年度制免費自動查核結果_${localDate(new Date())}.xlsx`);
  }
  function validatedNewsSubmission() {
    const data = { url: clean(newsSubmission.url), note: clean(newsSubmission.note) };
    if (!data.url || !data.note) throw new Error("請貼上新聞網址，並填寫產品、品牌或事件說明。");
    let parsed: URL;
    try { parsed = new URL(data.url); if (!/^https?:$/.test(parsed.protocol)) throw new Error(); } catch { throw new Error("請輸入完整的 http 或 https 新聞網址。"); }
    return { url: parsed.toString(), note: data.note.slice(0, 1500) };
  }

  function submitAnonymousReview(fields: Record<string, string>, targetPrefix: string) {
    const target = `${targetPrefix}-${Date.now()}`;
    const resultWindow = window.open("about:blank", target);
    if (!resultWindow) throw new Error("瀏覽器阻擋送審結果頁，請允許此網站開啟彈出式視窗後重試。");
    resultWindow.opener = null;
    const form = document.createElement("form");
    form.method = "post";
    form.action = ANONYMOUS_NEWS_URL;
    form.target = target;
    form.style.display = "none";
    for (const [name, value] of Object.entries({ ...fields, website: "" })) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
    form.remove();
  }

  function submitNewsForReview() {
    try {
      const data = validatedNewsSubmission();
      submitAnonymousReview({ kind: "news", url: data.url, note: data.note }, "anonymous-news-submit");
      setNewsSubmitStatus("已送往匿名審核入口；新分頁會顯示送出結果。管理者核准前不會納入資料庫。");
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "目前無法使用匿名送審服務。"); }
  }

  function openCorrectionForm(item: OfficialItem) {
    setCorrectionItem(item);
    setCorrectionForm({ product: "", company: "", manufacturer: "", reason: "" });
    setCorrectionSubmitStatus("");
    setCorrectionError("");
  }

  function closeCorrectionForm() {
    setCorrectionItem(null);
    setCorrectionForm({ product: "", company: "", manufacturer: "", reason: "" });
    setCorrectionSubmitStatus("");
    setCorrectionError("");
  }

  function correctionIssue() {
    if (!correctionItem) throw new Error("找不到要修改的資料，請關閉後重試。");
    const fields = [
      { value: clean(correctionForm.product), current: clean(correctionItem.product) },
      { value: clean(correctionForm.company), current: clean(correctionItem.company) },
      { value: clean(correctionForm.manufacturer), current: clean(correctionItem.manufacturer) },
    ];
    const clearWords = new Set(["刪除", "清除", "留空", "未提供", "無"]);
    const hasChange = fields.some(({ value, current }) => value && (clearWords.has(value) || value !== current));
    if (!hasChange) throw new Error("請至少填寫一個與目前資料不同的正確欄位；要移除錯誤內容可輸入「清除」。");
    if (!clean(correctionForm.reason)) throw new Error("請填寫修改理由或原文位置，方便管理者核對。");
    return buildLocalCorrectionIssue(correctionItem, correctionForm);
  }

  function submitCorrectionForReview() {
    try {
      const issue = correctionIssue();
      window.open(issue.url, "_blank", "noopener,noreferrer");
      navigator.clipboard?.writeText(issue.body).then(
        () => setCorrectionSubmitStatus("已開啟 GitHub，送審內容也已複製。請確認內容後按 Submit new issue。"),
        () => setCorrectionSubmitStatus("已開啟 GitHub。請確認內容後按 Submit new issue。"),
      );
      setCorrectionError("");
    } catch (cause) { setCorrectionError(cause instanceof Error ? cause.message : "無法建立修正案件。"); }
  }

  async function copyCorrectionIssue() {
    try { await navigator.clipboard.writeText(correctionIssue().body); setCorrectionSubmitStatus("送審內容已複製；請開啟空白 Issue，貼上後送出。"); setCorrectionError(""); }
    catch (cause) { setCorrectionError(cause instanceof Error ? cause.message : "瀏覽器無法複製內容，請手動複製表單文字。"); }
  }

  function openNewsCorrectionForm(item: NewsItem) {
    setNewsCorrectionItem(item);
    setNewsCorrectionForm({ products: "", brands: "", manufacturers: "", importers: "", suppliers: "", retailers: "", companies: "", evidence: "", reason: "" });
    setNewsCorrectionSubmitStatus("");
    setNewsCorrectionError("");
  }

  function closeNewsCorrectionForm() {
    setNewsCorrectionItem(null);
    setNewsCorrectionForm({ products: "", brands: "", manufacturers: "", importers: "", suppliers: "", retailers: "", companies: "", evidence: "", reason: "" });
    setNewsCorrectionSubmitStatus("");
    setNewsCorrectionError("");
  }

  function newsCorrectionIssue() {
    if (!newsCorrectionItem) throw new Error("找不到要修改的新聞，請關閉後重試。");
    const fields = [newsCorrectionForm.products, newsCorrectionForm.brands, newsCorrectionForm.manufacturers, newsCorrectionForm.importers, newsCorrectionForm.suppliers, newsCorrectionForm.retailers, newsCorrectionForm.companies, newsCorrectionForm.evidence].map(clean);
    if (!fields.some(Boolean)) throw new Error("請至少填寫一項正確的商品、品牌、相關業者或證據句；要移除全部內容可輸入「清除」。");
    if (!clean(newsCorrectionForm.reason)) throw new Error("請填寫修改理由或原文位置，方便管理者核對。");
    return buildNewsCorrectionIssue(newsCorrectionItem, newsCorrectionForm);
  }

  function submitNewsCorrectionForReview() {
    try {
      const issue = newsCorrectionIssue();
      if (!newsCorrectionItem) throw new Error("找不到要修改的新聞，請關閉後重試。");
      submitAnonymousReview({ kind: "newsCorrection", url: newsCorrectionItem.articleUrl || newsCorrectionItem.url, title: issue.title, body: issue.body }, "anonymous-news-correction");
      setNewsCorrectionSubmitStatus("已送往匿名審核入口；新分頁會顯示送出結果。管理者核准前不會修改資料庫。");
      setNewsCorrectionError("");
    } catch (cause) { setNewsCorrectionError(cause instanceof Error ? cause.message : "無法建立新聞解析修正案件。"); }
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
      const localMatchable = local.records.filter((item) => item.matchable !== false);
      const localRetryCount = local.records.filter((item) => item.parseStatus === "failed").length;
      setDatabaseData({ official: [...official.ads, ...official.imports], local: localMatchable, localPending: local.records.filter(item => item.parseStatus === 'failed'), localRawCount: local.records.length, localRetryCount, localNoEvidenceCount: local.records.length - localMatchable.length - localRetryCount, localSources: local.sources, manual: manual.items, daily: daily.items, officialUpdatedAt: official.updatedAt, localUpdatedAt: local.updatedAt, manualUpdatedAt: manual.updatedAt, dailyUpdatedAt: daily.updatedAt });
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
<small>FREE COMPLIANCE CHECK <span>{VERSION_LABEL}</span></small>
</div>
</a>
<div className="top-actions">
<button className="database-link admin-entry" onClick={openAdmin}>管理審核</button>
<button className="database-link" onClick={() => setSourcesOpen(true)}>資料來源說明</button>
<button className="database-link" onClick={openDatabase}>查看已收錄資料</button>
<div className="period">
<i />年度查核期間：{dateLabel}</div>
</div>
</header>
    <section className="hero" id="top">
<div className="hero-copy">
<p className="eyebrow">零額外查詢費</p>
<h1>輸入關鍵字或上傳 Excel<br/>
<em>完成官方與新聞初查</em>
</h1>
<p className="lead">輸入產品、品牌或供應商名稱即可單筆查核；大量清單則上傳 Excel。系統查詢前一年度 1 月 1 日至今天的官方違規資料，新聞只作補充線索。</p>
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
<span>或直接上傳你原本的 Excel</span>
</div>
<button className={`dropzone ${fileName && !rows[0]?.keyword ? "has-file" : ""}`} onClick={() => inputRef.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const file = e.dataTransfer.files[0]; if (file) readFile(file); }}>
<input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])}/>
<span className="file-icon">{fileName && !rows[0]?.keyword ? "✓" : "XL"}</span>
<strong>{fileName && !rows[0]?.keyword ? fileName : "拖曳 Excel 到這裡，或點擊選擇"}</strong>
<small>{fileName && !rows[0]?.keyword ? `已讀取 ${rows.length} 筆有效資料` : "自動找表頭、合併多張工作表｜不必套用特殊範本"}</small>
</button>{error && <p className="error">{error}</p>}{sourceWarning && <p className="warning-box">{sourceWarning}</p>}<div className="upload-actions">
<button className="text-btn" onClick={downloadTemplate}>↓ 需要時下載簡易範本</button>
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
      <div className="result-legend" aria-label="查核結果分級說明">
<div className="level-product"><b>同商品紀錄</b><small>商品名稱高度相符，仍須核對批號</small></div>
<div className="level-related"><b>相關品類</b><small>同業者且原料／品類相關，建議加強查證</small></div>
<div className="level-party"><b>其他商品</b><small>僅同品牌或供應商，不代表本商品違規</small></div>
<div className="level-clear"><b>本次未命中</b><small>查核期間內未找到，不等於保證合格</small></div>
</div>
      <div className="stats five">
<button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>
<span>全部</span>
<b>{stats.total}</b>
<small>筆對象</small>
</button>
<button className={`danger ${filter === "official" ? "active" : ""}`} onClick={() => setFilter("official")}>
<span>官方需確認</span>
<b>{stats.official}</b>
<small>依關聯程度分級</small>
</button>
<button className={`news ${filter === "新聞線索" ? "active" : ""}`} onClick={() => setFilter("新聞線索")}>
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
<th>關聯程度</th>
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
<p>誇大不實以食藥署等主管機關官方資料為主要依據；新聞僅為補充線索。「同商品紀錄」仍須核對批號；同品牌或供應商的其他商品不得直接判定為本商品違規。</p>
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
<button className="close" onClick={() => { setSubmittingNews(false); setNewsSubmitStatus(""); }}>×</button>
<p className="eyebrow">NEWS SUBMISSION</p>
<h2>提交新聞線索</h2>
<p className="modal-intro">只要貼上新聞網址並簡單說明產品、品牌或事件。管理者核准後，系統會解析新聞內文中的商品、品牌、相關業者與證據句，再納入共用資料庫。</p>
<div className="news-form">
<label>新聞網址<input type="url" value={newsSubmission.url} onChange={(e) => { setNewsSubmission({ ...newsSubmission, url: e.target.value }); setError(""); }} placeholder="https://..."/>
</label>
<label>補充說明<textarea value={newsSubmission.note} onChange={(e) => { setNewsSubmission({ ...newsSubmission, note: e.target.value }); setError(""); }} placeholder="例如：奧利塔就是 Olitalia；2 款橄欖油含礦物油。請寫出產品、品牌、別名或違規事件。"/>
</label>
</div>{error && <p className="error modal-error">{error}</p>}<button className="primary analyze" disabled={!newsSubmission.url.trim() || !newsSubmission.note.trim()} onClick={submitNewsForReview}>匿名送出審核（免登入）</button>
{newsSubmitStatus && <div className="github-fallback"><p>{newsSubmitStatus}</p></div>}
<p className="github-note">提交者不需要任何帳號。送出後只會建立待審核線索；管理者核准後才解析內文並更新網站。</p>
</section>
</div>}
    {correctionItem && <div className="modal-backdrop correction-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeCorrectionForm()}>
<section className="review-modal correction-modal" role="dialog" aria-modal="true" aria-label="提出欄位修正">
<button className="close" onClick={closeCorrectionForm}>×</button>
<p className="eyebrow">CORRECTION REQUEST</p>
<h2>提出欄位修正</h2>
<p className="modal-intro">目前資料已自動帶入。只填需要修改的正確欄位；沒有要改的欄位請保持空白。</p>
<div className="correction-current">
<div><span>目前商品</span><strong>{correctionItem.product || "未提供"}</strong></div>
<div><span>目前業者</span><strong>{correctionItem.company || "未提供"}</strong></div>
<div><span>目前製造商</span><strong>{correctionItem.manufacturer || "未提供"}</strong></div>
<div><span>主管機關／日期</span><strong>{[correctionItem.authority, correctionItem.date].filter(Boolean).join("｜") || "未提供"}</strong></div>
</div>
<a className="correction-source" href={correctionItem.url} target="_blank" rel="noreferrer">先開啟官方來源核對 ↗</a>
<div className="correction-form">
<label>正確商品名稱（不修改請留空）<input value={correctionForm.product} onChange={(event) => { setCorrectionForm({ ...correctionForm, product: event.target.value }); setCorrectionError(""); }} placeholder="輸入正確商品；要移除錯誤內容請填「清除」"/></label>
<label>正確業者名稱（不修改請留空）<input value={correctionForm.company} onChange={(event) => { setCorrectionForm({ ...correctionForm, company: event.target.value }); setCorrectionError(""); }} placeholder="輸入正確業者；要移除錯誤內容請填「清除」"/></label>
<label>正確製造商（不修改請留空）<input value={correctionForm.manufacturer} onChange={(event) => { setCorrectionForm({ ...correctionForm, manufacturer: event.target.value }); setCorrectionError(""); }} placeholder="輸入正確製造商；要移除錯誤內容請填「清除」"/></label>
<label>修改理由或原文位置<textarea value={correctionForm.reason} onChange={(event) => { setCorrectionForm({ ...correctionForm, reason: event.target.value }); setCorrectionError(""); }} placeholder="例如：公告第二段的業者是受託製造商，不是產品販售業者。"/></label>
</div>
{correctionError && <p className="error modal-error">{correctionError}</p>}
<button className="primary" onClick={submitCorrectionForReview}>前往 GitHub 送出審核</button>
{correctionSubmitStatus && <div className="github-fallback"><p>{correctionSubmitStatus}</p><div><button onClick={copyCorrectionIssue}>複製送審內容</button><a href={NEW_ISSUE_URL} target="_blank" rel="noreferrer">開啟空白 Issue ↗</a></div></div>}
<p className="github-note">提出者只需登入免費 GitHub 帳號並按 Submit new issue；不需要管理者憑證。核准與資料更新由管理者另外處理。</p>
</section>
</div>}
    {newsCorrectionItem && <div className="modal-backdrop correction-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeNewsCorrectionForm()}>
<section className="review-modal correction-modal news-correction-modal" role="dialog" aria-modal="true" aria-label="回報新聞解析修正">
<button className="close" onClick={closeNewsCorrectionForm}>×</button>
<p className="eyebrow">NEWS PARSING CORRECTION</p>
<h2>回報新聞解析修正</h2>
<p className="modal-intro">請先核對新聞原文，再填寫需要修改的欄位。每個名稱或證據句請一行一項；沒有要改的欄位請保持空白。</p>
<div className="news-correction-source">
<span>{newsCorrectionItem.date}｜{newsCorrectionItem.source}</span>
<strong>{newsCorrectionItem.title}</strong>
<a href={newsCorrectionItem.articleUrl || newsCorrectionItem.url} target="_blank" rel="noreferrer">先開啟新聞原文核對 ↗</a>
</div>
<div className="news-current-entities">
<div><span>目前商品／產品</span><p>{newsCorrectionItem.products?.join("、") || "未提供"}</p></div>
<div><span>目前品牌</span><p>{newsCorrectionItem.brands?.join("、") || "未提供"}</p></div>
<div><span>目前製造商</span><p>{newsCorrectionItem.manufacturers?.join("、") || "未提供"}</p></div>
<div><span>目前進口商</span><p>{newsCorrectionItem.importers?.join("、") || "未提供"}</p></div>
<div><span>目前供應商／來源業者</span><p>{newsCorrectionItem.suppliers?.join("、") || "未提供"}</p></div>
<div><span>目前販售商／通路</span><p>{newsCorrectionItem.retailers?.join("、") || "未提供"}</p></div>
<div><span>目前其他相關業者</span><p>{otherNewsCompanies(newsCorrectionItem).join("、") || "未提供"}</p></div>
<div><span>目前證據句</span><p>{newsCorrectionItem.evidence?.join("／") || "未提供"}</p></div>
</div>
<div className="correction-form news-correction-form">
<label>正確商品／產品（每行一項）<textarea value={newsCorrectionForm.products} onChange={(event) => { setNewsCorrectionForm({ ...newsCorrectionForm, products: event.target.value }); setNewsCorrectionError(""); }} placeholder={'例如：\n協億苦茶油\n冷壓苦茶油'} /></label>
<label>正確品牌（每行一項）<textarea value={newsCorrectionForm.brands} onChange={(event) => { setNewsCorrectionForm({ ...newsCorrectionForm, brands: event.target.value }); setNewsCorrectionError(""); }} placeholder={'例如：\n協億'} /></label>
<label>正確製造商（每行一項）<textarea value={newsCorrectionForm.manufacturers} onChange={(event) => { setNewsCorrectionForm({ ...newsCorrectionForm, manufacturers: event.target.value }); setNewsCorrectionError(""); }} placeholder={'只在原文明確標示製造商時填寫'} /></label>
<label>正確進口商（每行一項）<textarea value={newsCorrectionForm.importers} onChange={(event) => { setNewsCorrectionForm({ ...newsCorrectionForm, importers: event.target.value }); setNewsCorrectionError(""); }} placeholder={'只在原文明確標示進口商時填寫'} /></label>
<label>正確供應商／來源業者（每行一項）<textarea value={newsCorrectionForm.suppliers} onChange={(event) => { setNewsCorrectionForm({ ...newsCorrectionForm, suppliers: event.target.value }); setNewsCorrectionError(""); }} placeholder={'只在原文明確標示供應或來源角色時填寫'} /></label>
<label>正確販售商／通路（每行一項）<textarea value={newsCorrectionForm.retailers} onChange={(event) => { setNewsCorrectionForm({ ...newsCorrectionForm, retailers: event.target.value }); setNewsCorrectionError(""); }} placeholder={'只在原文明確標示販售或通路角色時填寫'} /></label>
<label>正確其他相關業者（每行一項）<textarea value={newsCorrectionForm.companies} onChange={(event) => { setNewsCorrectionForm({ ...newsCorrectionForm, companies: event.target.value }); setNewsCorrectionError(""); }} placeholder={'只填角色不明的業者；例如：\n協億有限公司\n要移除全部內容請填「清除」'} /></label>
<label>正確證據句（每行一項）<textarea value={newsCorrectionForm.evidence} onChange={(event) => { setNewsCorrectionForm({ ...newsCorrectionForm, evidence: event.target.value }); setNewsCorrectionError(""); }} placeholder="請貼上原文中能直接支持產品、業者及事件的短句" /></label>
<label>修改理由或原文位置<textarea value={newsCorrectionForm.reason} onChange={(event) => { setNewsCorrectionForm({ ...newsCorrectionForm, reason: event.target.value }); setNewsCorrectionError(""); }} placeholder="例如：原文第三段提到協億是產品製造商；目前系統誤抓到彰化縣衛生局。" /></label>
</div>
{newsCorrectionError && <p className="error modal-error">{newsCorrectionError}</p>}
<button className="primary" onClick={submitNewsCorrectionForReview}>匿名送出解析修正（免登入）</button>
{newsCorrectionSubmitStatus && <div className="github-fallback"><p>{newsCorrectionSubmitStatus}</p></div>}
<p className="github-note">提出者不需要任何帳號。送出後只會建立待審核修正；管理者核准後才會更新資料庫，原始解析結果仍保留。</p>
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
<span>地方衛生局可查核紀錄</span>
<small>原始 {databaseData.localRawCount.toLocaleString()}｜待重試 {databaseData.localRetryCount.toLocaleString()}｜更新：{displayUpdatedAt(databaseData.localUpdatedAt)}</small>
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
{databaseTab === "local" && <div className="local-count-panel">
<div><span>原始收錄</span><strong>{databaseData.localRawCount.toLocaleString()}</strong><small>包含可查核及暫不納入的紀錄</small></div>
<div><span>可查核</span><strong>{databaseData.local.length.toLocaleString()}</strong><small>會參與產品與業者自動比對</small></div>
<div><span>待確認／重試</span><strong>{databaseData.localRetryCount.toLocaleString()}</strong><small>包括連線失敗、原頁失效或附件無法解析</small></div>
<p>原始收錄 {databaseData.localRawCount.toLocaleString()}／可查核 {databaseData.local.length.toLocaleString()}／待重試 {databaseData.localRetryCount.toLocaleString()}。另有 {databaseData.localNoEvidenceCount.toLocaleString()} 筆已解析但未發現違規證據，因此不列入自動查核。</p>
</div>}
{databaseTab === "local" && <div className="local-source-status">{databaseData.localSources.map((source) => <a key={source.city} href={source.datasetUrl} target="_blank" rel="noreferrer"><b>{source.city}</b><span>{source.mode}</span><small className={source.status.startsWith("已") ? "ok" : ""}>{source.status}｜查核期間 {source.recordCount.toLocaleString()} 筆</small>{source.message && <span>{source.message}</span>}</a>)}</div>}
{databaseTab === "local" && databaseData.localPending.length > 0 && <details className="source-pending">
<summary>查看 {databaseData.localPending.length} 筆待確認公告及失敗原因</summary>
<p>未取得的正文或附件不參與違規判定，也不代表沒有違規。暫時連線失敗會重試；原頁失效須核對同公告新網址。</p>
<ul>{databaseData.localPending.map((item, index) => <li key={`${item.url}-${index}`}><a href={item.url} target="_blank" rel="noreferrer">{item.city}｜{item.date}｜{item.media || item.product}</a><span>{item.reason}</span></li>)}</ul>
</details>}
{databaseTab === "local" && <div className="local-correction-note"><b>業者或製造商抓取錯誤？</b><span>請在該筆紀錄按「提出欄位修正」，填入正確內容。管理者核對官方來源後，在管理審核頁勾選核准即可重新發布；原始資料仍保留不覆寫。</span></div>}
{(databaseTab === "daily" || databaseTab === "manual") && <div className="local-correction-note"><b>新聞解析內容抓錯？</b><span>請在該篇新聞按「回報新聞解析修正」，修正商品、品牌、相關業者或證據句。人工核准後會在每日更新後重新套用，原始解析結果仍保留。</span></div>}
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
<th>商品</th>
<th>品牌</th>
<th>業者角色</th>
<th>證據／地區</th>
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
<strong>{item.company || "未提供"}</strong>{item.manufacturer && <small>製造商：{item.manufacturer}</small>}{item.correctionIssueUrl && <small className="correction-badge">✓ 人工核准修正</small>}</td>
<td>
<span>{item.reason || "未提供原因"}</span>
<small>{[item.action, item.media].filter(Boolean).join("｜")}</small>
</td>
<td>
<small>{[item.authority, item.sourceLayer].filter(Boolean).join("｜")}</small>
<a href={item.url} target="_blank" rel="noreferrer">開啟官方來源 ↗</a>
{databaseTab === "local" && <button className="correction-link correction-button" onClick={() => openCorrectionForm(item)}>提出欄位修正</button>}
{databaseTab === "local" && item.correctionIssueUrl && <a className="correction-link" href={item.correctionIssueUrl} target="_blank" rel="noreferrer">查看修正審核 ↗</a>}
</td>
</tr> : <tr key={`${item.date}-${item.url}-${index}`}>
<td>
<strong>{item.date}</strong>
<small>{item.source}</small>
</td>
<td>
<strong>{item.title}</strong>
{(databaseTab === "daily" || databaseTab === "manual") && <div className="parse-badges"><span className={`parse-badge ${item.parseStatus === "parsed" ? "parsed" : "title-only"}`}>{item.parseStatus === "parsed" ? "新聞內文已解析" : item.parseStatus === "titleOnly" ? "僅取得標題" : "待補解析"}</span>{item.correctionIssueUrl && <span className="parse-badge corrected">✓ 人工核准解析修正</span>}</div>}
</td>
<td>
<span>{item.products?.join("、") || "未解析出商品"}</span></td>
<td>
<span>{item.brands?.join("、") || "未解析出品牌"}</span></td>
<td>
<div className="news-role-list">{item.manufacturers?.length ? <small><b>製造商</b>{item.manufacturers.join("、")}</small> : null}{item.importers?.length ? <small><b>進口商</b>{item.importers.join("、")}</small> : null}{item.suppliers?.length ? <small><b>供應／來源</b>{item.suppliers.join("、")}</small> : null}{item.retailers?.length ? <small><b>販售／通路</b>{item.retailers.join("、")}</small> : null}{otherNewsCompanies(item).length ? <small><b>其他相關業者</b>{otherNewsCompanies(item).join("、")}</small> : null}{allNewsCompanies(item).length === 0 && <span>未解析出業者</span>}</div></td>
<td>
<span>{item.evidence?.[0] || "未取得直接證據句"}</span><small>{item.region || (databaseTab === "daily" ? "新聞搜尋線索" : "未提供地區")}</small>{item.note && <small>{item.note}</small>}</td>
<td>
<a href={item.articleUrl || item.url} target="_blank" rel="noreferrer">開啟新聞原文 ↗</a>{item.issueUrl && <a href={item.issueUrl} target="_blank" rel="noreferrer">審核紀錄 ↗</a>}{(databaseTab === "daily" || databaseTab === "manual") && <button className="correction-link correction-button" onClick={() => openNewsCorrectionForm(item)}>回報新聞解析修正</button>}{(databaseTab === "daily" || databaseTab === "manual") && item.correctionIssueUrl && <a className="correction-link" href={item.correctionIssueUrl} target="_blank" rel="noreferrer">查看解析修正審核 ↗</a>}</td>
</tr>)}</tbody>
</table>{databaseFiltered.length === 0 && <div className="database-empty">沒有符合的資料，請換一個關鍵字。</div>}</div>{databaseFiltered.length > 100 && <p className="database-limit">為保持頁面順暢，目前顯示前 100 筆；請輸入關鍵字縮小範圍。</p>}</>}</div>
</section>}
    {adminOpen && <section className="database-page admin-page" role="dialog" aria-modal="true" aria-label="管理審核">
<header>
<div>
<p className="eyebrow">ADMIN REVIEW</p>
<h2>管理審核</h2>
<p>只有 GitHub 帳號 {GITHUB_OWNER} 可以進行核准或拒絕；憑證只保留在目前頁面記憶體。</p>
</div>
<button className="database-close" onClick={closeAdmin}>關閉並清除憑證 ×</button>
</header>
<div className="admin-body">
{!adminUser ? <div className="admin-login">
<section>
<span className="source-badge manual">管理者專用</span>
<h3>使用 GitHub 憑證驗證身分</h3>
<p>管理頁網址仍是公開的，但沒有你的 GitHub 憑證就不能核准、拒絕或更新資料。憑證不會寫入網站、資料庫或永久儲存。</p>
<label htmlFor="github-admin-token">GitHub fine-grained personal access token</label>
<div className="admin-token-row">
<input id="github-admin-token" type="password" autoComplete="off" spellCheck={false} value={adminToken} onChange={(event) => { setAdminToken(event.target.value); setAdminError(""); }} onKeyDown={(event) => event.key === "Enter" && !adminLoading && signInAdmin()} placeholder="github_pat_..."/>
<button className="primary" disabled={!adminToken.trim() || adminLoading} onClick={signInAdmin}>{adminLoading ? "驗證中…" : "驗證並開啟"}</button>
</div>
{adminError && <p className="error">{adminError}</p>}
</section>
<aside>
<h3>第一次使用只需設定一次</h3>
<ol>
<li>開啟 GitHub 建立細部權限憑證。</li>
<li>Repository access 只選 <b>{GITHUB_REPO}</b>。</li>
<li>Repository permissions 將 <b>Issues</b> 設為 <b>Read and write</b>。</li>
<li>建立後請存入密碼管理工具；每次進入本頁再貼上。建議設定到期日。</li>
</ol>
<a href={GITHUB_TOKEN_URL} target="_blank" rel="noreferrer">前往建立 GitHub 憑證 ↗</a>
</aside>
</div> : <>
<div className="admin-summary">
<div><span>登入帳號</span><strong>{adminUser}</strong><small>已通過管理者身分驗證</small></div>
<div><span>待審核</span><strong>{adminIssues.length}</strong><small>新聞收錄、官方欄位與新聞解析修正</small></div>
<button onClick={() => { setAdminUser(""); setAdminToken(""); setAdminIssues([]); setSelectedIssues([]); setRejectReason(""); setAdminStatus(""); }}>登出並清除憑證</button>
</div>
{adminStatus && <p className="admin-status">{adminStatus}</p>}
{adminError && <p className="error admin-message">{adminError}</p>}
{adminIssues.length > 0 && <div className="admin-select-tools"><button onClick={() => setSelectedIssues(adminIssues.map((issue) => issue.number))}>全選待審</button><button onClick={() => setSelectedIssues([])}>清除選取</button><span>可複選後一次核准或拒絕</span></div>}
<div className="admin-review-list">
{adminIssues.map((issue) => {
  const kind = reviewKind(issue);
  return <article className={selectedIssues.includes(issue.number) ? "selected" : ""} key={issue.number}>
<label>
<input type="checkbox" checked={selectedIssues.includes(issue.number)} onChange={() => toggleSelectedIssue(issue.number)}/>
<span className={`review-kind ${kind}`}>{kind === "correction" ? "欄位修正" : kind === "newsCorrection" ? "新聞解析修正" : "新聞線索"}</span>
<span className="review-number">#{issue.number}</span>
</label>
<h3>{issue.title}</h3>
<p>{issue.body?.replace(/[#*_>`-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240) || "未提供案件內容"}</p>
<div><span>提交者：{issue.user?.login || "未提供"}｜{new Date(issue.created_at).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false })}</span><a href={issueSourceUrl(issue)} target="_blank" rel="noreferrer">核對原始來源 ↗</a><a href={issue.html_url} target="_blank" rel="noreferrer">查看 GitHub 案件 ↗</a></div>
</article>;
})}
{adminIssues.length === 0 && <div className="admin-empty"><strong>目前沒有待審核案件</strong><span>新的新聞線索、官方欄位修正或新聞解析修正送出後，會顯示在這裡。</span></div>}
</div>
{adminIssues.length > 0 && <div className="admin-approve-bar"><div className="admin-selection-summary"><b>{selectedIssues.length ? `已選擇 ${selectedIssues.length} 筆案件` : "請勾選至少一件案件"}</b><small>核准前請逐一核對原始來源；拒絕不會寫入資料庫或重新發布網站。</small></div><label className="admin-reject-reason"><span>拒絕原因（選填）</span><input value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} placeholder="例如：與食安違規無關、資料重複"/></label><div className="admin-decision-actions"><button className="reject" disabled={!selectedIssues.length || adminLoading} onClick={rejectSelectedIssues}>{adminLoading ? "處理中…" : "拒絕並關閉"}</button><button className="primary" disabled={!selectedIssues.length || adminLoading} onClick={approveSelectedIssues}>{adminLoading ? "處理中…" : `同意並更新${selectedIssues.length > 1 ? `（${selectedIssues.length} 筆）` : ""}`}</button></div></div>}
</>}
</div>
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
<dd>每天取得資料後，保留前一年度 1 月 1 日至當天的紀錄</dd>
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
<dd>每天取得資料後，保留前一年度 1 月 1 日至當天的紀錄</dd>
</div>
</dl>
<a href={IMPORTS_DATASET_URL} target="_blank" rel="noreferrer">開啟政府資料集 6133 ↗</a>
</article>
<article>
<span className="source-badge official">官方資料 3</span>
<h3>地方衛生局第二層資料</h3>
<dl>
<div><dt>涵蓋單位</dt><dd>臺北、新北、桃園、臺中、臺南、高雄、花蓮及臺東地方衛生主管機關</dd></div>
<div><dt>自動比對</dt><dd>臺北、桃園、臺中、臺南讀取結構化資料；新北與高雄另逐篇解析公告正文及 PDF；花蓮與臺東由食藥署同步的地方衛生局官方新聞納入，只保留具有違規證據的紀錄</dd></div>
<div><dt>解析失敗</dt><dd>無法取得正文或 PDF 時會排除自動命中，保留失敗狀態並於下次每日更新重試</dd></div>
<div><dt>更新方式</dt><dd>每天逐一連線；單一城市失敗會顯示狀態，不影響其他來源</dd></div>
</dl>
<a href={LOCAL_HEALTH_URL} target="_blank" rel="noreferrer">查看全國地方衛生機關 ↗</a>
</article>
<article>
<span className="source-badge official">官方資料 4</span>
<h3>食藥署國內衛生局新聞</h3>
<dl>
<div><dt>提供單位</dt><dd>各縣市衛生局發布、由食藥署「國內衛生局新聞」集中呈現</dd></div>
<div><dt>自動收錄</dt><dd>篩選前一年度 1 月 1 日至今，且含不合格、違規、超標、下架、回收、裁罰或異常等事件詞的公告，再讀取內文中的業者、產品、批號與處理方式</dd></div>
<div><dt>判讀方式</dt><dd>同業者但不同品項只列為品牌／供應商追蹤；只有產品名稱相符時才列為同商品紀錄</dd></div>
</dl>
<a href={HEALTH_NEWS_URL} target="_blank" rel="noreferrer">開啟食藥署國內衛生局新聞 ↗</a>
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
<dd>保留前一年度 1 月 1 日至今，且標題包含違規、裁罰、誇大、下架、不合格、回收、處分、遭罰或開罰等事件詞的新聞</dd>
</div>
<div>
<dt>內文解析</dt>
<dd>能讀取原文時，分別保存商品、品牌、製造商、進口商、供應／來源業者、販售／通路及其他相關業者；只有原文明確標示角色時才分類，角色不明時不猜測</dd>
</div>
<div>
<dt>人工修正</dt>
<dd>若商品、品牌、業者角色或證據句解析錯誤，可由使用者回報、管理者核准；修正會在每日更新後重新套用並保留原始解析結果</dd>
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
<dd>管理者在管理審核頁核對原文後核准；系統立即解析商品、品牌、製造商、進口商、供應商、販售商、其他相關業者與證據句，再寫入共用資料</dd>
</div>
<div>
<dt>解析重試</dt>
<dd>若新聞網站暫時阻擋或只取得標題，資料會清楚標示，並在每日更新時自動重試；補充說明可協助搜尋，但不視為已查證證據</dd>
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
<small>GitHub 自動抓取食藥署中央資料、地方開放資料、國內衛生局官方新聞與一般新聞線索；實際完成時間可能稍有延遲。</small>
</span>
<span>
<b>年度制查核</b>
<small>每年查詢前一完整年度 1 月 1 日至當天；例如 2026 年查詢 2025-01-01 至今。</small>
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
<p>{selectedEvidence.basis}</p>{selectedEvidence.relation === "sameParty" && <small>這只證明該品牌或供應商在查核期間有其他商品紀錄，不代表您清單中的商品本身違規。</small>}{selectedEvidence.relation === "relatedCategory" && <small>品類相關僅代表需要加強查證，不能直接認定目前商品不合格。</small>}</div>
<dl className="evidence-detail">
<div>
<dt>{selectedEvidence.kind.includes("新聞") ? "新聞標題" : "官方紀錄產品"}</dt>
<dd>{selectedEvidence.recordProduct || selectedEvidence.title}</dd>
</div>{selectedEvidence.recordCompany && <div>
<dt>官方紀錄業者</dt>
<dd>{selectedEvidence.recordCompany}</dd>
</div>}{selectedEvidence.parsedProducts?.length ? <div>
<dt>內文解析商品／品牌</dt>
<dd>{selectedEvidence.parsedProducts.join("、")}</dd>
</div> : null}{selectedEvidence.parsedCompanies?.length ? <div>
<dt>內文解析來源／相關業者</dt>
<dd>{selectedEvidence.parsedCompanies.join("、")}</dd>
</div> : null}{selectedEvidence.evidenceSentence ? <div>
<dt>新聞證據句</dt>
<dd>{selectedEvidence.evidenceSentence}</dd>
</div> : null}<div>
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
<span className="version-label">版本 {VERSION_LABEL} · {BUILD_LABEL}</span>
</footer>
  </main>;
}
