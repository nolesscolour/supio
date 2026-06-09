// lib/browserless.js
// Single wrapper for all Browserless API calls.
// Every check (lighthouse, axe, tokens, copy) goes through here.

// fetch is built into Node.js v18+, no import needed

const TOKEN = process.env.BROWSERLESS_TOKEN;
const BASE_URL = 'https://production-sfo.browserless.io';

if (!TOKEN) {
  throw new Error('BROWSERLESS_TOKEN missing from .env file');
}

// Runs a Lighthouse audit on the given URL.
// Returns the raw Lighthouse JSON report.
async function runLighthouse(url) {
  const endpoint = `${BASE_URL}/performance?token=${TOKEN}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      config: {
        extends: 'lighthouse:default',
        settings: {
          onlyCategories: ['performance', 'accessibility', 'seo', 'best-practices'],
          formFactor: 'mobile',
          throttling: { cpuSlowdownMultiplier: 4 },
        },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Lighthouse failed: ${res.status} ${text}`);
  }

  return await res.json();
}

// Runs axe-core (WCAG accessibility scanner) on the URL.
// Returns the list of violations with severity, rule, and affected elements.
async function runAxe(url) {
  const endpoint = `${BASE_URL}/function?token=${TOKEN}`;

  // This code runs INSIDE Browserless's headless browser, not on your machine.
  // It loads the target URL, injects axe-core, runs the scan, returns violations.
  const code = `
    export default async function ({ page }) {
      await page.goto('${url}', { waitUntil: 'networkidle2', timeout: 30000 });
      await page.addScriptTag({
        url: 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.8.2/axe.min.js'
      });
      const results = await page.evaluate(async () => {
        return await axe.run({
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] }
        });
      });
      return { data: results.violations, type: 'application/json' };
    }
  `;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/javascript' },
    body: code,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Axe failed: ${res.status} ${text}`);
  }

  return await res.json();
}

// Extracts design tokens from the page: colors, fonts, spacing.
// Walks every visible element, reads computed styles, aggregates the most-used values.
async function runTokens(url) {
  const endpoint = `${BASE_URL}/function?token=${TOKEN}`;

  const code = `
    export default async function ({ page }) {
      await page.goto('${url}', { waitUntil: 'networkidle2', timeout: 30000 });

      const tokens = await page.evaluate(() => {
        const colors = {};
        const fonts = {};
        const spacing = {};

        // Walk every element, read computed styles
        document.querySelectorAll('*').forEach(el => {
          const s = window.getComputedStyle(el);

          // Colors - track text color and background color
          [s.color, s.backgroundColor].forEach(c => {
            if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') {
              colors[c] = (colors[c] || 0) + 1;
            }
          });

          // Fonts - track font-family
          if (s.fontFamily) {
            fonts[s.fontFamily] = (fonts[s.fontFamily] || 0) + 1;
          }

          // Spacing - track padding and margin values
          [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft,
           s.marginTop, s.marginRight, s.marginBottom, s.marginLeft].forEach(v => {
            if (v && v !== '0px') {
              spacing[v] = (spacing[v] || 0) + 1;
            }
          });
        });

        // Sort each by frequency, return top values
        const sortByFreq = (obj, limit) =>
          Object.entries(obj)
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([value, count]) => ({ value, count }));

        return {
          colors: sortByFreq(colors, 12),
          fonts: sortByFreq(fonts, 6),
          spacing: sortByFreq(spacing, 10),
        };
      });

      return { data: tokens, type: 'application/json' };
    }
  `;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/javascript' },
    body: code,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tokens failed: ${res.status} ${text}`);
  }

  return await res.json();
}

// Extracts copy from the page: hierarchy + stats.
async function runCopy(url) {
  const endpoint = `${BASE_URL}/function?token=${TOKEN}`;

  const code = `
    export default async function ({ page }) {
      await page.goto('${url}', { waitUntil: 'networkidle2', timeout: 30000 });

      const result = await page.evaluate(() => {
        // Meta info
        const meta = {
          title: document.title || '',
          description: document.querySelector('meta[name="description"]')?.content || '',
          ogTitle: document.querySelector('meta[property="og:title"]')?.content || '',
          ogDescription: document.querySelector('meta[property="og:description"]')?.content || '',
        };

        // Hierarchy - group paragraphs and links under nearest heading
        const sections = [];
        let current = { heading: null, level: 0, paragraphs: [] };

        document.querySelectorAll('h1, h2, h3, h4, p, li').forEach(el => {
          const tag = el.tagName.toLowerCase();
          const text = el.innerText?.trim();
          if (!text) return;

          if (tag.startsWith('h')) {
            if (current.heading || current.paragraphs.length) sections.push(current);
            current = { heading: text, level: parseInt(tag[1]), paragraphs: [] };
          } else {
            current.paragraphs.push(text);
          }
        });
        if (current.heading || current.paragraphs.length) sections.push(current);

        // Buttons and CTAs. Normalize whitespace — innerText preserves indentation
        // from HTML, producing "Let's\\n        Go!" when source is multi-line.
        const ctas = Array.from(document.querySelectorAll('button, a.btn, [role="button"]'))
          .map(el => el.innerText?.replace(/\\s+/g, ' ').trim())
          .filter(t => t && t.length < 80);

        // Image alt text (for accessibility audit reference)
        const altTexts = Array.from(document.querySelectorAll('img'))
          .map(img => img.alt?.trim())
          .filter(t => t);

        // Stats - all visible text combined
        const allText = sections.flatMap(s =>
          [s.heading, ...s.paragraphs].filter(Boolean)
        ).join(' ');
        const words = allText.split(/\\s+/).filter(Boolean);
        const sentences = allText.split(/[.!?]+/).filter(s => s.trim().length > 0);

        const stats = {
          wordCount: words.length,
          sentenceCount: sentences.length,
          avgSentenceLength: sentences.length ? Math.round(words.length / sentences.length) : 0,
          readingTimeMinutes: Math.max(1, Math.round(words.length / 200)),
        };

        return { meta, sections, ctas, altTexts, stats };
      });

      return { data: result, type: 'application/json' };
    }
  `;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/javascript' },
    body: code,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Copy failed: ${res.status} ${text}`);
  }

  return await res.json();
}

// Scouts a page for all internal links (same domain, excludes fragments/mailto/tel/pdf)
async function runScout(url) {
  const endpoint = `${BASE_URL}/function?token=${TOKEN}`;

  const code = `
    export default async function ({ page }) {
      await page.goto('${url}', { waitUntil: 'networkidle2', timeout: 30000 });

      const result = await page.evaluate((startUrl) => {
        const origin = new URL(startUrl).origin;
        const links = new Set();

        document.querySelectorAll('a[href]').forEach(a => {
          try {
            const href = a.getAttribute('href');
            if (!href) return;
            if (href.startsWith('#')) return;
            if (href.startsWith('mailto:')) return;
            if (href.startsWith('tel:')) return;
            if (/\\.(pdf|zip|doc|docx|jpg|jpeg|png|gif|svg|mp4|mp3)$/i.test(href)) return;

            const fullUrl = new URL(href, startUrl);
            if (fullUrl.origin !== origin) return;

            // Strip query strings and fragments for deduplication
            fullUrl.hash = '';
            fullUrl.search = '';
            const clean = fullUrl.toString().replace(/\\/$/, '');
            links.add(clean);
          } catch {}
        });

        return {
          startUrl,
          origin,
          title: document.title || '',
          links: Array.from(links).sort(),
        };
      }, '${url}');

      return { data: result, type: 'application/json' };
    }
  `;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/javascript' },
    body: code,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Scout failed: ${res.status} ${text}`);
  }

  return await res.json();
}

module.exports = { runLighthouse, runAxe, runTokens, runCopy, runScout };