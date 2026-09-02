const CONFIG = Object.freeze({
  owner: "what0369",
  repo: "food-compliance-checker",
  tokenProperty: "GITHUB_TOKEN",
  timeZone: "Asia/Taipei",
});

function doGet() {
  return responsePage_("匿名審核送件服務運作中", "請從食安違規查核台提交新聞線索或新聞解析修正。");
}

function doPost(e) {
  try {
    const params = (e && e.parameter) || {};
    if (String(params.website || "").trim()) {
      return responsePage_("已收到", "謝謝提供資料。");
    }

    const kind = clean_(params.kind) || "news";
    if (["news", "newsCorrection"].indexOf(kind) < 0) throw new Error("不支援的送審類型");

    const newsUrl = canonicalizeUrl_(params.url);
    if (!newsUrl) throw new Error("請提供完整新聞網址");

    const token = PropertiesService.getScriptProperties().getProperty(CONFIG.tokenProperty);
    if (!token) throw new Error("服務尚未完成 GitHub 憑證設定");

    let issueTitle = "";
    let issueBody = "";
    let successTitle = "";
    let successMessage = "";

    if (kind === "newsCorrection") {
      issueTitle = clean_(params.title).slice(0, 120);
      issueBody = clean_(params.body).slice(0, 12000);
      if (issueTitle.indexOf("新聞解析修正：") !== 0) throw new Error("新聞解析修正標題格式不正確");
      if (issueBody.indexOf("## 新聞來源資料") < 0 || issueBody.indexOf("## 請填寫正確內容") < 0 || issueBody.indexOf("## 修正理由或原文位置") < 0) {
        throw new Error("新聞解析修正內容不完整");
      }
      successTitle = "新聞解析修正已送出";
      successMessage = "管理者核准後才會更新共用資料庫，你現在可以關閉此頁。";
    } else {
      const note = clean_(params.note).slice(0, 1500);
      if (!note) throw new Error("請提供新聞補充說明");
      const source = hostname_(newsUrl);
      const date = Utilities.formatDate(new Date(), CONFIG.timeZone, "yyyy-MM-dd");
      const titleText = note.split(/\r?\n/).filter(Boolean)[0].slice(0, 80) || ("新聞線索（" + source + "）");
      const safeNote = note.replace(/^## /gm, "＃＃ ");
      issueTitle = "新聞線索：" + titleText;
      issueBody = [
        "## 新聞標題", titleText, "",
        "## 新聞網址", newsUrl, "",
        "## 發布日期", date, "",
        "## 地區／主管機關", "待確認", "",
        "## 新聞來源", source, "",
        "## 補充說明", safeNote, "",
        "---",
        "由網站匿名表單提交。管理者核准後會解析新聞內文；若原站暫時無法讀取，系統會於每日更新重試。"
      ].join("\n");
      successTitle = "新聞線索已送出";
      successMessage = "管理者核准後才會納入共用資料庫，你現在可以關閉此頁。";
    }

    const cache = CacheService.getScriptCache();
    const key = digest_([kind, newsUrl, issueTitle, issueBody].join("|"));
    if (cache.get(key) || openIssueExists_(token, issueTitle)) {
      return responsePage_("這筆資料已送過", "不需要重複提交，管理者會進行審核。");
    }

    const response = UrlFetchApp.fetch(
      "https://api.github.com/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/issues",
      {
        method: "post",
        contentType: "application/json",
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        payload: JSON.stringify({ title: issueTitle, body: issueBody }),
        muteHttpExceptions: true,
      }
    );

    if (response.getResponseCode() !== 201) {
      console.error(response.getContentText());
      throw new Error("GitHub 暫時無法建立審核單");
    }

    cache.put(key, "1", 21600);
    return responsePage_(successTitle, successMessage);
  } catch (error) {
    console.error(error);
    return responsePage_("目前無法送出", String(error && error.message || error), true);
  }
}

function openIssueExists_(token, title) {
  const response = UrlFetchApp.fetch(
    "https://api.github.com/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/issues?state=open&per_page=100&sort=created&direction=desc",
    {
      method: "get",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      muteHttpExceptions: true,
    }
  );
  if (response.getResponseCode() !== 200) return false;
  const issues = JSON.parse(response.getContentText());
  return issues.some(function (issue) { return !issue.pull_request && issue.title === title; });
}

function canonicalizeUrl_(value) {
  const input = clean_(value);
  if (!/^https?:\/\//i.test(input)) return "";
  const parsed = new URL(input);
  parsed.hash = "";
  ["fbclid", "gclid", "ocid", "pc", "cvid", "ei"].forEach(function (key) {
    parsed.searchParams.delete(key);
  });
  Array.from(parsed.searchParams.keys()).forEach(function (key) {
    if (/^utm_/i.test(key)) parsed.searchParams.delete(key);
  });
  parsed.pathname = parsed.pathname.replace(/\/$/, "") || "/";
  return parsed.toString();
}

function hostname_(value) {
  try { return new URL(value).hostname.replace(/^www\./, ""); }
  catch (_) { return "新聞來源待確認"; }
}

function clean_(value) {
  return String(value || "").trim();
}

function digest_(value) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value)
  ).slice(0, 40);
}

function responsePage_(title, message, isError) {
  const color = isError ? "#a53f57" : "#7654a8";
  const html = "<!doctype html><html lang='zh-Hant'><meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<body style='font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f7f2fb;color:#2f2740;padding:48px 24px'>" +
    "<main style='max-width:560px;margin:auto;background:white;border:1px solid #dbcdec;border-radius:24px;padding:36px'>" +
    "<h1 style='color:" + color + ";font-size:28px'>" + escapeHtml_(title) + "</h1>" +
    "<p style='line-height:1.8'>" + escapeHtml_(message) + "</p></main></body></html>";
  return HtmlService.createHtmlOutput(html).setTitle(title);
}

function escapeHtml_(value) {
  return String(value).replace(/[&<>"']/g, function (character) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character];
  });
}
