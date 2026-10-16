const PATH = "casa/board.json";
const PALETTE = ["#8f3b28", "#243044", "#3e5c45", "#a36b2d", "#6d3a55", "#3f4f6b", "#7a4e2d"];
const MAX_NOTES = 40;
const MAX_BOOKS = 24;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_POSTS = 5;

const recent = new Map();

function empty() {
  return { notes: [], books: [] };
}

function clean(value, max) {
  return String(value || "")
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

function clientKey(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded || req.socket?.remoteAddress || "";
  return String(raw).split(",")[0].trim() || "unknown";
}

function limited(key) {
  const now = Date.now();
  const stamps = (recent.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (stamps.length >= MAX_POSTS) {
    recent.set(key, stamps);
    return true;
  }
  stamps.push(now);
  recent.set(key, stamps);
  return false;
}

function id() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function isBlobUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && url.hostname.endsWith(".blob.vercel-storage.com");
  } catch {
    return false;
  }
}

function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 6 && (buf.slice(0, 6).toString("ascii") === "GIF87a" || buf.slice(0, 6).toString("ascii") === "GIF89a")) {
    return "image/gif";
  }
  if (buf.length >= 12 && buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return "";
}

function readImage(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return false;
  const match = value.match(/^data:image\/(?:jpeg|jpg|png|webp|gif);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return false;
  const buf = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
  if (!buf.length || buf.length > 1200000) return false;
  const type = sniffImage(buf);
  if (!type) return false;
  return { buf, type };
}

function cleanLink(value) {
  const raw = clean(value, 200);
  if (!raw) return "";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (!url.hostname || !url.hostname.includes(".")) return "";
    return url.href;
  } catch {
    return "";
  }
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
    if (raw.length > 2500000) {
      const error = new Error("large");
      error.status = 413;
      throw error;
    }
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  }
  return raw;
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

async function blobRead(token) {
  const { get } = require("@vercel/blob");
  const auth = blobAuth(token);
  let result;
  try {
    result = await get(PATH, { access: "private", useCache: false, ...auth });
  } catch (error) {
    result = await get(PATH, { access: "public", useCache: false, ...auth });
  }
  if (!result || result.statusCode === 304 || !result.stream) return empty();
  const text = await new Response(result.stream).text();
  try {
    const data = JSON.parse(text);
    return {
      notes: Array.isArray(data.notes) ? data.notes : [],
      books: Array.isArray(data.books) ? data.books : [],
    };
  } catch {
    return empty();
  }
}

async function blobWrite(data, token) {
  const { put } = require("@vercel/blob");
  const auth = blobAuth(token);
  const body = JSON.stringify(data);
  try {
    await put(PATH, body, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      cacheControlMaxAge: 60,
      ...auth,
    });
  } catch (error) {
    await put(PATH, body, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      cacheControlMaxAge: 60,
      ...auth,
    });
  }
}

async function blobStoreImage(noteId, image, token) {
  const { put } = require("@vercel/blob");
  const ext = image.type.split("/")[1] === "jpeg" ? "jpg" : image.type.split("/")[1];
  const saved = await put(`casa/notes/${noteId}.${ext}`, image.buf, {
    access: "public",
    addRandomSuffix: true,
    contentType: image.type,
    ...blobAuth(token),
  });
  if (!saved || !isBlobUrl(saved.url)) throw new Error("store");
  return saved.url;
}

async function blobForgetImages(notes, token) {
  const urls = notes.map((note) => note.image).filter(isBlobUrl);
  if (!urls.length) return;
  const { del } = require("@vercel/blob");
  await del(urls, blobAuth(token));
}

function createHandler({ readBoard, writeBoard, storeImage, forgetImages }) {
  return async function handler(req, res) {
    const token = tokenFrom(req);
    if (req.method === "GET") {
      try {
        const board = await readBoard(token);
        send(res, 200, { notes: board.notes, books: board.books, ready: true });
      } catch (error) {
        console.error("board read", error && error.message);
        send(res, 200, { notes: [], books: [], ready: false });
      }
      return;
    }

    if (req.method !== "POST") {
      send(res, 405, { error: "That does not go on the board." });
      return;
    }

    let body;
    try {
      body = await readJson(req);
    } catch {
      send(res, 400, { error: "That one doesn't fit." });
      return;
    }

    if (body && clean(body.company, 80)) {
      send(res, 200, { ok: true });
      return;
    }

    if (limited(clientKey(req))) {
      send(res, 429, { error: "That's plenty for a minute." });
      return;
    }

    let board;
    try {
      board = await readBoard(token);
    } catch (error) {
      console.error("board read", error && error.message);
      send(res, 503, { error: "Not just now." });
      return;
    }

    const kind = body && body.kind;

    if (kind === "note") {
      const text = clean(body.text, 240);
      const name = clean(body.name, 32);
      const linkRaw = clean(body.link, 200);
      const image = readImage(body.image);
      if (image === false) {
        send(res, 400, { error: "That picture doesn't open." });
        return;
      }
      if (!text && !image) {
        send(res, 400, { error: "The note is empty." });
        return;
      }
      const link = linkRaw ? cleanLink(linkRaw) : "";
      if (linkRaw && !link) {
        send(res, 400, { error: "That link doesn't open." });
        return;
      }
      const duplicate = text && board.notes.some((note) => clean(note.text, 240).toLowerCase() === text.toLowerCase());
      if (duplicate) {
        send(res, 400, { error: "That's already on the board." });
        return;
      }
      const note = { id: id(), name, text, at: new Date().toISOString() };
      if (link) note.link = link;
      if (image) {
        try {
          note.image = await storeImage(note.id, image, token);
        } catch (error) {
          console.error("board image", error && error.message);
          send(res, 503, { error: "Not just now." });
          return;
        }
      }
      board.notes.unshift(note);
      const dropped = board.notes.slice(MAX_NOTES);
      board.notes = board.notes.slice(0, MAX_NOTES);
      try {
        await writeBoard(board, token);
      } catch (error) {
        console.error("board write", error && error.message);
        send(res, 503, { error: "Not just now." });
        return;
      }
      if (dropped.length && forgetImages) {
        try {
          await forgetImages(dropped, token);
        } catch {}
      }
      send(res, 200, { ok: true, notes: board.notes, books: board.books });
      return;
    } else if (kind === "book") {
      const title = clean(body.title, 80);
      const author = clean(body.author, 60);
      if (title.length < 1) {
        send(res, 400, { error: "The book needs a title." });
        return;
      }
      const duplicate = board.books.some((book) => clean(book.title, 80).toLowerCase() === title.toLowerCase());
      if (duplicate) {
        send(res, 400, { error: "That book is already on the shelf." });
        return;
      }
      board.books.push({
        id: id(),
        title,
        author,
        hue: PALETTE[board.books.length % PALETTE.length],
        at: new Date().toISOString(),
      });
      board.books = board.books.slice(-MAX_BOOKS);
    } else {
      send(res, 400, { error: "That one doesn't fit." });
      return;
    }

    try {
      await writeBoard(board, token);
    } catch (error) {
      console.error("board write", error && error.message);
      send(res, 503, { error: "Not just now." });
      return;
    }

    send(res, 200, { ok: true, notes: board.notes, books: board.books });
  };
}

module.exports = createHandler({
  readBoard: blobRead,
  writeBoard: blobWrite,
  storeImage: blobStoreImage,
  forgetImages: blobForgetImages,
});
module.exports.createHandler = createHandler;
