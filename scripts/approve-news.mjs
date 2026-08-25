import { readFile, writeFile } from "node:fs/promises";
import { enrichNewsItem } from "./update-data.mjs";

const file = new URL("../public/data/manual-news.json", import.meta.url);
const body = process.env.ISSUE_BODY || "";

function section(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.match(new RegExp(`## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n---|$)`, "i"))?.[1]?.trim() || "";
}

const item = {
  title: section("新聞標題"),
  url: section("新聞網址"),
  date: section("發布日期"),
  region: section("地區／主管機關"),
  source: section("新聞來源"),
  note: section("補充說明"),
  manual: true,
  approvedAt: new Date().toISOString(),
  issueUrl: process.env.ISSUE_URL || "",
};

if (!item.title || !item.url) throw new Error("議題缺少新聞標題或網址");
const parsed = new URL(item.url);
if (!/^https?:$/.test(parsed.protocol)) throw new Error("新聞網址必須是 http 或 https");
if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date)) throw new Error("發布日期格式必須是 YYYY-MM-DD");

const current = JSON.parse(await readFile(file, "utf8").catch(() => '{"items":[]}'));
const items = Array.isArray(current.items) ? current.items : [];
const normalized = item.url.replace(/\/$/, "").toLowerCase();
const duplicateIndex = items.findIndex((existing) => String(existing.url || "").replace(/\/$/, "").toLowerCase() === normalized);
const enriched = await enrichNewsItem(item);
if (duplicateIndex >= 0) items[duplicateIndex] = { ...items[duplicateIndex], ...enriched, approvedAt: items[duplicateIndex].approvedAt || item.approvedAt, issueUrl: items[duplicateIndex].issueUrl || item.issueUrl };
else items.unshift(enriched);
const parsedCount = items.filter((entry) => entry.parseStatus === "parsed").length;
await writeFile(file, JSON.stringify({ updatedAt: new Date().toISOString(), parsedCount, titleOnlyCount: items.length - parsedCount, items }, null, 2) + "\n");
console.log(`${duplicateIndex >= 0 ? "已重新解析" : "已加入"}：${item.title}（${enriched.parseStatus === "parsed" ? "內文解析成功" : "僅取得標題"}）`);
