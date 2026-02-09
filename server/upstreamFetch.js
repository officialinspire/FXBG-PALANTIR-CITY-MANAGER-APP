const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_JSON_HTML_LIMIT = Math.floor(1.5 * 1024 * 1024);
const DEFAULT_PDF_LIMIT = 8 * 1024 * 1024;
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let upstreamLogStream = null;
let lastLogDir = null;

function ensureLogStream() {
  const logDir = path.resolve(process.cwd(), process.env.LOG_DIR || "logs");
  if (upstreamLogStream && lastLogDir === logDir) return upstreamLogStream;

  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (_) {
    // noop
  }

  const logPath = path.join(logDir, "upstreams.log");
  upstreamLogStream = fs.createWriteStream(logPath, { flags: "a" });
  lastLogDir = logDir;
  return upstreamLogStream;
}

function logUpstream(payload, logger) {
  const entry = {
    ts: new Date().toISOString(),
    ...payload
  };

  if (typeof logger === "function") {
    logger(entry);
    return;
  }

  const stream = ensureLogStream();
  if (!stream) return;
  try {
    stream.write(`${JSON.stringify(entry)}${os.EOL}`);
  } catch (_) {
    // noop
  }
}

function isJsonContentType(contentType) {
  const ct = String(contentType || "").toLowerCase();
  return ct.includes("application/json") || ct.includes("+json");
}

function isHtmlContentType(contentType) {
  const ct = String(contentType || "").toLowerCase();
  return ct.includes("text/html") || ct.includes("text/plain");
}

function isPdfContentType(contentType) {
  const ct = String(contentType || "").toLowerCase();
  return ct.includes("application/pdf");
}

function isJsonpContentType(contentType) {
  const ct = String(contentType || "").toLowerCase();
  return ct.includes("application/javascript") || ct.includes("text/javascript") || ct.includes("text/plain");
}

function resolveMaxBytes(expectedType, maxBytesOverride) {
  if (Number.isFinite(maxBytesOverride) && maxBytesOverride > 0) return maxBytesOverride;
  if (expectedType === "pdf") return DEFAULT_PDF_LIMIT;
  return DEFAULT_JSON_HTML_LIMIT;
}

function validateContentType(expectedType, contentType, allowJsonp) {
  if (!expectedType) return { ok: true };
  if (expectedType === "json") {
    if (isJsonContentType(contentType)) return { ok: true };
    if (allowJsonp && isJsonpContentType(contentType)) return { ok: true };
    return { ok: false, error: "unexpected_content_type" };
  }
  if (expectedType === "html") {
    return isHtmlContentType(contentType) ? { ok: true } : { ok: false, error: "unexpected_content_type" };
  }
  if (expectedType === "pdf") {
    return isPdfContentType(contentType) ? { ok: true } : { ok: false, error: "unexpected_content_type" };
  }
  if (expectedType === "text") {
    return contentType ? { ok: true } : { ok: false, error: "unexpected_content_type" };
  }
  return { ok: true };
}

function stripJsonp(text) {
  const match = text.match(/^[^(]*\((.*)\)\s*;?\s*$/s);
  return match ? match[1] : text;
}

function extractSnippet(buffer, limit = 300) {
  if (!buffer || buffer.length === 0) return "";
  const end = Math.min(buffer.length, limit);
  return buffer.toString("utf8", 0, end);
}

function startsWithJsonToken(buffer) {
  if (!buffer || buffer.length === 0) return false;
  const text = buffer.toString("utf8", 0, Math.min(buffer.length, 2048));
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === " " || char === "\n" || char === "\r" || char === "\t") continue;
    return char === "{" || char === "[";
  }
  return false;
}

async function readBodyWithLimit(response, limitBytes) {
  if (!response.body) return Buffer.alloc(0);

  if (typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.length;
        if (limitBytes && received > limitBytes) {
          await reader.cancel();
          throw new Error("payload_too_large");
        }
        chunks.push(Buffer.from(value));
      }
    }

    return Buffer.concat(chunks, received || undefined);
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    response.body.on("data", (chunk) => {
      received += chunk.length;
      if (limitBytes && received > limitBytes) {
        response.body.destroy();
        reject(new Error("payload_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    response.body.on("end", () => resolve(Buffer.concat(chunks, received || undefined)));
    response.body.on("error", reject);
  });
}

async function upstreamFetch(url, opts = {}) {
  const start = Date.now();
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxRedirects = Number.isFinite(opts.maxRedirects) ? opts.maxRedirects : DEFAULT_MAX_REDIRECTS;
  const expectedType = opts.expectedType || null;
  const allowJsonp = Boolean(opts.allowJsonp);
  const includeBodyText = Boolean(opts.includeBodyText);
  const includeBodyBuffer = Boolean(opts.includeBodyBuffer);
  const method = (opts.method || "GET").toUpperCase();
  const headers = {
    "User-Agent": opts.userAgent || DEFAULT_USER_AGENT,
    "Accept": opts.accept || (expectedType === "json" ? "application/json,*/*" : "*/*"),
    ...opts.headers
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("timeout"), timeoutMs);

  let finalUrl = url;
  let response = null;
  let error = null;
  let warnings = [];
  let bytes = 0;
  let bodyText = undefined;
  let json = undefined;
  let bodyBuffer = undefined;
  let errorSnippet = undefined;

  try {
    for (let attempt = 0; attempt <= maxRedirects; attempt += 1) {
      response = await fetch(finalUrl, {
        method,
        headers,
        redirect: "manual",
        signal: controller.signal
      });

      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        if (attempt === maxRedirects) {
          throw new Error("too_many_redirects");
        }
        const location = response.headers.get("location");
        finalUrl = new URL(location, finalUrl).toString();
        continue;
      }
      break;
    }

    const contentType = response.headers.get("content-type") || "";
    const maxBytes = resolveMaxBytes(expectedType, opts.maxBytes);

    if (method !== "HEAD") {
      bodyBuffer = await readBodyWithLimit(response, maxBytes);
      bytes = bodyBuffer.length;

      const validation = validateContentType(expectedType, contentType, allowJsonp);
      if (!validation.ok) {
        if (expectedType === "json" && bytes > 0 && startsWithJsonToken(bodyBuffer)) {
          const rawText = bodyBuffer.toString("utf8");
          const jsonText = allowJsonp ? stripJsonp(rawText) : rawText;
          try {
            json = JSON.parse(jsonText);
          } catch (err) {
            error = "invalid_json";
            warnings.push(err.message || "JSON parse failed");
          }
        } else {
          errorSnippet = extractSnippet(bodyBuffer);
          const typeLabel = contentType || "missing";
          error = `unexpected_content_type:${typeLabel}`;
          const statusDetail = response ? `; status:${response.status}` : "";
          const snippetDetail = errorSnippet ? `; snippet:${errorSnippet}` : "";
          error = `${error}${statusDetail}${snippetDetail}`;
        }
      } else if (expectedType === "json" && bytes > 0) {
        const rawText = bodyBuffer.toString("utf8");
        const jsonText = allowJsonp ? stripJsonp(rawText) : rawText;
        try {
          json = JSON.parse(jsonText);
        } catch (err) {
          error = "invalid_json";
          warnings.push(err.message || "JSON parse failed");
          if (includeBodyText) {
            bodyText = rawText;
          }
        }
      } else if (expectedType === "html" || expectedType === "text" || includeBodyText) {
        bodyText = bodyBuffer.toString("utf8");
      }

      if (!includeBodyBuffer && expectedType !== "pdf") {
        bodyBuffer = undefined;
      }
    }

    const elapsedMs = Date.now() - start;
    const ok = Boolean(response && response.ok && !error);

    const result = {
      ok,
      status: response ? response.status : 0,
      url,
      finalUrl: finalUrl !== url ? finalUrl : undefined,
      elapsedMs,
      contentType: response ? contentType : undefined,
      bytes: bytes || undefined,
      bodyText,
      bodyBuffer,
      json,
      errorSnippet: errorSnippet || undefined,
      error: error || undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      fetchedAt: new Date().toISOString()
    };

    logUpstream({
      route: opts.route || opts.upstreamName,
      upstream: opts.upstreamName,
      url: opts.logUrl || url,
      status: result.status,
      elapsedMs: result.elapsedMs,
      ok: result.ok,
      bytes: result.bytes,
      cacheState: opts.cacheState || "miss",
      warning: result.warnings ? result.warnings.join("; ") : undefined,
      error: result.error
    }, opts.logger);

    return result;
  } catch (err) {
    const elapsedMs = Date.now() - start;
    const message = err && err.message ? err.message : String(err);
    const result = {
      ok: false,
      status: 0,
      url,
      finalUrl: finalUrl !== url ? finalUrl : undefined,
      elapsedMs,
      error: message === "timeout" || message === "payload_too_large" ? message : "fetch_failed",
      warnings: warnings.length > 0 ? warnings : undefined,
      fetchedAt: new Date().toISOString()
    };

    logUpstream({
      route: opts.route || opts.upstreamName,
      upstream: opts.upstreamName,
      url: opts.logUrl || url,
      status: result.status,
      elapsedMs: result.elapsedMs,
      ok: result.ok,
      bytes: result.bytes,
      cacheState: opts.cacheState || "miss",
      warning: result.warnings ? result.warnings.join("; ") : undefined,
      error: result.error
    }, opts.logger);

    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = {
  upstreamFetch
};
