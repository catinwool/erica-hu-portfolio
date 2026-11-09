"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const FILE = path.join(__dirname, "..", "bookmark", "library.json");
const BLOB_PATH = "bookmark/library.json";
const SESSION_SECONDS = 400 * 24 * 60 * 60;
const attempts = new Map();
const revoked = new Set();

function loadEnv() {
  let text = "";
  try {
    text = require("fs").readFileSync(path.join(__dirname, "..", ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv();

const SEED = {
  articles: [
    {
      id: "corner",
      title: "The corner table",
      savedAt: "2026-10-18",
      tags: ["attention", "cities"],
      sample: true,
      paragraphs: [
        "There is a table by the window that nobody asks for. The light is uneven and the chair wobbles, so it stays empty until late afternoon, which is when it becomes the best seat in the room.",
        "I read there because the street does the remembering for me. A bus sighs at the curb. Someone laughs and then is gone. The page holds still while the city keeps moving, and that difference is the whole pleasure.",
        "A sentence worth keeping has to survive being lifted out of its paragraph. If it still sounds like itself on a blank page, it was already doing the work.",
      ],
    },
    {
      id: "hands",
      title: "What the hands remember",
      savedAt: "2026-10-04",
      tags: ["making"],
      sample: true,
      paragraphs: [
        "A recipe written down is a rumor. The real one is in the hands: how long the onions actually take, when the pan is hot enough, the moment the dough stops sticking.",
        "I trust notes that include the mistake. The first time the sauce split. The second time it didn't, and why. A clean list of steps is less useful than one stain on the page.",
      ],
    },
    {
      id: "kitchen",
      title: "Left on the kitchen table",
      savedAt: "2026-09-21",
      tags: ["friendship", "attention"],
      sample: true,
      paragraphs: [
        "Friendship, most days, is logistics. Who is coming, who is late, who needs to eat before they can talk. The talk still matters. It just arrives after the soup.",
        "She left the sentence on a scrap beside the keys: come by if the evening gets too loud. No instructions. The invitation was the whole of it, and it was enough.",
      ],
    },
  ],
  quotes: [
    {
      id: "q-still",
      articleId: "corner",
      text: "The page holds still while the city keeps moving, and that difference is the whole pleasure.",
      at: "2026-10-18T16:00:00.000Z",
    },
    {
      id: "q-sentence",
      articleId: "corner",
      text: "A sentence worth keeping has to survive being lifted out of its paragraph.",
      at: "2026-10-18T16:04:00.000Z",
    },
    {
      id: "q-stain",
      articleId: "hands",
      text: "A clean list of steps is less useful than one stain on the page.",
      at: "2026-10-04T15:00:00.000Z",
    },
    {
      id: "q-invitation",
      articleId: "kitchen",
      text: "The invitation was the whole of it, and it was enough.",
      at: "2026-09-21T19:12:00.000Z",
    },
    {
      id: "q-logistics",
      articleId: "kitchen",
      text: "Friendship, most days, is logistics.",
      at: "2026-09-21T19:08:00.000Z",
    },
  ],
};

function seed() {
  return JSON.parse(JSON.stringify(SEED));
}

function fail(status, error, expose) {
  const err = new Error(error);
  err.status = status;
  if (expose) err.expose = true;
  throw err;
}

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

function cleanText(value, max) {
  return String(value || "")
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function cleanId(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 40);
}

function tagsFrom(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  const out = [];
  for (const item of list) {
    const tag = String(item || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 32);
    if (!tag || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= 8) break;
  }
  return out;
}

function folderFrom(value) {
  return tagsFrom(value)[0] || "";
}

const TAG_STOP = new Set(
  `a an the of and or but if to in on for with at from by as into about over after before between through without within this that these those it its i you we they he she them their his her my our your me him us not no do does did be is are was were been being have has had will would can could should may might must shall just also than then too very really only even still already much many more most some any such own other another there here when where what which who how why all each every both few same one two first second last next part kind sort lot bit way ways thing things time times year years day days make makes made making get got getting go going went come came take took see saw look looking know knew say said says saying want wanted need needed like liked feel felt seem seemed people person something anything everything nothing someone actually maybe perhaps quite rather almost enough whole yet among amongst against along toward towards upon per via because although though while whether since until unless including around across onto off out up down back again once now always never often sometimes well good great little big long high new old right left yes dont doesnt didnt isnt arent wasnt werent cant couldnt wont wouldnt im ive thats theres youre lets were theyre however therefore anyway somehow somewhere everybody anybody better best hard else doing help helps able interested word words class book books idea ideas journey reader actual specific type entirely important possible certain father helped helping called asked told felt knew seemed started became using trying wanted usually probably point points example examples life world work place put keep use tell ask try start leave find give mean fact facts end ends lots bits acknowledgements acknowledgment acknowledgments acknowledgement foreword introduction notes different bring tools tool think thinks thought answer answers question questions detail details`.split(
    /\s+/
  )
);

const TAG_NAMES_SKIP = new Set("english chinese french spanish google maps point heart sour john mice days".split(/\s+/));

function tagStem(word) {
  let value = String(word || "")
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/'(s|re|ve|ll|d|m)$/i, "")
    .replace(/'/g, "");
  if (value.length > 5 && value.endsWith("ies")) return value.slice(0, -3) + "y";
  if (value.length > 4 && value.endsWith("es") && !value.endsWith("ss") && !value.endsWith("ous")) return value.slice(0, -2);
  if (value.length > 4 && value.endsWith("s") && !value.endsWith("ss")) return value.slice(0, -1);
  return value;
}

function tagSurface(word) {
  return String(word || "")
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/'(s|re|ve|ll|d|m)$/i, "")
    .replace(/'/g, "");
}

function suggestTags(article) {
  const blocks = Array.isArray(article && article.blocks) && article.blocks.length ? article.blocks : article.paragraphs || [];
  const parts = [];
  for (const block of blocks) {
    if (typeof block === "string") parts.push(block);
    else if (block && block.heading) parts.push(block.heading);
  }
  const text = parts.join("\n");
  if (text.length < 280) return [];
  const banned = new Set();
  for (const bit of [article.author, article.site, article.folder]) {
    for (const word of String(bit || "").match(/[A-Za-z][A-Za-z']*/g) || []) banned.add(tagStem(word));
  }
  const counts = new Map();
  const surfaces = new Map();
  const phrases = new Map();
  const names = new Map();
  let seen = 0;
  const sentences = text.split(/[.!?;:,\n]+/);
  for (const sentence of sentences) {
    const words = sentence.match(/[A-Za-z][A-Za-z']*/g) || [];
    const kept = [];
    words.forEach((word, index) => {
      const stem = tagStem(word);
      const surface = tagSurface(word);
      if (index > 0 && word[0] >= "A" && word[0] <= "Z" && stem.length >= 5 && !TAG_STOP.has(stem) && !TAG_NAMES_SKIP.has(stem) && !banned.has(stem)) {
        names.set(stem, (names.get(stem) || 0) + 1);
        const seenName = surfaces.get(stem) || new Map();
        seenName.set(surface, (seenName.get(surface) || 0) + 1);
        surfaces.set(stem, seenName);
      }
      if (!stem || stem.length < 4 || TAG_STOP.has(stem) || banned.has(stem)) {
        kept.push("");
        return;
      }
      seen += 1;
      counts.set(stem, (counts.get(stem) || 0) + 1);
      const seenWord = surfaces.get(stem) || new Map();
      seenWord.set(surface, (seenWord.get(surface) || 0) + 1);
      surfaces.set(stem, seenWord);
      kept.push(stem);
    });
    for (let i = 0; i < kept.length - 1; i += 1) {
      if (!kept[i] || !kept[i + 1]) continue;
      const key = kept[i] + "\n" + kept[i + 1];
      phrases.set(key, (phrases.get(key) || 0) + 1);
    }
  }
  const show = (stem) => {
    const forms = surfaces.get(stem);
    if (!forms) return stem;
    let best = stem;
    let bestCount = -1;
    for (const [form, count] of forms) {
      if (count > bestCount) {
        best = form;
        bestCount = count;
      }
    }
    return best;
  };
  const candidates = [];
  for (const [key, count] of phrases) {
    if (count < 4) continue;
    const [left, right] = key.split("\n");
    candidates.push({ score: count * 4, stems: [left, right], phrase: show(left) + " " + show(right) });
  }
  const minimum = seen > 800 ? 8 : 3;
  for (const [stem, count] of counts) {
    if (count < minimum) continue;
    candidates.push({ score: count, stems: [stem], phrase: show(stem) });
  }
  for (const [stem, count] of names) {
    if (count < 2) continue;
    candidates.push({ score: count + 2, stems: [stem], phrase: show(stem) });
  }
  candidates.sort((a, b) => b.score - a.score || a.phrase.localeCompare(b.phrase));
  const chosen = [];
  const used = new Set();
  for (const candidate of candidates) {
    if (candidate.stems.some((stem) => used.has(stem))) continue;
    chosen.push(candidate.phrase);
    for (const stem of candidate.stems) used.add(stem);
    if (chosen.length >= 4) break;
  }
  return tagsFrom(chosen);
}

function cleanUrl(value) {
  let raw = String(value || "").trim();
  if (!raw) return "";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = "https://" + raw;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.href.slice(0, 500);
  } catch {
    return "";
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function uid() {
  return crypto.randomBytes(6).toString("hex");
}

function normalize(data) {
  const source = data && typeof data === "object" ? data : {};
  const articles = Array.isArray(source.articles) ? source.articles.map(cleanArticle).filter(Boolean) : [];
  const ids = new Set(articles.map((article) => article.id));
  const quotes = Array.isArray(source.quotes)
    ? source.quotes.map(cleanQuote).filter((quote) => quote && ids.has(quote.articleId))
    : [];
  return { articles, quotes };
}

function cleanBlocks(value) {
  if (!Array.isArray(value)) return [];
  const blocks = [];
  for (const block of value) {
    if (typeof block === "string") {
      const text = cleanText(block, 5000);
      if (text) blocks.push(text);
    } else if (block && typeof block === "object") {
      if (typeof block.poem === "string") {
        const line = String(block.poem).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, 5000);
        blocks.push({ poem: line });
        continue;
      }
      const quote = cleanText(block.quote, 5000);
      if (quote) {
        blocks.push({ quote });
      } else {
        const heading = cleanText(block.heading, 180);
        if (heading) {
          blocks.push({ heading });
        } else {
          const image = cleanUrl(block.image);
          if (image) blocks.push({ image, alt: cleanText(block.alt, 240) });
        }
      }
    }
    if (blocks.length >= 240) break;
  }
  return blocks;
}

function cleanArticle(article) {
  if (!article || typeof article !== "object") return null;
  const title = cleanText(article.title, 180);
  const id = cleanId(article.id);
  if (!title || !id) return null;
  const paragraphs = Array.isArray(article.paragraphs)
    ? article.paragraphs.map((paragraph) => cleanText(paragraph, 5000)).filter(Boolean).slice(0, 200)
    : [];
  const saved = String(article.savedAt || "");
  const legacyFolder = !Object.prototype.hasOwnProperty.call(article, "folder");
  const folder = folderFrom(legacyFolder ? article.tags : article.folder);
  const record = {
    id,
    title,
    author: cleanText(article.author, 120),
    site: cleanText(article.site, 120),
    url: cleanUrl(article.url),
    savedAt: /^\d{4}-\d{2}-\d{2}/.test(saved) ? saved.slice(0, 10) : today(),
    folder,
    tags: legacyFolder ? [] : tagsFrom(article.tags),
    paragraphs,
  };
  const blocks = cleanBlocks(article.blocks);
  if (blocks.length) record.blocks = blocks;
  if (article.sample) record.sample = true;
  return record;
}

function cleanQuote(quote) {
  if (!quote || typeof quote !== "object") return null;
  const id = cleanId(quote.id);
  const articleId = cleanId(quote.articleId);
  const text = cleanText(quote.text, 8000);
  if (!id || !articleId || text.length < 2) return null;
  const at = String(quote.at || "");
  const record = {
    id,
    articleId,
    text,
    at: /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 24) : new Date().toISOString(),
  };
  const ink = cleanInk(quote.ink) || "yellow";
  record.ink = ink;
  const book = folderFrom(quote.book);
  if (book) record.book = book;
  return record;
}

function cleanInk(value) {
  const ink = String(value || "").trim().toLowerCase();
  return ["yellow", "green", "orange", "pink", "lilac", "blue"].includes(ink) ? ink : "";
}

function password() {
  return String(process.env.BOOKMARK_PASSWORD || "").trim();
}

function secret() {
  return String(process.env.BOOKMARK_SECRET || password() || "").trim();
}

function mailReady() {
  return Boolean(String(process.env.RESEND_API_KEY || "").trim() && inbox());
}

function inbox() {
  const to = String(process.env.BOOKMARK_EMAIL || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return "";
  return to;
}

function sign(payload) {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

function passwordMatches(given) {
  const expected = password();
  const attempt = String(given || "");
  if (!expected || !attempt) return false;
  const hash = (value) => crypto.createHash("sha256").update(value).digest();
  return crypto.timingSafeEqual(hash(attempt), hash(expected));
}

function cookieValue(req, name) {
  const cookie = String((req.headers && req.headers.cookie) || "");
  const pair = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(name + "="));
  if (!pair) return "";
  try {
    return decodeURIComponent(pair.slice(name.length + 1));
  } catch {
    return "";
  }
}

function writeCookies(res, req, cookies) {
  const proto = String((req.headers && req.headers["x-forwarded-proto"]) || "");
  const secure = proto.split(",")[0].trim() === "https";
  res.setHeader(
    "set-cookie",
    cookies.map((cookie) => {
      const parts = [
        `${cookie.name}=${encodeURIComponent(cookie.value || "")}`,
        "HttpOnly",
        "SameSite=Lax",
        "Path=/",
        `Max-Age=${cookie.maxAge}`,
      ];
      if (secure) parts.push("Secure");
      return parts.join("; ");
    })
  );
}

function sessionToken() {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = `1.${exp}`;
  return `${payload}.${sign(payload)}`;
}

function sessionValid(token) {
  if (!password() || !secret() || revoked.has(token)) return false;
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== "1") return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const payload = `1.${parts[1]}`;
  return safeEqual(sign(payload), parts[2]);
}

function issueStep(code) {
  const exp = Math.floor(Date.now() / 1000) + 10 * 60;
  const hash = crypto.createHash("sha256").update(String(code)).digest("base64url");
  const payload = `1.${exp}.${hash}.0`;
  return `${payload}.${sign(payload)}`;
}

function readStep(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 5 || parts[0] !== "1") return null;
  const payload = parts.slice(0, 4).join(".");
  if (!safeEqual(sign(payload), parts[4])) return null;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
  const tries = Number(parts[3]);
  if (!Number.isFinite(tries) || tries < 0) return null;
  return { exp, hash: parts[2], tries };
}

function clientIp(req) {
  const forwarded = String((req.headers && req.headers["x-forwarded-for"]) || "");
  return forwarded.split(",")[0].trim() || (req.socket && req.socket.remoteAddress) || "local";
}

function tooMany(ip) {
  const row = attempts.get(ip);
  if (!row) return false;
  if (row.until > Date.now()) return true;
  if (Date.now() - row.start > 15 * 60 * 1000) {
    attempts.delete(ip);
    return false;
  }
  return false;
}

function markFail(ip) {
  const now = Date.now();
  const row = attempts.get(ip) || { count: 0, start: now, until: 0 };
  if (now - row.start > 15 * 60 * 1000) {
    row.count = 0;
    row.start = now;
    row.until = 0;
  }
  row.count += 1;
  if (row.count >= 8) row.until = now + 15 * 60 * 1000;
  attempts.set(ip, row);
  if (attempts.size > 500) {
    const oldest = attempts.keys().next().value;
    attempts.delete(oldest);
  }
}

function markOk(ip) {
  attempts.delete(ip);
}

function allowed(req) {
  if (!password()) return true;
  return sessionValid(cookieValue(req, "bookmark"));
}

async function sendCode(code) {
  const key = String(process.env.RESEND_API_KEY || "").trim();
  const to = inbox();
  if (!key || !to) return false;
  const from = String(process.env.BOOKMARK_FROM || "Bookmark <bookmark@erica-hu.com>").trim();
  let res;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(8000),
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: "Your Bookmark code",
        text: `Your code is ${code}. It expires in 10 minutes. If you did not ask for this, you can ignore this email.`,
      }),
    });
  } catch {
    return false;
  }
  if (!res.ok) console.error("bookmark mail", res.status);
  return res.ok;
}

function tokenFrom(req) {
  const header = req && req.headers && req.headers["x-vercel-oidc-token"];
  const value = Array.isArray(header) ? header[0] : header;
  return String(value || process.env.VERCEL_OIDC_TOKEN || "").trim();
}

function blobAuth(token) {
  const rw = String(process.env.BOOKMARK_BLOB_READ_WRITE_TOKEN || "").trim();
  if (rw) return { token: rw };
  const auth = {};
  const storeId = String(process.env.BOOKMARK_BLOB_STORE_ID || "").trim();
  const oidc = String(token || process.env.VERCEL_OIDC_TOKEN || "").trim();
  if (oidc) auth.oidcToken = oidc;
  if (storeId) auth.storeId = storeId;
  return auth;
}

function useBlob() {
  return Boolean(process.env.BOOKMARK_BLOB_READ_WRITE_TOKEN || process.env.BOOKMARK_BLOB_STORE_ID);
}

async function blobRead(token) {
  const { get } = require("@vercel/blob");
  const result = await get(BLOB_PATH, { access: "private", useCache: false, ...blobAuth(token) });
  if (!result || result.statusCode === 304 || !result.stream) return null;
  const text = await new Response(result.stream).text();
  return normalize(JSON.parse(text));
}

async function blobWrite(body, token) {
  const { put } = require("@vercel/blob");
  await put(BLOB_PATH, body, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 60,
    ...blobAuth(token),
  });
}

let libraryCache = null;

async function readLibrary(token) {
  if (libraryCache) return libraryCache;
  if (useBlob()) {
    try {
      const data = await blobRead(token);
      if (data) {
        libraryCache = data;
        return data;
      }
    } catch (error) {
      console.error("bookmark read", error && error.message);
    }
  }
  try {
    const text = await fs.readFile(FILE, "utf8");
    libraryCache = normalize(JSON.parse(text));
    return libraryCache;
  } catch (error) {
    if (!error || error.code !== "ENOENT") console.error("bookmark file", error && error.message);
    return seed();
  }
}

async function writeLibrary(library, token) {
  const body = JSON.stringify(library, null, 2) + "\n";
  if (useBlob()) {
    await blobWrite(body, token);
    libraryCache = library;
    return;
  }
  await fs.writeFile(FILE, body);
  libraryCache = library;
}

function shelfMinutes(article) {
  const words = plainOf((article.paragraphs || []).join(" "))
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  if (words < 40) return 0;
  return Math.max(1, Math.round(words / 250));
}

function shelfPreview(article) {
  const blocks = article.blocks || [];
  const image = blocks.find(
    (block) => block && block.image && !spareImage(block, article.author)
  );
  if (!image) return undefined;
  return { image: image.image, alt: image.alt || "" };
}

function shelfArticle(article) {
  return {
    id: article.id,
    title: article.title,
    author: article.author || "",
    site: article.site || "",
    url: article.url || "",
    savedAt: article.savedAt,
    folder: article.folder || "",
    tags: article.tags || [],
    sample: Boolean(article.sample),
    minutes: shelfMinutes(article),
    prose:
      (article.paragraphs || []).some((line) => plainOf(line).length > 80) ||
      plainOf((article.paragraphs || []).join("")).replace(/\s+/g, "").length > 200,
    preview: shelfPreview(article),
  };
}

function folderIndex(articles) {
  const newest = new Map();
  for (const article of articles || []) {
    const folder = article.folder || "";
    if (!folder) continue;
    const stamp = String(article.savedAt || "");
    const prev = newest.get(folder) || "";
    if (stamp > prev) newest.set(folder, stamp);
  }
  return [...newest.entries()].map(([name, at]) => ({ name, at }));
}

function orderedArticles(library) {
  return (library.articles || []).slice().sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)) || String(a.title).localeCompare(String(b.title)));
}

function shelfPage(library, options) {
  const from = Math.max(0, Number(options.from) || 0);
  const limit = Math.min(40, Math.max(1, Number(options.limit) || 20));
  let list = orderedArticles(library);
  const folder = String(options.folder || "");
  const topic = String(options.topic || "");
  if (folder) list = list.filter((article) => (article.folder || "") === folder);
  if (topic) list = list.filter((article) => (article.tags || []).includes(topic));
  const slice = list.slice(from, from + limit).map(shelfArticle);
  const have = new Set(slice.map((article) => article.id));
  const kept = [];
  for (const id of options.also || []) {
    if (have.has(id)) continue;
    const article = (library.articles || []).find((item) => item.id === id);
    if (!article) continue;
    kept.push(shelfArticle(article));
    have.add(id);
  }
  const page = {
    articles: slice,
    kept,
    more: from + slice.length < list.length,
    next: from + slice.length,
    total: list.length,
    sealed: Boolean(password()),
    shelf: true,
    page: true,
  };
  if (from === 0) page.folders = folderIndex(library.articles);
  return page;
}

function shelfLibrary(library) {
  return {
    articles: (library.articles || []).map(shelfArticle),
    quotes: library.quotes || [],
    sealed: Boolean(password()),
    shelf: true,
  };
}

function searchLibrary(library, query) {
  const words = String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  if (!words.length) return { articles: [], quotes: [] };
  const articles = [];
  for (const article of library.articles || []) {
    const hay = [
      article.title,
      article.author,
      article.site,
      article.url,
      article.folder,
      ...(article.tags || []),
      ...(article.paragraphs || []).map(plainOf),
    ]
      .join("\n")
      .toLowerCase();
    if (!words.every((word) => hay.includes(word))) continue;
    articles.push(shelfArticle(article));
    if (articles.length >= 40) break;
  }
  const byId = new Map((library.articles || []).map((article) => [article.id, article]));
  const quotes = [];
  for (const quote of library.quotes || []) {
    const article = byId.get(quote.articleId);
    const hay = (quote.text + "\n" + (article ? article.title : "")).toLowerCase();
    if (!words.every((word) => hay.includes(word))) continue;
    quotes.push(quote);
    if (quotes.length >= 40) break;
  }
  return { articles, quotes };
}

async function readJson(req) {
  let raw = req.body;
  if (raw == null) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    raw = Buffer.concat(chunks).toString("utf8");
  } else if (Buffer.isBuffer(raw)) {
    raw = raw.toString("utf8");
  }
  if (typeof raw === "string") {
    if (raw.length > 400000) fail(413, "That piece is too long to keep.");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  }
  return raw && typeof raw === "object" ? raw : {};
}

function findArticle(library, value) {
  const id = cleanId(value);
  const article = library.articles.find((item) => item.id === id);
  if (!article) fail(400, "That piece isn't on the shelf.");
  return article;
}

function openable(url) {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host.includes(":")) return host !== "::1" && !host.startsWith("fe80:") && !host.startsWith("fc") && !host.startsWith("fd");
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return true;
  const [a, b] = parts.map(Number);
  if (a === 10 || a === 127 || a === 0) return false;
  if (a === 169 && b === 254) return false;
  if (a === 192 && b === 168) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  return true;
}

function hostnameOf(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function metaContent(document, selector) {
  const node = document.querySelector(selector);
  return node ? node.getAttribute("content") || "" : "";
}

function absoluteUrl(value, base) {
  try {
    return new URL(value, base).href;
  } catch {
    return "";
  }
}

function pictureSize(src) {
  const name = String(src || "");
  const width = name.match(/(?:[,&/_])w_(\d+)/) || name.match(/[?&]w=(\d+)/);
  const height = name.match(/(?:[,&/_])h_(\d+)/) || name.match(/[?&]h=(\d+)/);
  const file = name.match(/_(\d{2,5})x(\d{2,5})\./);
  return {
    width: width ? Number(width[1]) : 0,
    height: height ? Number(height[1]) : 0,
    fileWidth: file ? Number(file[1]) : 0,
    fileHeight: file ? Number(file[2]) : 0,
  };
}

function iconImage(src) {
  const size = pictureSize(src);
  if (size.width && size.height && size.width <= 160 && size.height <= 160) return true;
  if (size.width && size.width <= 140 && !size.height) return true;
  if (size.height && size.height <= 140 && !size.width) return true;
  if (size.width && size.height && size.height <= 140 && size.width <= 240) return true;
  if (size.fileHeight && size.fileHeight < 180 && size.fileWidth / size.fileHeight > 4) return true;
  return false;
}

function logoImage(src, alt) {
  const name = String(src || "").toLowerCase();
  const label = String(alt || "").toLowerCase();
  if (iconImage(name)) return true;
  if (/\.svg(?:$|\?)/.test(name) && label.length < 12) return true;
  if (/\blogo\b|logotype|wordmark|favicon|apple-touch|site-icon|avatar/.test(name + " " + label)) return true;
  if (/\bicon\b/.test(label) && label.length < 48) return true;
  if (/\/themes\/[^?]+\/assets\//.test(name)) return true;
  return false;
}

function plainName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function authorPortrait(src, alt, author) {
  const name = plainName(author);
  const label = plainName(alt);
  if (name.length > 2 && label === name) return true;
  const size = pictureSize(src);
  const square = size.width && size.height && size.width <= 220 && size.height <= 220 && Math.abs(size.width - size.height) <= 24;
  if (square && /^(a |an )?(man|woman|person|portrait)\b/.test(label)) return true;
  const file = String(src || "").toLowerCase();
  if (!/headshot|byline|avatar|author[-_]?photo|blurple/.test(file)) return false;
  const parts = name.split(" ").filter((part) => part.length > 2);
  return parts.some((part) => file.includes(part));
}

function spareImage(block, author) {
  if (!block || !block.image) return false;
  return logoImage(block.image, block.alt) || authorPortrait(block.image, block.alt, author);
}

function dropSavedMarks(library) {
  for (const article of (library && library.articles) || []) {
    if (!Array.isArray(article.blocks)) continue;
    const next = article.blocks.filter((block) => !spareImage(block, article.author));
    if (next.length !== article.blocks.length) article.blocks = next;
  }
}

function decorativeImage(src, alt) {
  const name = String(src || "").toLowerCase();
  if (logoImage(name, alt)) return true;
  if (/\/themes\/[^?]+\/assets\//.test(name)) return true;
  if (/\.svg(?:$|\?)/.test(name) && !alt) return true;
  return /underline|frame-|\/logo|icon|sprite|\/share|plugin|pixel|spacer|badge|opengraph/.test(name);
}

function imageFrom(node, pageUrl) {
  const src = node.getAttribute("src") || node.getAttribute("data-src") || "";
  const alt = cleanText(node.getAttribute("alt") || "", 240);
  if (!src || decorativeImage(src, alt)) return null;
  const width = Number(node.getAttribute("width") || 0);
  const height = Number(node.getAttribute("height") || 0);
  if ((width && width < 48) || (height && height < 48)) return null;
  const image = cleanUrl(absoluteUrl(src, pageUrl));
  if (!image) return null;
  return { image, alt };
}

function firstImage(document, pageUrl) {
  const candidates = [];
  for (const node of document.querySelectorAll("img")) {
    if (node.closest("nav, header, footer")) continue;
    const image = imageFrom(node, pageUrl);
    if (image) candidates.push(image);
  }
  const size = (image) => pictureSize(image.image);
  return (
    candidates.find((image) => size(image).width >= 400 || size(image).fileWidth >= 400) ||
    candidates.find((image) => image.alt.length >= 8) ||
    null
  );
}

const BOLD_ON = "\uE000";
const BOLD_OFF = "\uE001";
const ITALIC_ON = "\uE002";
const ITALIC_OFF = "\uE003";

function plainOf(value) {
  return String(value || "").replace(/[\uE000-\uE003]/g, "");
}

function faceOf(node) {
  const tag = node.tagName;
  const style = String((node.getAttribute && node.getAttribute("style")) || "");
  const cls = String((node.getAttribute && node.getAttribute("class")) || "");
  return {
    bold: tag === "STRONG" || tag === "B" || /font-weight\s*:\s*(bold|[6-9]00)\b/i.test(style) || /(^|\s)(bold|font-bold)(\s|$)/i.test(cls),
    italic: tag === "EM" || tag === "I" || /font-style\s*:\s*italic/i.test(style) || /(^|\s)(italic|font-italic)(\s|$)/i.test(cls),
  };
}

function richText(node, state) {
  const face = state || { bold: false, italic: false };
  if (!node) return "";
  if (node.nodeType === 3) return node.nodeValue || "";
  if (node.nodeType !== 1) return "";
  const tag = node.tagName;
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "SVG") return "";
  if (tag === "BR") return " ";
  const nextFace = faceOf(node);
  const next = { bold: face.bold || nextFace.bold, italic: face.italic || nextFace.italic };
  let out = "";
  for (const child of node.childNodes) out += richText(child, next);
  if (!plainOf(out).trim()) return out;
  if (!face.bold && next.bold) out = BOLD_ON + out + BOLD_OFF;
  if (!face.italic && next.italic) out = ITALIC_ON + out + ITALIC_OFF;
  return out;
}

function headingText(value) {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  const text = plainOf(raw);
  if (text.length < 2 || text.length > 80) return "";
  if (/^_+$/.test(text) || /^fig(?:ure)?\.?\s*\d+/i.test(text)) return "";
  return raw;
}

function pushText(blocks, paragraphs, value, heading) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const plain = plainOf(text);
  const marked = text.includes(BOLD_ON) || text.includes(ITALIC_ON);
  if (plain.length < 2 || (!heading && !marked && plain.length < 20)) return;
  if (/^(learn more|subscribe|sign up|share this|advertisement|cookie settings)$/i.test(plain)) return;
  if (heading) {
    const title = headingText(text);
    if (title) {
      const last = blocks[blocks.length - 1];
      if (last && last.heading === title) return;
      blocks.push({ heading: title });
      paragraphs.push(title);
      return;
    }
  }
  const line = text.slice(0, 5000);
  if (paragraphs[paragraphs.length - 1] === line) return;
  blocks.push(line);
  paragraphs.push(line);
}

function pushQuote(blocks, paragraphs, value) {
  const text = String(value || "")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5000);
  if (text.length < 2) return;
  const same = (other) => {
    const norm = (item) =>
      String(item || "")
        .replace(/[\u200b-\u200d\ufeff\u00a0\uE000-\uE003]/g, " ")
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    const left = norm(text);
    const right = norm(other);
    if (!left || !right) return false;
    if (left === right) return true;
    const shorter = left.length < right.length ? left : right;
    const longer = left.length < right.length ? right : left;
    return longer.includes(shorter) && shorter.length / longer.length > 0.92;
  };
  const last = blocks[blocks.length - 1];
  if (last && last.quote && same(last.quote)) return;
  if (typeof last === "string" && same(last)) {
    blocks.pop();
    if (same(paragraphs[paragraphs.length - 1])) paragraphs.pop();
  }
  blocks.push({ quote: text });
  paragraphs.push(text);
}

function visitMixed(node, pageUrl, blocks, paragraphs) {
  let buffer = "";
  const flush = () => {
    const text = buffer.replace(/\s+/g, " ").trim();
    buffer = "";
    if (text) pushText(blocks, paragraphs, text, false);
  };
  for (const child of node.childNodes) {
    if (child.nodeType === 1 && child.tagName === "BLOCKQUOTE") {
      flush();
      pushQuote(blocks, paragraphs, richText(child));
      continue;
    }
    if (child.nodeType === 1 && child.tagName === "BR") {
      buffer += " ";
      continue;
    }
    if (child.nodeType === 1 && child.querySelector && child.querySelector("blockquote")) {
      flush();
      visitMixed(child, pageUrl, blocks, paragraphs);
      continue;
    }
    buffer += richText(child);
  }
  flush();
}

function pushImage(blocks, node, pageUrl) {
  const image = imageFrom(node, pageUrl);
  if (!image) return;
  if (blocks.some((block) => block && block.image === image.image)) return;
  blocks.push(image);
}

function listNumber(node) {
  const parent = node.parentElement;
  if (!parent || (parent.tagName !== "OL" && parent.tagName !== "UL")) return 0;
  const items = [...parent.children].filter((child) => child.tagName === "LI");
  const index = items.indexOf(node);
  if (index < 0) return 0;
  if (parent.tagName === "UL") return index + 1;
  const start = Number(parent.getAttribute("start"));
  const base = Number.isFinite(start) && start !== 0 ? start : 1;
  const value = Number(node.getAttribute("value"));
  if (Number.isFinite(value) && value !== 0) return value;
  return base + index;
}

function numberListItem(blocks, paragraphs, before, number) {
  if (!number) return;
  const block = blocks[before];
  if (typeof block !== "string") return;
  const text = number + ". " + block.replace(/^(?:\d+[\.\)]\s+|[\u2022\-]\s+)/, "");
  blocks[before] = text;
  const at = paragraphs.lastIndexOf(block);
  if (at >= 0) paragraphs[at] = text;
}

function visitPiece(node, pageUrl, blocks, paragraphs) {
  if (!node || node.nodeType !== 1) return;
  if (blocks.length >= 240 || paragraphs.length >= 200) return;
  const tag = node.tagName;
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "SVG" || tag === "H1") return;
  if (tag === "IMG") return pushImage(blocks, node, pageUrl);
  if (tag === "H2" || tag === "H3" || tag === "H4") return pushText(blocks, paragraphs, richText(node), true);
  if (tag === "BLOCKQUOTE") return pushQuote(blocks, paragraphs, richText(node));
  if (tag === "LI") {
    const before = blocks.length;
    for (const child of node.childNodes) visitPiece(child, pageUrl, blocks, paragraphs);
    if (blocks.length === before) {
      const text = richText(node).replace(/^(?:\d+[\.\)]\s+|[\u2022\-]\s+)/, "");
      pushText(blocks, paragraphs, text, false);
    }
    numberListItem(blocks, paragraphs, before, listNumber(node));
    return;
  }
  if (tag === "P" && node.querySelector("blockquote")) {
    return visitMixed(node, pageUrl, blocks, paragraphs);
  }
  if (tag === "P" || tag === "FIGCAPTION") {
    if (node.querySelector("p, li, h2, h3, h4, img, figure")) {
      for (const child of node.childNodes) visitPiece(child, pageUrl, blocks, paragraphs);
      return;
    }
    return pushText(blocks, paragraphs, richText(node), false);
  }
  for (const child of node.childNodes) visitPiece(child, pageUrl, blocks, paragraphs);
}

let readerPromise;

function reader() {
  if (!readerPromise) {
    readerPromise = Promise.all([import("linkedom"), import("@mozilla/readability")]).then(([dom, readability]) => {
      const Readability = readability.Readability || (readability.default && readability.default.Readability) || readability.default;
      return { parseHTML: dom.parseHTML, Readability };
    });
  }
  return readerPromise;
}

function blocksFrom(html, pageUrl, parseHTML) {
  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  document.body.innerHTML = html;
  const blocks = [];
  const paragraphs = [];
  visitPiece(document.body, pageUrl, blocks, paragraphs);
  return { blocks, paragraphs: paragraphs.slice(0, 200) };
}

function titleFrom(raw, site) {
  let title = cleanText(raw, 180);
  if (site) {
    const suffix = site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    title = title.replace(new RegExp(`\\s+[\u2014\u2013|\\-]\\s+${suffix}\\s*$`, "i"), "");
    title = title.replace(new RegExp(`\\s+by\\s+${suffix}\\s*$`, "i"), "");
  }
  return cleanText(title, 180);
}

function blockedPage(res, html) {
  const head = String(html || "").slice(0, 5000);
  if (/cf-mitigated|challenges\.cloudflare\.com|Just a moment/i.test(head)) return true;
  return !res || !res.ok;
}

async function fetchPage(target, timeout = 12000) {
  const res = await fetch(target, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeout),
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
    },
  });
  const html = await res.text();
  return { res, html, url: res.url || target };
}

function readablePage(page) {
  if (!page || blockedPage(page.res, page.html)) return false;
  const html = String(page.html || "");
  return html.length > 800 && html.length <= 1500000;
}

async function snapshotStamps(target) {
  const endpoint =
    "https://web.archive.org/cdx/search/cdx?url=" +
    encodeURIComponent(target) +
    "&output=json&fl=timestamp,statuscode&filter=statuscode:200&limit=-4";
  const res = await fetch(endpoint, {
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
    headers: { accept: "application/json", "user-agent": "Mozilla/5.0" },
  });
  if (!res.ok) return [];
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];
  return rows
    .slice(1)
    .map((row) => (Array.isArray(row) ? row[0] : ""))
    .filter(Boolean)
    .reverse();
}

async function archivedPage(target) {
  const urls = [];
  try {
    const stamps = await snapshotStamps(target);
    if (stamps[0]) urls.push("https://web.archive.org/web/" + stamps[0] + "/" + target);
  } catch {
    /* a dated copy can still open */
  }
  urls.push("https://web.archive.org/web/2024/" + target);
  urls.push("https://web.archive.org/web/2/" + target);
  const seen = new Set();
  let tries = 0;
  for (const url of urls) {
    if (seen.has(url) || tries >= 3) continue;
    seen.add(url);
    tries += 1;
    try {
      const page = await fetchPage(url, 8000);
      if (readablePage(page)) return { ...page, url: target };
    } catch {
      /* the next copy */
    }
  }
  return null;
}

async function relayedPage(target) {
  const res = await fetch("https://r.jina.ai/" + target, {
    redirect: "follow",
    signal: AbortSignal.timeout(12000),
    headers: {
      accept: "text/html",
      "x-return-format": "html",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    },
  });
  const html = await res.text();
  const page = { res, html, url: target };
  if (!readablePage(page)) return null;
  return page;
}

async function readPage(target) {
  let page = null;
  try {
    page = await fetchPage(target);
  } catch {
    page = null;
  }
  if (!readablePage(page)) page = await archivedPage(target);
  if (!readablePage(page)) page = await relayedPage(target);
  if (!page || !readablePage(page)) fail(400, "That page didn't open.");
  const type = String(page.res.headers.get("content-type") || "");
  if (page.html.length > 1500000) fail(413, "That page is too large to read.");
  if (!/html|xml/i.test(type) && !/<\s*(html|body|article|p|div)\b/i.test(page.html.slice(0, 4000))) {
    fail(400, "That link isn't a page.");
  }
  return { html: page.html, url: page.url || target };
}

function poemLine(value) {
  const text = String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\s+$/g, "");
  if (!text.trim()) return "";
  return text.replace(/^ +| {2,}/g, (gap) => "\u00a0".repeat(gap.length));
}

function poemFrom(document) {
  const root = document.querySelector(".poem-body, .type-poem-text");
  if (!root) return null;
  const rows = [...root.children].filter((node) => node.tagName === "DIV" || node.tagName === "P");
  const nodes = rows.length ? rows : [root];
  const lines = nodes.map((node) => poemLine(node.textContent));
  const prose = lines.join("").replace(/\u00a0/g, "").trim();
  if (prose.length < 40) return null;
  return lines;
}

async function parsePiece(html, pageUrl) {
  const { parseHTML, Readability } = await reader();
  let document;
  try {
    document = parseHTML(html).document;
  } catch {
    fail(400, "That page didn't give up a piece.");
  }
  const hero = firstImage(document, pageUrl);
  for (const node of document.querySelectorAll(".quote, .pullquote, .wp-block-quote")) {
    if (node.tagName === "BLOCKQUOTE") continue;
    const quote = document.createElement("blockquote");
    quote.textContent = node.textContent;
    if (node.parentNode) node.parentNode.replaceChild(quote, node);
  }
  const metaAuthor = cleanText(metaContent(document, 'meta[name="author"]'), 120);
  const siteName = cleanText(metaContent(document, 'meta[property="og:site_name"]'), 120);
  const poem = poemFrom(document);
  if (poem) {
    const site = siteName || hostnameOf(pageUrl);
    const title = titleFrom(metaContent(document, 'meta[property="og:title"]') || document.querySelector("h1")?.textContent, site);
    const poet = document.querySelector('a[href*="/poets/"]');
    const author = cleanText((poet && poet.textContent) || metaAuthor, 120);
    if (!title) fail(400, "That page didn't give up a piece.");
    const blocks = poem.map((line) => ({ poem: line }));
    return { title, author, site, paragraphs: poem.map((line) => line || " "), blocks };
  }
  let article = null;
  try {
    article = new Readability(document).parse();
  } catch {
    article = null;
  }
  if (!article || !article.content) fail(400, "That page didn't give up a piece.");
  const piece = blocksFrom(article.content, pageUrl, parseHTML);
  if (hero && !piece.blocks.some((block) => block && block.image === hero.image)) piece.blocks.unshift(hero);
  const site = cleanText(article.siteName, 120) || siteName || hostnameOf(pageUrl);
  const title = titleFrom(article.title, site);
  const author = cleanText(String(article.byline || metaAuthor).replace(/^by\s+/i, ""), 120);
  piece.blocks = piece.blocks.filter((block) => !spareImage(block, author));
  const prose = piece.blocks.filter((block) => typeof block === "string" && block.length > 40);
  const proseChars = prose.reduce((sum, block) => sum + block.length, 0);
  if (!title || proseChars < 280 || (prose.length < 2 && proseChars < 400)) fail(400, "That page didn't give up a piece.");
  return { title, author, site, paragraphs: piece.paragraphs, blocks: piece.blocks };
}

async function saveArticle(library, body) {
  const url = cleanUrl(body.url);
  if (!url) fail(400, "Paste a link.");
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    fail(400, "That link doesn't open.");
  }
  if (!openable(parsedUrl)) fail(400, "That link doesn't open.");
  const existing = library.articles.find((article) => article.url === url);
  if (existing) return { article: existing, duplicate: true };
  const page = await readPage(url);
  const finalUrl = cleanUrl(page.url) || url;
  const again = library.articles.find((article) => article.url === finalUrl);
  if (again) return { article: again, duplicate: true };
  const parsed = await parsePiece(page.html, finalUrl);
  const article = {
    id: uid(),
    title: parsed.title,
    author: parsed.author,
    site: parsed.site,
    url: finalUrl,
    savedAt: today(),
    folder: "",
    tags: suggestTags({
      title: parsed.title,
      author: parsed.author,
      site: parsed.site,
      paragraphs: parsed.paragraphs,
      blocks: parsed.blocks,
    }),
    paragraphs: parsed.paragraphs,
    blocks: parsed.blocks,
  };
  const sampleIds = new Set(library.articles.filter((item) => item.sample).map((item) => item.id));
  library.articles = library.articles.filter((item) => !item.sample);
  library.quotes = library.quotes.filter((quote) => !sampleIds.has(quote.articleId));
  library.articles.unshift(article);
  return { article };
}

function passageOf(article) {
  const source = Array.isArray(article.blocks) && article.blocks.length ? article.blocks : article.paragraphs;
  const parts = [];
  const plain = (value) => String(value || "").replace(/[\uE000-\uE003]/g, "").trim();
  for (const block of source || []) {
    if (typeof block === "string" && plain(block)) parts.push(plain(block));
    else if (block && block.heading) parts.push(plain(block.heading));
    else if (block && block.quote) parts.push(plain(block.quote));
    else if (block && typeof block.poem === "string") parts.push(plain(block.poem));
  }
  return parts.join(" ");
}

function keepQuote(library, body) {
  const article = findArticle(library, body.articleId);
  const text = cleanText(body.text, 8000);
  if (text.length < 2 || !/[A-Za-z0-9]/.test(text)) fail(400, "Select a passage to highlight.");
  if (!passageOf(article).includes(text)) fail(400, "That passage isn't in the piece.");
  const existing = library.quotes.find((quote) => quote.articleId === article.id && quote.text === text);
  if (existing) return { quote: existing, duplicate: true };
  const quote = {
    id: uid(),
    articleId: article.id,
    text,
    at: new Date().toISOString(),
    ink: cleanInk(body.ink) || "yellow",
  };
  const book = folderFrom(article.folder);
  if (book) quote.book = book;
  library.quotes.unshift(quote);
  return { quote };
}

function tintQuote(library, body) {
  const id = cleanId(body.id);
  const ink = cleanInk(body.ink);
  if (!ink) fail(400, "Choose a color.");
  const quote = library.quotes.find((item) => item.id === id);
  if (!quote) fail(400, "That line isn't on the shelf.");
  if (quote.ink === ink) return { quote, duplicate: true };
  quote.ink = ink;
  return { quote };
}

function letGo(library, body) {
  const id = cleanId(body.id);
  const before = library.quotes.length;
  library.quotes = library.quotes.filter((quote) => quote.id !== id);
  if (library.quotes.length === before) fail(400, "That line isn't on the shelf.");
  return { removedQuote: id };
}

function setTag(library, body, add) {
  const article = findArticle(library, body.articleId);
  const tag = tagsFrom(body.tag)[0];
  if (!tag) fail(400, "The tag is empty.");
  if (add) {
    if (!article.tags.includes(tag) && article.tags.length >= 8) fail(400, "That's enough tags for one piece.");
    if (!article.tags.includes(tag)) article.tags.push(tag);
  } else {
    article.tags = article.tags.filter((item) => item !== tag);
  }
  return { article };
}

function fileArticle(library, body) {
  const article = findArticle(library, body.articleId);
  const folder = folderFrom(body.folder);
  if (!folder) fail(400, "Choose a folder.");
  const known = library.articles.some((item) => item.folder === folder);
  if (!known) fail(400, "That folder isn't on the shelf.");
  if (article.folder === folder) return { article, duplicate: true };
  article.folder = folder;
  return { article };
}

function removeArticle(library, body) {
  const id = cleanId(body.articleId);
  const before = library.articles.length;
  library.articles = library.articles.filter((article) => article.id !== id);
  if (library.articles.length === before) fail(400, "That piece isn't on the shelf.");
  library.quotes = library.quotes.filter((quote) => quote.articleId !== id);
  return { removedArticle: id };
}

function apply(library, body) {
  const kind = body && body.kind;
  if (kind === "save") return saveArticle(library, body);
  if (kind === "keep") return keepQuote(library, body);
  if (kind === "ink") return tintQuote(library, body);
  if (kind === "let-go") return letGo(library, body);
  if (kind === "tag") return setTag(library, body, true);
  if (kind === "untag") return setTag(library, body, false);
  if (kind === "file") return fileArticle(library, body);
  if (kind === "remove") return removeArticle(library, body);
  fail(400, "That doesn't fit on the shelf.");
}

const mailed = new Map();
let mailWindow = { start: 0, count: 0 };

function mailLimited(ip) {
  const row = mailed.get(ip);
  if (!row) return false;
  if (Date.now() - row.start > 15 * 60 * 1000) {
    mailed.delete(ip);
    return false;
  }
  return row.count >= 3;
}

function markMail(ip) {
  const now = Date.now();
  const row = mailed.get(ip) || { count: 0, start: now };
  if (now - row.start > 15 * 60 * 1000) {
    row.count = 0;
    row.start = now;
  }
  row.count += 1;
  mailed.set(ip, row);
  if (mailed.size > 500) mailed.delete(mailed.keys().next().value);
  if (now - mailWindow.start > 60 * 60 * 1000) mailWindow = { start: now, count: 0 };
  mailWindow.count += 1;
}

function mailFlooded() {
  if (Date.now() - mailWindow.start > 60 * 60 * 1000) return false;
  return mailWindow.count >= 6;
}

async function requestCode(req, res) {
  const ip = clientIp(req);
  if (tooMany(ip) || mailLimited(ip) || mailFlooded()) fail(429, "Too many tries. Wait a little.");
  if (!mailReady()) fail(503, "The code couldn't be sent. Use the key for now.", true);
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const sent = await sendCode(code);
  if (!sent) fail(503, "The code couldn't be sent. Use the key for now.", true);
  markMail(ip);
  writeCookies(res, req, [{ name: "bookmark_step", value: issueStep(code), maxAge: 600 }]);
  return send(res, 200, { ok: true, step: "code" });
}

async function unlock(req, res, body) {
  const key = password();
  if (!key) return send(res, 200, { ok: true });
  const ip = clientIp(req);
  if (tooMany(ip)) fail(429, "Too many tries. Wait a little.");
  if (body && body.mail) return requestCode(req, res);
  if (!passwordMatches(body && body.password)) {
    markFail(ip);
    fail(401, "That isn't the key.");
  }
  markOk(ip);
  if (mailReady()) return requestCode(req, res);
  writeCookies(res, req, [{ name: "bookmark", value: sessionToken(), maxAge: SESSION_SECONDS }]);
  return send(res, 200, { ok: true });
}

function confirmCode(req, res, body) {
  if (!password() || !mailReady()) fail(400, "That doesn't fit on the shelf.");
  const ip = clientIp(req);
  if (tooMany(ip)) fail(429, "Too many tries. Wait a little.");
  const step = readStep(cookieValue(req, "bookmark_step"));
  const given = String((body && body.code) || "").replace(/\D/g, "");
  const hash = crypto.createHash("sha256").update(given).digest("base64url");
  const match = step && /^\d{6}$/.test(given) && safeEqual(hash, step.hash);
  if (!match) {
    markFail(ip);
    if (step && step.tries < 4) {
      const payload = `1.${step.exp}.${step.hash}.${step.tries + 1}`;
      const left = Math.max(1, step.exp - Math.floor(Date.now() / 1000));
      writeCookies(res, req, [{ name: "bookmark_step", value: `${payload}.${sign(payload)}`, maxAge: left }]);
    } else {
      writeCookies(res, req, [{ name: "bookmark_step", value: "", maxAge: 0 }]);
    }
    fail(401, step && step.tries >= 4 ? "That code expired. Start again." : "That code didn't match.");
  }
  markOk(ip);
  writeCookies(res, req, [
    { name: "bookmark", value: sessionToken(), maxAge: SESSION_SECONDS },
    { name: "bookmark_step", value: "", maxAge: 0 },
  ]);
  return send(res, 200, { ok: true });
}

function logout(req, res) {
  const token = cookieValue(req, "bookmark");
  if (token) {
    revoked.add(token);
    if (revoked.size > 200) revoked.delete(revoked.values().next().value);
  }
  writeCookies(res, req, [
    { name: "bookmark", value: "", maxAge: 0 },
    { name: "bookmark_step", value: "", maxAge: 0 },
  ]);
  return send(res, 200, { ok: true, locked: true });
}

async function handler(req, res) {
  try {
    if (req.method === "GET") {
      if (!allowed(req)) return send(res, 401, { locked: true });
      const library = await readLibrary(tokenFrom(req));
      const url = new URL(req.url || "/", "http://bookmark.local");
      const articleId = cleanId(url.searchParams.get("article"));
      if (articleId) {
        const article = library.articles.find((item) => item.id === articleId);
        if (!article) fail(404, "That piece isn't on the shelf.");
        return send(res, 200, {
          article: {
            ...shelfArticle(article),
            paragraphs: article.paragraphs || [],
            blocks: article.blocks || [],
          },
        });
      }
      if (url.searchParams.get("quotes") === "1") {
        const ids = new Set((library.quotes || []).map((quote) => quote.articleId));
        const articles = (library.articles || []).filter((article) => ids.has(article.id)).map(shelfArticle);
        return send(res, 200, { quotes: library.quotes || [], articles, sealed: Boolean(password()) });
      }
      const query = String(url.searchParams.get("q") || "").trim();
      if (query) return send(res, 200, searchLibrary(library, query));
      const also = String(url.searchParams.get("also") || "")
        .split(",")
        .map((id) => cleanId(id))
        .filter(Boolean)
        .slice(0, 12);
      return send(res, 200, shelfPage(library, {
        from: url.searchParams.get("from"),
        limit: url.searchParams.get("limit"),
        folder: String(url.searchParams.get("folder") || "").slice(0, 40),
        topic: String(url.searchParams.get("topic") || "").slice(0, 32),
        also,
      }));
    }
    if (req.method !== "POST") return send(res, 405, { error: "That doesn't fit on the shelf." });
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      if (error.status) throw error;
      fail(400, "That doesn't fit on the shelf.");
    }
    if (body && body.kind === "logout") return logout(req, res);
    if (body && body.kind === "unlock") return await unlock(req, res, body);
    if (body && body.kind === "code") return confirmCode(req, res, body);
    if (!allowed(req)) return send(res, 401, { locked: true });
    const token = tokenFrom(req);
    const library = await readLibrary(token);
    const result = await apply(library, body || {});
    if (!result || !result.duplicate) await writeLibrary(library, token);
    return send(res, 200, { ok: true, sealed: Boolean(password()), ...result });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error("bookmark", error && error.message);
    const message = status >= 500 && !error.expose ? "The shelf can't be saved just now." : error.message || "The shelf didn't answer.";
    return send(res, status, { error: message });
  }
}

module.exports = handler;
handler.suggestTags = suggestTags;
handler.parsePiece = parsePiece;
handler.readPage = readPage;
handler.dropSavedMarks = dropSavedMarks;
