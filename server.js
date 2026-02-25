require("dotenv").config();

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const PRIVATE_DIR = path.join(ROOT_DIR, "private");
const PLAYLIST_PATH = path.join(ROOT_DIR, "xtream_playlist.m3u");
const UPSTREAM_TIMEOUT_MS = 5000;
const STREAM_LOCK_TTL_MS = 15000;
const MAX_CONCURRENT_STREAMS_PER_USER = 2;
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;
const ENFORCE_STREAM_LOCKS = false;
const PROXY_HEADER_ATTEMPTS = 1;
const ADMIN_EMAILS = new Set(["mouhasogue@gmail.com", "methndiaye43@gmail.com"].map((email) => email.toLowerCase()));
const ADMIN_PANEL_PATH = normalizeAdminPanelPath(process.env.ADMIN_PANEL_PATH || "/mktv-admin-ops-7f9a");

const AGENT_OPTIONS = {
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 300,
  maxFreeSockets: 64,
  scheduling: "lifo",
};

const HTTP_AGENT = new http.Agent(AGENT_OPTIONS);
const HTTPS_AGENT = new https.Agent(AGENT_OPTIONS);

const XTREAM_HEADERS = {
  "User-Agent": "Lavf/57.83.100",
  Accept: "*/*",
  "Icy-MetaData": "1",
  "Accept-Encoding": "identity",
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const { supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY } = loadSupabasePublicConfig();
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ACTIVE_STREAMS = new Map();
const TOKEN_CACHE = new Map();

const { channels, groups } = loadPlaylist(PLAYLIST_PATH);
console.log(`Playlist loaded: ${channels.length} channels, ${groups.length} groups`);
if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("SUPABASE_SERVICE_ROLE_KEY is missing: approval workflow is disabled.");
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && requestUrl.pathname === "/api/channels") {
      return handleChannelsApi(req, requestUrl, res);
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/groups") {
      return handleGroupsApi(req, requestUrl, res);
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/public-config") {
      return handlePublicConfig(res);
    }

    if (
      (req.method === "GET" || req.method === "HEAD")
      && (requestUrl.pathname === ADMIN_PANEL_PATH || requestUrl.pathname === `${ADMIN_PANEL_PATH}/`)
    ) {
      return serveAdminPanel(res, req.method === "HEAD");
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/access/status") {
      return handleAccessStatus(req, requestUrl, res);
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/access/pending") {
      return handleAccessPending(req, requestUrl, res);
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/access/approve") {
      return handleAccessApprove(req, requestUrl, res);
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/proxy") {
      return handleProxyApi(req, res, requestUrl);
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/session/release") {
      return handleSessionRelease(req, res);
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendText(res, 405, "Method Not Allowed");
    }

    return serveStatic(requestUrl.pathname, res, req.method === "HEAD");
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: "Internal server error" });
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(PORT, () => {
  console.log(`MKTV web app running at http://localhost:${PORT}`);
  console.log(`Admin panel path: ${ADMIN_PANEL_PATH}`);
});

function parseExtinfLine(line) {
  const payload = line.replace(/^#EXTINF:[^ ]*\s*/, "").trim();
  let commaIndex = -1;
  let inQuotes = false;

  for (let i = 0; i < payload.length; i += 1) {
    const ch = payload[i];
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === "," && !inQuotes) {
      commaIndex = i;
      break;
    }
  }

  const attrsPart = commaIndex >= 0 ? payload.slice(0, commaIndex).trim() : payload;
  const name = commaIndex >= 0 ? payload.slice(commaIndex + 1).trim() : "Unnamed channel";

  const attributes = {};
  const attrRegex = /([\w-]+)="([^"]*)"/g;
  let match;
  while ((match = attrRegex.exec(attrsPart)) !== null) {
    attributes[match[1]] = match[2];
  }

  return {
    id: attributes["tvg-id"] || "",
    logo: attributes["tvg-logo"] || "",
    group: attributes["group-title"] || "Autres",
    name: name || "Unnamed channel",
  };
}

function loadPlaylist(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing playlist file: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const channelList = [];
  const groupMap = new Map();
  let pendingMeta = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF")) {
      pendingMeta = parseExtinfLine(line);
      continue;
    }

    if (line.startsWith("#")) continue;
    if (!pendingMeta) continue;

    const channel = {
      id: pendingMeta.id,
      name: pendingMeta.name,
      logo: pendingMeta.logo,
      group: pendingMeta.group,
      url: line,
    };

    channelList.push(channel);
    groupMap.set(channel.group, (groupMap.get(channel.group) || 0) + 1);
    pendingMeta = null;
  }

  const groupList = Array.from(groupMap.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" }));

  return { channels: channelList, groups: groupList };
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeAdminPanelPath(rawPath) {
  const trimmed = String(rawPath || "").trim();
  if (!trimmed) return "/mktv-admin-ops-7f9a";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

async function handleChannelsApi(req, requestUrl, res) {
  const access = await requireApprovedAccess(req, requestUrl);
  if (!access.ok) return sendJson(res, access.status, { error: access.error, pending: Boolean(access.pending) });

  const params = requestUrl.searchParams;
  const q = (params.get("q") || "").trim().toLowerCase();
  const group = (params.get("group") || "").trim().toLowerCase();
  const offset = clampInt(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = clampInt(params.get("limit"), 200, 1, 1000);

  const filtered = channels.filter((channel) => {
    const groupMatch = !group || channel.group.toLowerCase() === group;
    if (!groupMatch) return false;
    if (!q) return true;
    return channel.name.toLowerCase().includes(q) || channel.group.toLowerCase().includes(q);
  });

  const items = filtered.slice(offset, offset + limit);

  return sendJson(res, 200, {
    total: filtered.length,
    offset,
    limit,
    hasMore: offset + items.length < filtered.length,
    items,
  });
}

async function handleGroupsApi(req, requestUrl, res) {
  const access = await requireApprovedAccess(req, requestUrl);
  if (!access.ok) return sendJson(res, access.status, { error: access.error, pending: Boolean(access.pending) });
  return sendJson(res, 200, { groups });
}

function handlePublicConfig(res) {
  return sendJson(res, 200, {
    supabaseUrl: SUPABASE_URL || "",
    supabaseAnonKey: SUPABASE_ANON_KEY || "",
  });
}

function buildProxyUrl(rawUrl, extraParams = {}) {
  const params = new URLSearchParams({
    url: rawUrl,
  });
  if (extraParams.sid) params.set("sid", extraParams.sid);
  if (extraParams.at) params.set("at", extraParams.at);
  return `/api/proxy?${params.toString()}`;
}

function resolveUri(uri, baseUrl) {
  if (!uri) return null;
  try {
    if (uri.startsWith("//")) return `${baseUrl.protocol}${uri}`;
    return new URL(uri, baseUrl).href;
  } catch {
    return null;
  }
}

function rewriteManifest(manifestText, sourceUrl, extraParams = {}) {
  const baseUrl = new URL(sourceUrl);
  const lines = manifestText.split(/\r?\n/);

  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith("#")) {
      if (trimmed.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/g, (full, uri) => {
          const absoluteUri = resolveUri(uri, baseUrl);
          return absoluteUri ? `URI="${buildProxyUrl(absoluteUri, extraParams)}"` : full;
        });
      }
      return line;
    }

    const absolute = resolveUri(trimmed, baseUrl);
    return absolute ? buildProxyUrl(absolute, extraParams) : line;
  });

  return rewritten.join("\n");
}

function copyHeaderIfPresent(fromHeaders, toRes, headerName) {
  const value = fromHeaders[headerName];
  if (value) toRes.setHeader(headerName, value);
}

function extractBearerToken(req, requestUrl) {
  const authHeader = req.headers.authorization || "";
  const fromHeader = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const fromQuery = requestUrl.searchParams.get("at") || "";
  return fromHeader || fromQuery;
}

function cleanupOldStreamLocks() {
  const now = Date.now();
  for (const [userId, locks] of ACTIVE_STREAMS.entries()) {
    const activeLocks = (locks || []).filter((lock) => now - lock.lastSeenAt <= STREAM_LOCK_TTL_MS);
    if (!activeLocks.length) {
      ACTIVE_STREAMS.delete(userId);
      continue;
    }
    ACTIVE_STREAMS.set(userId, activeLocks);
  }
}

function streamIdFromRequest(req, requestUrl) {
  const fromHeader = String(req.headers["x-mktv-stream-id"] || "").trim();
  const fromQuery = String(requestUrl.searchParams.get("sid") || "").trim();
  return fromHeader || fromQuery;
}

function normalizeEmail(rawEmail) {
  return String(rawEmail || "").trim().toLowerCase();
}

function isAdminEmail(email) {
  return ADMIN_EMAILS.has(normalizeEmail(email));
}

function isAdminUser(user) {
  return isAdminEmail(user?.email);
}

function hasSupabaseAccessControlConfig() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function getSupabaseAccessHeaders(extraHeaders = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
    ...extraHeaders,
  };
}

async function requestSupabaseRest(pathWithQuery, method = "GET", body = null, extraHeaders = {}) {
  const supabase = new URL(SUPABASE_URL);
  return requestJson({
    protocol: supabase.protocol,
    hostname: supabase.hostname,
    port: supabase.port || undefined,
    path: pathWithQuery,
    method,
    headers: getSupabaseAccessHeaders(extraHeaders),
    body: body == null ? undefined : JSON.stringify(body),
  });
}

async function getAccessRowByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized || !hasSupabaseAccessControlConfig()) return null;
  const encodedEmail = encodeURIComponent(normalized);
  const response = await requestSupabaseRest(
    `/rest/v1/user_access?email=eq.${encodedEmail}&select=email,approved&limit=1`,
    "GET",
  );
  if (response.status < 200 || response.status >= 300 || !Array.isArray(response.body)) return null;
  return response.body[0] || null;
}

async function ensurePendingEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized || isAdminEmail(normalized) || !hasSupabaseAccessControlConfig()) return;
  const response = await requestSupabaseRest(
    "/rest/v1/user_access?on_conflict=email",
    "POST",
    [{ email: normalized, approved: false }],
    { Prefer: "resolution=merge-duplicates,return=minimal" },
  );
  if (response.status < 200 || response.status >= 300) {
    console.warn("failed to upsert pending access row", normalized, response.status);
  }
}

async function approveEmail(email, approvedBy) {
  const normalized = normalizeEmail(email);
  if (!normalized || !hasSupabaseAccessControlConfig()) return false;
  const encodedEmail = encodeURIComponent(normalized);
  const response = await requestSupabaseRest(
    `/rest/v1/user_access?email=eq.${encodedEmail}`,
    "PATCH",
    {
      approved: true,
      approved_by: normalizeEmail(approvedBy),
      approved_at: new Date().toISOString(),
    },
    { Prefer: "return=minimal" },
  );

  if (response.status === 204) return true;
  if (response.status >= 200 && response.status < 300) return true;

  // If row does not exist yet, create it as approved.
  const insertResponse = await requestSupabaseRest(
    "/rest/v1/user_access?on_conflict=email",
    "POST",
    [{
      email: normalized,
      approved: true,
      approved_by: normalizeEmail(approvedBy),
      approved_at: new Date().toISOString(),
    }],
    { Prefer: "resolution=merge-duplicates,return=minimal" },
  );
  return insertResponse.status >= 200 && insertResponse.status < 300;
}

async function getPendingEmails() {
  if (!hasSupabaseAccessControlConfig()) return [];
  const response = await requestSupabaseRest(
    "/rest/v1/user_access?approved=is.false&select=email&order=created_at.asc",
    "GET",
  );
  if (response.status < 200 || response.status >= 300 || !Array.isArray(response.body)) return [];
  return response.body
    .map((row) => normalizeEmail(row.email))
    .filter((email) => email && !isAdminEmail(email))
    .sort((a, b) => a.localeCompare(b));
}

async function isApprovedEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  if (isAdminEmail(normalized)) return true;
  const row = await getAccessRowByEmail(normalized);
  return Boolean(row?.approved);
}

async function requireApprovedAccess(req, requestUrl) {
  if (!hasSupabaseAccessControlConfig()) {
    return { ok: false, status: 503, error: "Access control not configured on server (missing SUPABASE_SERVICE_ROLE_KEY)" };
  }

  const auth = await authenticateRequest(req, requestUrl);
  if (!auth.ok) return auth;
  const email = normalizeEmail(auth.user?.email);
  if (!email) return { ok: false, status: 403, error: "Missing user email" };
  if (isAdminEmail(email)) return { ok: true, user: auth.user, approved: true, isAdmin: true };
  if (await isApprovedEmail(email)) return { ok: true, user: auth.user, approved: true, isAdmin: false };
  await ensurePendingEmail(email);
  return {
    ok: false,
    status: 403,
    error: "Compte en attente d'approbation admin.",
    pending: true,
  };
}

async function handleAccessStatus(req, requestUrl, res) {
  if (!hasSupabaseAccessControlConfig()) {
    return sendJson(res, 503, { error: "Access control not configured on server (missing SUPABASE_SERVICE_ROLE_KEY)" });
  }
  const auth = await authenticateRequest(req, requestUrl);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const email = normalizeEmail(auth.user?.email);
  const admin = isAdminEmail(email);
  const approved = admin || (await isApprovedEmail(email));
  if (!approved) await ensurePendingEmail(email);
  return sendJson(res, 200, {
    approved,
    pending: !approved,
    isAdmin: admin,
    email,
  });
}

async function handleAccessPending(req, requestUrl, res) {
  if (!hasSupabaseAccessControlConfig()) {
    return sendJson(res, 503, { error: "Access control not configured on server (missing SUPABASE_SERVICE_ROLE_KEY)" });
  }
  const auth = await authenticateRequest(req, requestUrl);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!isAdminUser(auth.user)) return sendJson(res, 403, { error: "Admin only" });
  return sendJson(res, 200, { pending: await getPendingEmails() });
}

async function handleAccessApprove(req, requestUrl, res) {
  if (!hasSupabaseAccessControlConfig()) {
    return sendJson(res, 503, { error: "Access control not configured on server (missing SUPABASE_SERVICE_ROLE_KEY)" });
  }
  const auth = await authenticateRequest(req, requestUrl);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!isAdminUser(auth.user)) return sendJson(res, 403, { error: "Admin only" });
  const body = await readJsonBody(req).catch(() => ({}));
  const email = normalizeEmail(body.email);
  if (!email) return sendJson(res, 400, { error: "Missing email" });
  const approved = await approveEmail(email, auth.user?.email || "");
  if (!approved) return sendJson(res, 500, { error: "Approval update failed" });
  return sendJson(res, 200, { ok: true, email });
}

function requestJson({ protocol, hostname, port, path: requestPath, method, headers, body, timeout = 10000 }) {
  return new Promise((resolve, reject) => {
    const client = protocol === "https:" ? https : http;
    const req = client.request(
      {
        protocol,
        hostname,
        port,
        path: requestPath,
        method,
        headers,
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed = {};
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            parsed = {};
          }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      },
    );

    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Request timeout")));
    if (body) req.write(body);
    req.end();
  });
}

async function verifySupabaseAccessToken(accessToken) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !accessToken) return null;

  const cached = TOKEN_CACHE.get(accessToken);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.user;
  }

  const supabase = new URL(SUPABASE_URL);
  const response = await requestJson({
    protocol: supabase.protocol,
    hostname: supabase.hostname,
    port: supabase.port || undefined,
    path: "/auth/v1/user",
    method: "GET",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (response.status !== 200 || !response.body?.id) return null;

  TOKEN_CACHE.set(accessToken, {
    user: response.body,
    expiresAt: now + TOKEN_CACHE_TTL_MS,
  });
  return response.body;
}

async function enforceSingleStream(req, requestUrl) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { ok: false, status: 503, error: "Supabase auth not configured on server" };
  }

  const streamId = streamIdFromRequest(req, requestUrl);
  if (!streamId) return { ok: false, status: 400, error: "Missing stream id" };

  const auth = await authenticateRequest(req, requestUrl);
  if (!auth.ok) return auth;
  const user = auth.user;

  cleanupOldStreamLocks();
  const now = Date.now();
  const existingLocks = ACTIVE_STREAMS.get(user.id) || [];
  const stillActive = existingLocks.filter((lock) => now - lock.lastSeenAt <= STREAM_LOCK_TTL_MS);
  const existingSame = stillActive.find((lock) => lock.streamId === streamId);

  if (existingSame) {
    existingSame.lastSeenAt = now;
    ACTIVE_STREAMS.set(user.id, stillActive);
    return { ok: true, userId: user.id, streamId };
  }

  if (stillActive.length >= MAX_CONCURRENT_STREAMS_PER_USER) {
    return {
      ok: false,
      status: 409,
      error: `Limite atteinte: ${MAX_CONCURRENT_STREAMS_PER_USER} flux actifs pour ce compte`,
    };
  }

  stillActive.push({ streamId, lastSeenAt: now });
  ACTIVE_STREAMS.set(user.id, stillActive);
  return { ok: true, userId: user.id, streamId };
}

async function authenticateRequest(req, requestUrl) {
  const accessToken = extractBearerToken(req, requestUrl);
  if (!accessToken) return { ok: false, status: 401, error: "Missing access token" };

  const user = await verifySupabaseAccessToken(accessToken);
  if (!user?.id) return { ok: false, status: 401, error: "Invalid access token" };
  return { ok: true, user };
}

function loadSupabasePublicConfig() {
  const fromEnvUrl = process.env.SUPABASE_URL || "";
  const fromEnvAnon = process.env.SUPABASE_ANON_KEY || "";
  if (fromEnvUrl && fromEnvAnon) {
    return { supabaseUrl: fromEnvUrl, supabaseAnonKey: fromEnvAnon };
  }

  try {
    const configPath = path.join(PUBLIC_DIR, "supabase-config.js");
    const raw = fs.readFileSync(configPath, "utf8");
    const urlMatch = raw.match(/url:\s*"([^"]*)"/);
    const anonKeyMatch = raw.match(/anonKey:\s*"([^"]*)"/);
    return {
      supabaseUrl: urlMatch?.[1] || "",
      supabaseAnonKey: anonKeyMatch?.[1] || "",
    };
  } catch {
    return { supabaseUrl: "", supabaseAnonKey: "" };
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function handleSessionRelease(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const auth = await requireApprovedAccess(req, requestUrl);
  if (!auth.ok) {
    return sendJson(res, auth.status, { error: auth.error });
  }
  const body = await readJsonBody(req).catch(() => ({}));
  const streamId = String(body.streamId || streamIdFromRequest(req, requestUrl) || "");
  if (auth.user?.id && streamId) {
    const locks = ACTIVE_STREAMS.get(auth.user.id) || [];
    const nextLocks = locks.filter((lock) => lock.streamId !== streamId);
    if (nextLocks.length) {
      ACTIVE_STREAMS.set(auth.user.id, nextLocks);
    } else {
      ACTIVE_STREAMS.delete(auth.user.id);
    }
  } else if (auth.user?.id) {
    ACTIVE_STREAMS.delete(auth.user.id);
  }
  return sendJson(res, 200, { ok: true });
}

function requestOnce(target, headers, signal) {
  return new Promise((resolve, reject) => {
    const client = target.protocol === "https:" ? https : http;
    const agent = target.protocol === "https:" ? HTTPS_AGENT : HTTP_AGENT;
    const upstreamReq = client.request(
      target,
      { method: "GET", headers, agent, timeout: UPSTREAM_TIMEOUT_MS },
      (upstreamRes) => resolve(upstreamRes),
    );

    upstreamReq.on("error", reject);
    upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("Upstream timeout")));

    if (signal) {
      if (signal.aborted) {
        upstreamReq.destroy(new Error("Aborted"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => upstreamReq.destroy(new Error("Aborted")),
        { once: true },
      );
    }

    upstreamReq.end();
  });
}

async function requestWithRedirects(initialTarget, headers, signal, maxRedirects = 5) {
  let target = initialTarget;

  for (let i = 0; i <= maxRedirects; i += 1) {
    const response = await requestOnce(target, headers, signal);
    const status = response.statusCode || 0;

    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location;
      response.resume();
      if (!location) return { target, response };
      target = new URL(location, target);
      continue;
    }

    return { target, response };
  }

  throw new Error("Too many redirects");
}

async function readStreamAsText(stream) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

async function handleProxyApi(req, res, requestUrl) {
  const access = await requireApprovedAccess(req, requestUrl);
  if (!access.ok) return sendJson(res, access.status, { error: access.error, pending: Boolean(access.pending) });

  const encodedUrl = requestUrl.searchParams.get("url");
  if (!encodedUrl) return sendJson(res, 400, { error: "Missing url query param" });

  let target;
  try {
    target = new URL(encodedUrl);
  } catch {
    return sendJson(res, 400, { error: "Invalid target URL" });
  }

  if (!["http:", "https:"].includes(target.protocol)) {
    return sendJson(res, 400, { error: "Unsupported protocol" });
  }

  const enforcement = ENFORCE_STREAM_LOCKS
    ? await enforceSingleStream(req, requestUrl)
    : { ok: true, streamId: streamIdFromRequest(req, requestUrl) || "" };
  if (!enforcement.ok) return sendJson(res, enforcement.status, { error: enforcement.error });
  const rewriteParams = {
    sid: enforcement.streamId,
    at: extractBearerToken(req, requestUrl),
  };

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  const headerVariants = [
    {
      ...XTREAM_HEADERS,
      Referer: `${target.protocol}//${target.host}/`,
      Origin: `${target.protocol}//${target.host}`,
      Host: target.host,
      Connection: "keep-alive",
    },
    {
      ...XTREAM_HEADERS,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "application/vnd.apple.mpegurl,*/*",
      Referer: `${target.protocol}//${target.host}/`,
      Host: target.host,
      Connection: "keep-alive",
    },
    {
      "User-Agent": "VLC/3.0.20 LibVLC/3.0.20",
      Accept: "*/*",
      "Accept-Encoding": "identity",
      Host: target.host,
      Connection: "keep-alive",
    },
  ].slice(0, PROXY_HEADER_ATTEMPTS);

  if (req.headers.range) {
    for (const headers of headerVariants) {
      headers.Range = req.headers.range;
    }
  }

  for (let attempt = 0; attempt < headerVariants.length; attempt += 1) {
    const upstreamHeaders = headerVariants[attempt];
    let resolvedTarget;
    let upstreamRes;

    try {
      const upstream = await requestWithRedirects(target, upstreamHeaders, controller.signal);
      resolvedTarget = upstream.target;
      upstreamRes = upstream.response;
    } catch (error) {
      if (controller.signal.aborted) return;
      if (attempt < headerVariants.length - 1) continue;
      return sendJson(res, 502, { error: `Upstream request failed: ${error.message}` });
    }

    const upstreamStatus = upstreamRes.statusCode || 502;
    const contentType = upstreamRes.headers["content-type"] || "";
    const isManifest =
      resolvedTarget.pathname.toLowerCase().endsWith(".m3u8") ||
      contentType.includes("application/vnd.apple.mpegurl") ||
      contentType.includes("application/x-mpegurl");

    if (!isManifest) {
      res.statusCode = upstreamStatus;
      copyHeaderIfPresent(upstreamRes.headers, res, "content-type");
      copyHeaderIfPresent(upstreamRes.headers, res, "accept-ranges");
      copyHeaderIfPresent(upstreamRes.headers, res, "content-range");
      copyHeaderIfPresent(upstreamRes.headers, res, "cache-control");
      copyHeaderIfPresent(upstreamRes.headers, res, "content-length");

      upstreamRes.on("error", () => {
        if (!res.writableEnded) res.end();
      });

      return upstreamRes.pipe(res);
    }

    const text = await readStreamAsText(upstreamRes);
    if (text.includes("#EXTM3U")) {
      const rewritten = rewriteManifest(text, resolvedTarget.href, rewriteParams);
      res.statusCode = upstreamStatus;
      res.setHeader("content-type", "application/vnd.apple.mpegurl");
      res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
      res.removeHeader("content-length");
      return res.end(rewritten);
    }

    const shouldRetry = ENFORCE_STREAM_LOCKS && [401, 403, 429].includes(upstreamStatus);
    if (shouldRetry && attempt < headerVariants.length - 1) {
      continue;
    }

    return sendJson(res, upstreamStatus >= 400 ? upstreamStatus : 502, {
      error:
        upstreamStatus >= 400
          ? `Upstream rejected manifest request (${upstreamStatus})`
          : "Upstream did not return a valid HLS manifest",
      preview: text.slice(0, 240),
      source: resolvedTarget.href,
    });
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(text);
}

function safePublicPath(urlPath) {
  const cleaned = urlPath.replace(/^\/+/, "");
  const normalized = path.normalize(cleaned).replace(/^([.][.][\\/])+/, "");
  const resolved = path.join(PUBLIC_DIR, normalized);
  if (!resolved.startsWith(PUBLIC_DIR)) return null;
  return resolved;
}

function serveStatic(urlPath, res, headOnly) {
  const pathname = urlPath === "/" ? "index.html" : urlPath;
  const filePath = safePublicPath(pathname);
  if (!filePath) return sendText(res, 400, "Invalid path");

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      const fallbackPath = path.join(PUBLIC_DIR, "index.html");
      return fs.readFile(fallbackPath, (fallbackErr, fallbackData) => {
        if (fallbackErr) return sendText(res, 404, "Not found");
        res.statusCode = 200;
        res.setHeader("content-type", MIME_TYPES[".html"]);
        if (headOnly) return res.end();
        return res.end(fallbackData);
      });
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeType = MIME_TYPES[ext] || "application/octet-stream";
    res.statusCode = 200;
    res.setHeader("content-type", mimeType);

    if (headOnly) return res.end();

    const stream = fs.createReadStream(filePath);
    stream.on("error", () => sendText(res, 500, "File read error"));
    return stream.pipe(res);
  });
}

function serveAdminPanel(res, headOnly) {
  const filePath = path.join(PRIVATE_DIR, "admin.html");
  fs.readFile(filePath, (err, data) => {
    if (err) return sendText(res, 404, "Not found");
    res.statusCode = 200;
    res.setHeader("content-type", MIME_TYPES[".html"]);
    if (headOnly) return res.end();
    return res.end(data);
  });
}


