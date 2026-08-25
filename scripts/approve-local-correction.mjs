import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyLocalCorrections, correctionMatches, CORRECTIONS_FILE } from "./local-corrections.mjs";

const DATA_FILE = new URL("../public/data/local-official.json", import.meta.url);
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

const storedValue = (value) => value === "未提供" ? "" : value;

export function parseCorrectionIssue(body, issueUrl = "") {
  const sourceUrl = section(body, "官方來源").split(/\r?\n/).map(text).find((line) => /^https?:\/\//i.test(line)) || "";
  const currentSection = section(body, "目前網站資料");
  const correctedSection = section(body, "請填寫正確內容");
  const match = {
    date: storedValue(field(currentSection, "日期")),
    product: storedValue(field(currentSection, "商品")),
    company: storedValue(field(currentSection, "業者")),
    manufacturer: storedValue(field(currentSection, "製造商")),
  };
  const set = {};
  for (const [fieldName, label] of [["product", "商品"], ["company", "業者"], ["manufacturer", "製造商"]]) {
    const value = field(correctedSection, label);
    if (value) set[fieldName] = CLEAR_VALUES.has(value) ? "" : value;
  }
  const reason = section(body, "修正理由或原文位置");
  if (!sourceUrl) throw new Error("修正申請缺少官方來源網址");
  const parsedUrl = new URL(sourceUrl);
  if (!/^https?:$/.test(parsedUrl.protocol)) throw new Error("官方來源必須是 http 或 https 網址");
  if (!match.date || !/^\d{4}-\d{2}-\d{2}$/.test(match.date)) throw new Error("目前資料缺少正確的 YYYY-MM-DD 日期");
  if (!Object.keys(set).length) throw new Error("請至少填寫一個需要修正的商品、業者或製造商；若要清空欄位請填「刪除」");
  return { sourceUrl, match, set, reason, issueUrl };
}

export async function approveLocalCorrection(body = process.env.ISSUE_BODY || "", issueUrl = process.env.ISSUE_URL || "") {
  const parsed = parseCorrectionIssue(body, issueUrl);
  const data = JSON.parse(await readFile(DATA_FILE, "utf8"));
  const matched = data.records.filter((item) => correctionMatches(item, parsed));
  if (matched.length !== 1) throw new Error(`修正申請應對應 1 筆目前資料，實際找到 ${matched.length} 筆；請重新確認目前欄位內容`);

  const current = JSON.parse(await readFile(CORRECTIONS_FILE, "utf8").catch(() => '{"items":[]}'));
  const items = Array.isArray(current.items) ? current.items : [];
  const id = createHash("sha256").update(JSON.stringify([parsed.sourceUrl, parsed.match])).digest("hex").slice(0, 16);
  const index = items.findIndex((item) => item.id === id);
  const correction = { id, ...parsed, set: { ...(index >= 0 ? items[index].set : {}), ...parsed.set }, approvedAt: new Date().toISOString() };
  if (index >= 0) items[index] = correction; else items.unshift(correction);

  const records = applyLocalCorrections(data.records, [correction]);
  const updatedAt = new Date().toISOString();
  await writeFile(CORRECTIONS_FILE, JSON.stringify({ updatedAt, items }, null, 2) + "\n");
  await writeFile(DATA_FILE, JSON.stringify({ ...data, updatedAt, records }));
  return correction;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const correction = await approveLocalCorrection();
  console.log(`已套用人工修正：${correction.id}`);
}
