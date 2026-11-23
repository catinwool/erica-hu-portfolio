const SHELF = "https://bookmark.erica-hu.com";
const API = `${SHELF}/api/bookmark`;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "save-to-bookmark",
    title: "Save to Bookmark",
    contexts: ["page", "link", "selection"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "save-to-bookmark" || !tab?.id) return;
  const url = info.linkUrl || info.pageUrl || tab.url;
  await saveFromTab(tab.id, url, Boolean(info.linkUrl && info.linkUrl !== tab.url));
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "save-page") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await saveFromTab(tab.id, tab.url, false);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "save-active") return;
  (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      sendResponse({ ok: false, error: "No page is open." });
      return;
    }
    sendResponse(await saveFromTab(tab.id, tab.url, false));
  })().catch((error) => {
    sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
  });
  return true;
});

async function saveFromTab(tabId, fallbackUrl, linkOnly) {
  let page = { url: cleanUrl(fallbackUrl), html: "", title: "" };
  if (!linkOnly) {
    try {
      page = await readPage(tabId);
    } catch {
      page = { url: cleanUrl(fallbackUrl), html: "", title: "" };
    }
  }
  if (!page.url) {
    return remember({ ok: false, error: "This page has no link to save." });
  }
  return remember(await postSave(page));
}

async function readPage(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const pick =
        document.querySelector("article") ||
        document.querySelector("[itemprop='articleBody']") ||
        document.querySelector("main") ||
        document.body;
      const title =
        document.querySelector('meta[property="og:title"]')?.content ||
        [...document.querySelectorAll("h1")]
          .map((node) => node.textContent.trim())
          .find((text) => text && text !== "The Generalist") ||
        document.title ||
        "";
      const author =
        document.querySelector('meta[name="author"]')?.content ||
        document.querySelector('meta[property="article:author"]')?.content ||
        "";
      const site =
        document.querySelector('meta[property="og:site_name"]')?.content ||
        location.hostname.replace(/^www\./, "");
      const esc = (value) =>
        String(value || "")
          .replace(/&/g, "&amp;")
          .replace(/"/g, "&quot;")
          .replace(/</g, "");
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(
        title
      )}</title><meta property="og:title" content="${esc(title)}"><meta name="author" content="${esc(
        author
      )}"><meta property="og:site_name" content="${esc(site)}"></head><body>${
        pick ? pick.outerHTML : ""
      }</body></html>`;
      return {
        url: location.href,
        title,
        html: html.slice(0, 1400000),
      };
    },
  });
  return {
    url: cleanUrl(result?.url),
    title: String(result?.title || ""),
    html: String(result?.html || ""),
  };
}

async function postSave(page) {
  const body = { kind: "save", url: page.url };
  if (page.html && page.html.length > 800) body.html = page.html;

  const first = await api(body);
  if (first.status === 401 || first.locked) {
    return {
      ok: false,
      locked: true,
      error: "Unlock Bookmark in Chrome, then try again.",
      open: `${SHELF}/bookmark`,
    };
  }
  if (!first.ok) {
    return { ok: false, error: first.error || "The shelf didn't take that page." };
  }
  if (first.duplicate && first.article?.id && page.html && page.html.length > 800) {
    const again = await api({
      kind: "refetch",
      articleId: first.article.id,
      html: page.html,
    });
    if (again.ok && again.article) {
      return {
        ok: true,
        refreshed: true,
        article: again.article,
        open: `${SHELF}/bookmark#read/${again.article.id}`,
      };
    }
  }
  if (first.duplicate) {
    return {
      ok: true,
      duplicate: true,
      article: first.article,
      open: first.article?.id ? `${SHELF}/bookmark#read/${first.article.id}` : `${SHELF}/bookmark`,
    };
  }
  return {
    ok: true,
    article: first.article,
    open: first.article?.id ? `${SHELF}/bookmark#read/${first.article.id}` : `${SHELF}/bookmark`,
  };
}

async function api(body) {
  const payload = JSON.stringify(body);
  const bytes = new TextEncoder().encode(payload);
  let response;
  try {
    response = await fetch(API, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: bytes,
    });
  } catch {
    return { ok: false, error: "Couldn't reach the shelf." };
  }
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (response.status === 401 || data.locked) return { ok: false, locked: true, status: 401 };
  if (!response.ok) return { ok: false, status: response.status, error: data.error || "The shelf didn't answer." };
  return { ok: true, status: response.status, ...data };
}

function cleanUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

async function remember(result) {
  await chrome.storage.session.set({ lastSave: { ...result, at: Date.now() } });
  if (result.ok) {
    chrome.action.setBadgeText({ text: "✓" });
    chrome.action.setBadgeBackgroundColor({ color: "#8f3b28" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2500);
  }
  return result;
}
