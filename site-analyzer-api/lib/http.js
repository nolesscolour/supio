// lib/http.js
// Server-side HTTP checks. No Browserless. No extra dependencies.
// Handles: HTTP headers, redirect trace, robots.txt, sitemap.xml, HTML source, broken links.

const TIMEOUT_MS = 10000;

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal, redirect: 'manual' })
    .finally(() => clearTimeout(timeout));
}

// Follows redirects manually so we can record the chain.
// Returns final response + every hop along the way.
async function traceRedirects(url, maxHops = 10) {
  const chain = [];
  let current = url;

  for (let i = 0; i < maxHops; i++) {
    try {
      const res = await fetchWithTimeout(current, { method: 'HEAD' });
      const status = res.status;
      const location = res.headers.get('location');

      chain.push({ url: current, status, location: location || null });

      if (status >= 300 && status < 400 && location) {
        current = new URL(location, current).toString();
        continue;
      }
      return { chain, finalUrl: current, finalStatus: status };
    } catch (err) {
      chain.push({ url: current, status: 0, error: err.message });
      return { chain, finalUrl: current, finalStatus: 0, error: err.message };
    }
  }

  return { chain, finalUrl: current, finalStatus: 0, error: 'too many redirects' };
}

// Gets HTTP headers for the final URL after following redirects.
async function getHeaders(url) {
  try {
    const trace = await traceRedirects(url);
    const res = await fetchWithTimeout(trace.finalUrl, { method: 'HEAD' });
    const headers = {};
    res.headers.forEach((value, key) => { headers[key] = value; });
    return { headers, redirects: trace.chain, finalUrl: trace.finalUrl, finalStatus: trace.finalStatus };
  } catch (err) {
    return { headers: {}, redirects: [], error: err.message };
  }
}

// Fetches robots.txt from the site root.
async function getRobotsTxt(url) {
  try {
    const origin = new URL(url).origin;
    const robotsUrl = `${origin}/robots.txt`;
    const trace = await traceRedirects(robotsUrl);
    const res = await fetch(trace.finalUrl, { method: 'GET' });
    if (!res.ok) return { found: false, status: res.status, content: null };
    const text = await res.text();
    return { found: true, status: res.status, content: text, url: `${origin}/robots.txt` };
  } catch (err) {
    return { found: false, error: err.message, content: null };
  }
}

// Fetches sitemap.xml from the site root. Also parses out URLs if it's valid XML.
// Fetches a single sitemap file. Returns its locs or null on failure.
// Internal helper. Used by getSitemap which handles index detection.
async function fetchSitemapLocs(sitemapUrl) {
  try {
    const trace = await traceRedirects(sitemapUrl);
    const res = await fetch(trace.finalUrl, { method: 'GET' });
    if (!res.ok) return null;
    const text = await res.text();
    const isIndex = /<sitemapindex/i.test(text);
    const locs = Array.from(text.matchAll(/<loc>([^<]+)<\/loc>/g)).map(m => m[1].trim());
    return { isIndex, locs, status: res.status };
  } catch {
    return null;
  }
}

// Fetches sitemap.xml from the site root. Handles sitemap index files
// (common in WordPress) by following each child sitemap and merging URLs.
async function getSitemap(url) {
  try {
    const origin = new URL(url).origin;
    const rootUrl = `${origin}/sitemap.xml`;
    const root = await fetchSitemapLocs(rootUrl);
    if (!root) return { found: false, urls: [] };

    // Single flat sitemap: return locs directly
    if (!root.isIndex) {
      return {
        found: true,
        status: root.status,
        urlCount: root.locs.length,
        urls: root.locs.slice(0, 200),
        source: rootUrl,
        wasIndex: false,
      };
    }

    // Sitemap index: fetch each child sitemap (cap at 10 to avoid runaway requests)
    const childUrls = root.locs.slice(0, 10);
    const childResults = await Promise.all(childUrls.map(u => fetchSitemapLocs(u)));
    const allUrls = new Set();
    childResults.forEach(r => {
      if (r?.locs) r.locs.forEach(u => allUrls.add(u));
    });

    const merged = Array.from(allUrls);
    return {
      found: true,
      status: root.status,
      urlCount: merged.length,
      urls: merged.slice(0, 200),
      source: rootUrl,
      wasIndex: true,
      childSitemaps: childUrls.length,
    };
  } catch (err) {
    return { found: false, error: err.message, urls: [] };
  }
}

// Fetches raw HTML source for a URL.
async function getHtmlSource(url) {
  try {
    const res = await fetchWithTimeout(url, { method: 'GET' });
    if (!res.ok) return { ok: false, status: res.status, html: null };
    const html = await res.text();
    return { ok: true, status: res.status, html, sizeBytes: html.length };
  } catch (err) {
    return { ok: false, error: err.message, html: null };
  }
}

// Checks a list of URLs in parallel batches. Returns broken ones with status codes.
async function checkLinks(urls, batchSize = 10) {
  const results = [];
  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (linkUrl) => {
        try {
          const res = await fetchWithTimeout(linkUrl, { method: 'HEAD' });
          return { url: linkUrl, status: res.status, ok: res.ok };
        } catch (err) {
          return { url: linkUrl, status: 0, ok: false, error: err.message };
        }
      })
    );
    results.push(...batchResults);
  }
  const broken = results.filter(r => !r.ok || r.status >= 400);
  return { total: results.length, broken: broken.length, brokenLinks: broken, all: results };
}

module.exports = { getHeaders, getRobotsTxt, getSitemap, getHtmlSource, checkLinks, traceRedirects };