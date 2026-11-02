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

function fail(status, error) {
  const err = new Error(error);
  err.status = status;
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
  return Boolean(String(process.env.RESEND_API_KEY || "").trim());
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
  if (!key) return false;
  const from = String(process.env.BOOKMARK_FROM || "Bookmark <bookmark@erica-hu.com>").trim();
  const to = String(process.env.BOOKMARK_EMAIL || "ericahu801@gmail.com").trim();
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
  const auth = {};
  const storeId = String(process.env.BLOB_STORE_ID || "").trim();
  if (token) auth.oidcToken = token;
  if (storeId) auth.storeId = storeId;
  return auth;
}

function useBlob(token) {
  return Boolean(process.env.VERCEL || process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID || token);
}

async function blobRead(token) {
  const { get } = require("@vercel/blob");
  const auth = blobAuth(token);
  let result;
  try {
    result = await get(BLOB_PATH, { access: "private", useCache: false, ...auth });
  } catch {
    result = await get(BLOB_PATH, { access: "public", useCache: false, ...auth });
  }
  if (!result || result.statusCode === 304 || !result.stream) return null;
  const text = await new Response(result.stream).text();
  return normalize(JSON.parse(text));
}

async function blobWrite(body, token) {
  const { put } = require("@vercel/blob");
  const auth = blobAuth(token);
  const options = {
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 60,
    ...auth,
  };
  try {
    await put(BLOB_PATH, body, { access: "private", ...options });
  } catch {
    await put(BLOB_PATH, body, { access: "public", ...options });
  }
}

async function readLibrary(token) {
  if (useBlob(token)) {
    try {
      const data = await blobRead(token);
      if (data) return data;
    } catch (error) {
      console.error("bookmark read", error && error.message);
    }
  }
  try {
    const text = await fs.readFile(FILE, "utf8");
    return normalize(JSON.parse(text));
  } catch (error) {
    if (!error || error.code !== "ENOENT") console.error("bookmark file", error && error.message);
    return seed();
  }
}

async function writeLibrary(library, token) {
  const body = JSON.stringify(library, null, 2) + "\n";
  if (useBlob(token)) {
    await blobWrite(body, token);
    return;
  }
  await fs.writeFile(FILE, body);
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

function decorativeImage(src, alt) {
  const name = String(src || "").toLowerCase();
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
  const nodes = document.querySelectorAll("img");
  for (const node of nodes) {
    if (node.closest("nav, header, footer")) continue;
    const image = imageFrom(node, pageUrl);
    if (image && image.alt.length >= 8) return image;
  }
  return null;
}

function headingText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length < 2 || text.length > 80) return "";
  if (/^_+$/.test(text) || /^fig(?:ure)?\.?\s*\d+/i.test(text)) return "";
  return text;
}

function pushText(blocks, paragraphs, value, heading) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length < 2 || (!heading && text.length < 20)) return;
  if (/^(learn more|subscribe|sign up|share this|advertisement|cookie settings)$/i.test(text)) return;
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
        .replace(/[\u200b-\u200d\ufeff\u00a0]/g, " ")
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
      pushQuote(blocks, paragraphs, child.textContent);
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
    buffer += child.textContent || "";
  }
  flush();
}

function pushImage(blocks, node, pageUrl) {
  const image = imageFrom(node, pageUrl);
  if (!image) return;
  if (blocks.some((block) => block && block.image === image.image)) return;
  blocks.push(image);
}

function visitPiece(node, pageUrl, blocks, paragraphs) {
  if (!node || node.nodeType !== 1) return;
  if (blocks.length >= 240 || paragraphs.length >= 200) return;
  const tag = node.tagName;
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "SVG" || tag === "H1") return;
  if (tag === "IMG") return pushImage(blocks, node, pageUrl);
  if (tag === "H2" || tag === "H3" || tag === "H4") return pushText(blocks, paragraphs, node.textContent, true);
  if (tag === "BLOCKQUOTE") return pushQuote(blocks, paragraphs, node.textContent);
  if ((tag === "P" || tag === "LI") && node.querySelector("blockquote")) {
    return visitMixed(node, pageUrl, blocks, paragraphs);
  }
  if (tag === "P" || tag === "LI" || tag === "FIGCAPTION") {
    if (node.querySelector("p, li, h2, h3, h4, img, figure")) {
      for (const child of node.childNodes) visitPiece(child, pageUrl, blocks, paragraphs);
      return;
    }
    let text = node.textContent;
    if (tag === "LI") text = String(text).replace(/^[\u2022\-\d\.\)\s]+/, "");
    return pushText(blocks, paragraphs, text, false);
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

async function readPage(target) {
  let res;
  try {
    res = await fetch(target, {
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
    });
  } catch {
    fail(400, "That page didn't open.");
  }
  if (!res.ok) fail(400, "That page didn't open.");
  const type = String(res.headers.get("content-type") || "");
  const html = await res.text();
  if (html.length > 1500000) fail(413, "That page is too large to read.");
  if (!/html|xml/i.test(type) && !/<\s*(html|body|article|p|div)\b/i.test(html.slice(0, 4000))) {
    fail(400, "That link isn't a page.");
  }
  return { html, url: res.url || target };
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
  for (const block of source || []) {
    if (typeof block === "string" && block.trim()) parts.push(block.trim());
    else if (block && block.heading) parts.push(String(block.heading).trim());
    else if (block && block.quote) parts.push(String(block.quote).trim());
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
  return {};
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
  return {};
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

async function unlock(req, res, body) {
  const key = password();
  if (!key) return send(res, 200, { ok: true });
  const ip = clientIp(req);
  if (tooMany(ip)) fail(429, "Too many tries. Wait a little.");
  if (!passwordMatches(body && body.password)) {
    markFail(ip);
    fail(401, "That isn't the key.");
  }
  markOk(ip);
  if (mailReady()) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const sent = await sendCode(code);
    if (!sent) fail(503, "The code couldn't be sent. Try again in a moment.");
    writeCookies(res, req, [{ name: "bookmark_step", value: issueStep(code), maxAge: 600 }]);
    return send(res, 200, { ok: true, step: "code" });
  }
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
      return send(res, 200, { ...library, sealed: Boolean(password()) });
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
    return send(res, 200, { ok: true, articles: library.articles, quotes: library.quotes, ...result });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error("bookmark", error && error.message);
    const message = status >= 500 ? "The shelf can't be saved just now." : error.message || "The shelf didn't answer.";
    return send(res, status, { error: message });
  }
}

module.exports = handler;
handler.suggestTags = suggestTags;
handler.parsePiece = parsePiece;
