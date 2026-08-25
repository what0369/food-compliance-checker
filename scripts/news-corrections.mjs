import { readFile } from "node:fs/promises";

export const NEWS_CORRECTIONS_FILE = new URL("../public/data/news-corrections.json", import.meta.url);

const text = (value) => String(value ?? "").trim();

export function newsCorrectionMatches(item, correction) {
  return text(item.url) === text(correction.match?.url)
    && text(item.date) === text(correction.match?.date)
    && text(item.title) === text(correction.match?.title);
}

export function restoreNewsOriginal(item) {
  const original = item.originalParsedEntities;
  if (!original) return item;
  const {
    correctionIssueUrl: _issueUrl,
    correctionNote: _note,
    correctionApprovedAt: _approvedAt,
    originalParsedEntities: _original,
    ...base
  } = item;
  return {
    ...base,
    products: Array.isArray(original.products) ? original.products : [],
    brands: Array.isArray(original.brands) ? original.brands : [],
    companies: Array.isArray(original.companies) ? original.companies : [],
    evidence: Array.isArray(original.evidence) ? original.evidence : [],
  };
}

export function applyNewsCorrections(items, corrections) {
  return items.map((record) => {
    let item = restoreNewsOriginal(record);
    for (const correction of corrections) {
      if (!newsCorrectionMatches(item, correction)) continue;
      const originalParsedEntities = {
        products: Array.isArray(item.products) ? item.products : [],
        brands: Array.isArray(item.brands) ? item.brands : [],
        companies: Array.isArray(item.companies) ? item.companies : [],
        evidence: Array.isArray(item.evidence) ? item.evidence : [],
      };
      item = {
        ...item,
        ...correction.set,
        originalParsedEntities,
        correctionIssueUrl: correction.issueUrl,
        correctionNote: correction.reason,
        correctionApprovedAt: correction.approvedAt,
      };
    }
    return item;
  });
}

export async function loadNewsCorrections() {
  const data = JSON.parse(await readFile(NEWS_CORRECTIONS_FILE, "utf8").catch(() => '{"items":[]}'));
  return Array.isArray(data.items) ? data.items : [];
}
