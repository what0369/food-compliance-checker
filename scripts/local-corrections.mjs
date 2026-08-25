import { readFile } from "node:fs/promises";

export const CORRECTIONS_FILE = new URL("../public/data/local-corrections.json", import.meta.url);

const text = (value) => String(value ?? "").trim();
const normalizedUrl = (value) => {
  try { return new URL(text(value)).href; }
  catch { return text(value); }
};

export function correctionMatches(item, correction) {
  if (normalizedUrl(item.url) !== normalizedUrl(correction.sourceUrl)) return false;
  return ["date", "product", "company", "manufacturer"].every((field) => text(item[field]) === text(correction.match?.[field]));
}

export function applyLocalCorrections(records, corrections) {
  return corrections.reduce((current, correction) => current.map((item) => correctionMatches(item, correction) ? {
    ...item,
    ...correction.set,
    correctionIssueUrl: correction.issueUrl,
    correctionNote: correction.reason,
    correctionApprovedAt: correction.approvedAt,
  } : item), records);
}

export async function loadLocalCorrections() {
  const current = JSON.parse(await readFile(CORRECTIONS_FILE, "utf8").catch(() => '{"items":[]}'));
  return Array.isArray(current.items) ? current.items : [];
}
