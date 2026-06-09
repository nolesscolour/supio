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

// Combined audit. One Browserless session, one DOM walk, all client-side data:
// - Design tokens (colors, fonts, spacing) — same as runTokens
// - Copy (meta, sections, ctas, alt text, stats) — same as runCopy
// - Image audit: dimensions, formats, lazy loading, missing alts
// - Form audit: label coverage, input types, autocomplete attrs
// - ARIA usage: roles, labels, landmarks, aria-* attributes
// - Color contrast pairs: foreground/background pairs in use with ratios
// - Structural breakdown: tree of semantic regions
// - Font loading: link rels, font-display, custom font sources
async function runAudit(url) {
  const endpoint = `${BASE_URL}/function?token=${TOKEN}`;

  const code = `
    export default async function ({ page }) {
      await page.goto('${url}', { waitUntil: 'networkidle2', timeout: 30000 });

      const result = await page.evaluate(() => {
        // ── DESIGN TOKENS ──────────────────────────────────────────
        const colors = {};
        const fonts = {};
        const spacing = {};

        // Track FG/BG color pairs for contrast analysis
        const contrastPairs = {};

        document.querySelectorAll('*').forEach(el => {
          const s = window.getComputedStyle(el);

          [s.color, s.backgroundColor].forEach(c => {
            if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') {
              colors[c] = (colors[c] || 0) + 1;
            }
          });

          // Pair tracking: only count when both foreground and background are visible
          if (s.color && s.backgroundColor &&
              s.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
              s.backgroundColor !== 'transparent') {
            const pair = s.color + '|' + s.backgroundColor;
            contrastPairs[pair] = (contrastPairs[pair] || 0) + 1;
          }

          if (s.fontFamily) {
            fonts[s.fontFamily] = (fonts[s.fontFamily] || 0) + 1;
          }

          [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft,
           s.marginTop, s.marginRight, s.marginBottom, s.marginLeft].forEach(v => {
            if (v && v !== '0px') {
              spacing[v] = (spacing[v] || 0) + 1;
            }
          });
        });

        const sortByFreq = (obj, limit) =>
          Object.entries(obj)
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([value, count]) => ({ value, count }));

        const tokens = {
          colors: sortByFreq(colors, 12),
          fonts: sortByFreq(fonts, 6),
          spacing: sortByFreq(spacing, 10),
        };

        const contrastPairsList = Object.entries(contrastPairs)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([pair, count]) => {
            const [fg, bg] = pair.split('|');
            return { foreground: fg, background: bg, count };
          });

        // ── META + COPY ────────────────────────────────────────────
        const meta = {
          title: document.title || '',
          description: document.querySelector('meta[name="description"]')?.content || '',
          ogTitle: document.querySelector('meta[property="og:title"]')?.content || '',
          ogDescription: document.querySelector('meta[property="og:description"]')?.content || '',
          viewport: document.querySelector('meta[name="viewport"]')?.content || '',
          lang: document.documentElement.lang || '',
          charset: document.characterSet || '',
        };

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

        // Whitespace-normalized CTAs (fixes the bug from Phase 1)
        const ctas = Array.from(document.querySelectorAll('button, a.btn, [role="button"]'))
          .map(el => el.innerText?.replace(/\\s+/g, ' ').trim())
          .filter(t => t && t.length < 80);

        const altTexts = Array.from(document.querySelectorAll('img'))
          .map(img => img.alt?.trim())
          .filter(t => t);

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

        // ── IMAGE AUDIT ────────────────────────────────────────────
        const images = Array.from(document.querySelectorAll('img')).map(img => {
          const src = img.currentSrc || img.src || '';
          const ext = (src.split('.').pop() || '').split('?')[0].toLowerCase();
          return {
            src: src.slice(0, 200),
            alt: img.alt || '',
            hasAlt: img.hasAttribute('alt'),
            width: img.naturalWidth || 0,
            height: img.naturalHeight || 0,
            displayWidth: img.width || 0,
            displayHeight: img.height || 0,
            loading: img.loading || 'auto',
            format: ['webp', 'avif', 'jpg', 'jpeg', 'png', 'gif', 'svg'].includes(ext) ? ext : 'unknown',
            oversized: img.naturalWidth > 0 && img.width > 0 && img.naturalWidth > img.width * 2,
          };
        });

        const imageAudit = {
          total: images.length,
          missingAlt: images.filter(i => !i.hasAlt).length,
          emptyAlt: images.filter(i => i.hasAlt && !i.alt).length,
          notLazyLoaded: images.filter(i => i.loading !== 'lazy').length,
          oversized: images.filter(i => i.oversized).length,
          formatBreakdown: images.reduce((acc, i) => {
            acc[i.format] = (acc[i.format] || 0) + 1;
            return acc;
          }, {}),
          samples: images.slice(0, 10),
        };

        // ── FORM AUDIT ─────────────────────────────────────────────
        const forms = Array.from(document.querySelectorAll('form')).map(form => {
          const inputs = Array.from(form.querySelectorAll('input, select, textarea'));
          const inputDetails = inputs.map(input => {
            const id = input.id;
            const label = id ? document.querySelector(\`label[for="\${id}"]\`) : null;
            const wrappingLabel = input.closest('label');
            return {
              type: input.type || input.tagName.toLowerCase(),
              name: input.name || '',
              id: id || '',
              hasLabel: !!(label || wrappingLabel || input.getAttribute('aria-label') || input.getAttribute('aria-labelledby')),
              hasAutocomplete: input.hasAttribute('autocomplete'),
              autocomplete: input.getAttribute('autocomplete') || '',
              required: input.required || false,
              placeholder: input.placeholder || '',
            };
          });
          return {
            action: form.getAttribute('action') || '',
            method: form.getAttribute('method') || 'get',
            inputCount: inputs.length,
            unlabeled: inputDetails.filter(i => !i.hasLabel).length,
            missingAutocomplete: inputDetails.filter(i => !i.hasAutocomplete && ['text', 'email', 'tel', 'password'].includes(i.type)).length,
            inputs: inputDetails,
          };
        });

        const formAudit = {
          total: forms.length,
          totalInputs: forms.reduce((sum, f) => sum + f.inputCount, 0),
          totalUnlabeled: forms.reduce((sum, f) => sum + f.unlabeled, 0),
          forms,
        };

        // ── ARIA REPORT ────────────────────────────────────────────
        const roleCounts = {};
        document.querySelectorAll('[role]').forEach(el => {
          const role = el.getAttribute('role');
          roleCounts[role] = (roleCounts[role] || 0) + 1;
        });

        const ariaLabels = document.querySelectorAll('[aria-label]').length;
        const ariaLabelledby = document.querySelectorAll('[aria-labelledby]').length;
        const ariaDescribedby = document.querySelectorAll('[aria-describedby]').length;
        const ariaHidden = document.querySelectorAll('[aria-hidden="true"]').length;

        // Landmarks check
        const landmarks = {
          header: document.querySelectorAll('header, [role="banner"]').length,
          nav: document.querySelectorAll('nav, [role="navigation"]').length,
          main: document.querySelectorAll('main, [role="main"]').length,
          footer: document.querySelectorAll('footer, [role="contentinfo"]').length,
          aside: document.querySelectorAll('aside, [role="complementary"]').length,
          search: document.querySelectorAll('[role="search"]').length,
        };

        // Heading hierarchy
        const headingCounts = {
          h1: document.querySelectorAll('h1').length,
          h2: document.querySelectorAll('h2').length,
          h3: document.querySelectorAll('h3').length,
          h4: document.querySelectorAll('h4').length,
          h5: document.querySelectorAll('h5').length,
          h6: document.querySelectorAll('h6').length,
        };

        const ariaReport = {
          roles: roleCounts,
          ariaLabels,
          ariaLabelledby,
          ariaDescribedby,
          ariaHidden,
          landmarks,
          headings: headingCounts,
          hasSkipLink: !!document.querySelector('a[href^="#"][class*="skip"], a[href^="#main"], a[href^="#content"]'),
          hasLangAttr: !!document.documentElement.lang,
        };

        // ── STRUCTURAL BREAKDOWN ────────────────────────────────────
        // Walk top-level semantic regions and describe what's in each
        const structure = [];
        const semanticTags = ['header', 'nav', 'main', 'section', 'article', 'aside', 'footer'];
        document.querySelectorAll(semanticTags.join(',')).forEach(el => {
          if (el.closest('header, nav, main, section, article, aside, footer') !== el) {
            // Skip nested — only describe top-level instances of each
            const parent = el.parentElement?.closest(semanticTags.join(','));
            if (parent && parent !== el) return;
          }
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role') || '';
          const ariaLabel = el.getAttribute('aria-label') || '';
          const firstHeading = el.querySelector('h1, h2, h3')?.innerText?.trim() || '';
          structure.push({
            tag,
            role,
            ariaLabel,
            firstHeading: firstHeading.slice(0, 100),
            childCount: el.children.length,
            imageCount: el.querySelectorAll('img').length,
            linkCount: el.querySelectorAll('a').length,
            buttonCount: el.querySelectorAll('button').length,
          });
        });

        // ── FONT LOADING ───────────────────────────────────────────
        const fontLinks = Array.from(document.querySelectorAll('link[rel*="font"], link[as="font"]')).map(l => ({
          href: l.href,
          rel: l.rel,
          crossorigin: l.crossOrigin || '',
        }));

        const googleFontLinks = Array.from(document.querySelectorAll('link[href*="fonts.googleapis.com"], link[href*="fonts.gstatic.com"]')).map(l => l.href);
        const fontFaceRules = [];
        try {
          for (const sheet of document.styleSheets) {
            try {
              for (const rule of sheet.cssRules || []) {
                if (rule.type === CSSRule.FONT_FACE_RULE) {
                  fontFaceRules.push({
                    family: rule.style.fontFamily || '',
                    src: (rule.style.src || '').slice(0, 200),
                    display: rule.style.fontDisplay || 'auto',
                  });
                }
              }
            } catch {}
          }
        } catch {}

        const fontLoading = {
          preloadLinks: fontLinks,
          googleFontLinks,
          fontFaceRules: fontFaceRules.slice(0, 20),
          hasFontDisplay: fontFaceRules.some(r => r.display && r.display !== 'auto'),
        };

        return {
          tokens,
          contrastPairs: contrastPairsList,
          meta,
          sections,
          ctas,
          altTexts,
          stats,
          imageAudit,
          formAudit,
          ariaReport,
          structure,
          fontLoading,
        };
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
    throw new Error(`Audit failed: ${res.status} ${text}`);
  }

  return await res.json();
}
module.exports = { runLighthouse, runAxe, runTokens, runCopy, runScout, runAudit };