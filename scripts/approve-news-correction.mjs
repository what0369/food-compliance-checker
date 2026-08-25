import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyNewsCorrections, NEWS_CORRECTIONS_FILE, newsCorrectionMatches } from "./news-corrections.mjs";

const NEWS_FILE = new URL("../public/data/news.json", import.meta.url);
const MANUAL_NEWS_FILE = new URL("../public/data/manual-news.json", import.meta.url);
const CLEAR_VALUES = new Set(["刪除", "清除", "留空", "未提供", "無"]);
const text = (value) => String(value ?? "").trim();

function section(body, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.match(new RegExp(`## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n---|$)`, "i"))?.[1]?.trim() || "";
}

function field(content, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.match(new RegExp(`^-[ \\t]*${escaped}[：:][ \\t]*(.*)$`, "m"))?.[1]?.trim() || "";
}

function parsedList(value) {
  if (!value) return undefined;
  if (CLEAR_VALUES.has(value)) return [];
  return [...new Set(value.split("｜").map(text).filter(Boolean))];
}

export function parseNewsCorrectionIssue(body, issueUrl = "") {
  const source = section(body, "新聞來源資料");
  const corrected = section(body, "請填寫正確內容");
  const match = {
    date: field(source, "日期"),
    title: field(source, "標題"),
    url: field(source, "新聞網址"),
  };
  const set = {};
  for (const [fieldName, label] of [["products", "商品／產品"], ["brands", "品牌"], ["companies", "相關業者"], ["evidence", "證據句"]]) {
    const value = parsedList(field(corrected, label));
    if (value !== undefined) set[fieldName] = value;
  }
  const reason = section(body, "修正理由或原文位置");
  if (!match.url) throw new Error("新聞解析修正缺少新聞網址");
  const parsedUrl = new URL(match.url);
  if (!/^https?:$/.test(parsedUrl.protocol)) throw new Error("新聞網址必須是 http 或 https");
  if (!match.title || !/^\d{4}-\d{2}-\d{2}$/.test(match.date)) throw new Error("新聞解析修正缺少標題或正確日期");
  if (!Object.keys(set).length) throw new Error("請至少填寫一個需要修正的商品、品牌、相關業者或證據句");
  if (!reason) throw new Error("請填寫修正理由或原文位置");
  return { match, set, reason, issueUrl };
}

export async function approveNewsCorrection(body = process.env.ISSUE_BODY || "", issueUrl = process.env.ISSUE_URL || "") {
  const parsed = parseNewsCorrectionIssue(body, issueUrl);
  const [data, manualData] = await Promise.all([
    readFile(NEWS_FILE, "utf8").then(JSON.parse),
    readFile(MANUAL_NEWS_FILE, "utf8").then(JSON.parse),
  ]);
  const matched = [...data.items, ...(manualData.items || [])].filter((item) => newsCorrectionMatches(item, parsed));
  if (matched.length !== 1) throw new Error(`新聞解析修正應對應 1 筆目前資料，實際找到 ${matched.length} 筆`);

  const current = JSON.parse(await readFile(NEWS_CORRECTIONS_FILE, "utf8").catch(() => '{"items":[]}'));
  const items = Array.isArray(current.items) ? current.items : [];
  const id = createHash("sha256").update(JSON.stringify(parsed.match)).digest("hex").slice(0, 16);
  const index = items.findIndex((item) => item.id === id);
  const correction = { id, ...parsed, set: { ...(index >= 0 ? items[index].set : {}), ...parsed.set }, approvedAt: new Date().toISOString() };
  if (index >= 0) items[index] = correction; else items.unshift(correction);

  const records = applyNewsCorrections(data.items, [correction]);
  const manualRecords = applyNewsCorrections(manualData.items || [], [correction]);
  const updatedAt = new Date().toISOString();
  await writeFile(NEWS_CORRECTIONS_FILE, JSON.stringify({ updatedAt, items }, null, 2) + "\n");
  await writeFile(NEWS_FILE, JSON.stringify({ ...data, updatedAt, items: records }));
  await writeFile(MANUAL_NEWS_FILE, JSON.stringify({ ...manualData, updatedAt, items: manualRecords }, null, 2) + "\n");
  return correction;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const correction = await approveNewsCorrection();
  console.log(`已套用新聞解析修正：${correction.id}`);
}
