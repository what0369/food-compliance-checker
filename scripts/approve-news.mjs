import { readFile, writeFile } from "node:fs/promises";

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
const duplicate = items.some((existing) => String(existing.url || "").replace(/\/$/, "").toLowerCase() === normalized);
if (!duplicate) items.unshift(item);
await writeFile(file, JSON.stringify({ updatedAt: new Date().toISOString(), items }, null, 2) + "\n");
console.log(duplicate ? "新聞已存在，未重複加入" : `已加入：${item.title}`);
