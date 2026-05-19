// server.js
// Endpoints:
//   POST /api/scout    - given a URL, return list of internal links
//   POST /api/analyze  - given URLs[], runs full checks on primary, light checks on others
//   POST /api/export   - given analyze results, returns markdown report

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { runLighthouse, runAxe, runTokens, runCopy, runScout } = require('./lib/browserless');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

function rgbToHex(rgb) {
  if (!rgb) return rgb;
  const match = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return rgb;
  const [, r, g, b] = match;
  const toHex = n => parseInt(n).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toLowerCase();
}

function formatTokens(rawTokens) {
  const t = rawTokens || { colors: [], fonts: [], spacing: [] };
  return {
    colors: t.colors.map(c => ({ value: rgbToHex(c.value), rgb: c.value, count: c.count })),
    fonts: t.fonts,
    spacing: t.spacing,
  };
}

// Builds a multi-page markdown report
function buildMarkdown(data) {
  const { primaryUrl, pages, duration } = data;
  const timestamp = new Date().toISOString().split('T')[0];
  const hostname = new URL(primaryUrl).hostname;

  const primary = pages.find(p => p.url === primaryUrl) || pages[0];
  const scores = primary.scores;
  const violations = primary.violations || [];
  const violationCount = violations.length;
  const critical = violations.filter(v => v.impact === 'critical').length;
  const serious = violations.filter(v => v.impact === 'serious').length;

  const topColors = primary.tokens.colors.slice(0, 3).map(c => c.value).join(', ');
  const topFont = primary.tokens.fonts[0]?.value?.split(',')[0]?.replace(/['"]/g, '').trim() || 'unknown';

  const totalWords = pages.reduce((sum, p) => sum + (p.copy?.stats?.wordCount || 0), 0);
  const totalSentences = pages.reduce((sum, p) => sum + (p.copy?.stats?.sentenceCount || 0), 0);

  let md = `# Site Analysis: ${hostname}

**Primary URL:** ${primaryUrl}
**Pages analyzed:** ${pages.length}
**Analyzed:** ${timestamp}
**Total duration:** ${duration}

---

## Redesign Brief

The primary page (${primaryUrl}) scored ${scores.performance}/100 on performance, ${scores.accessibility}/100 on accessibility, ${scores.seo}/100 on SEO, and ${scores.bestPractices}/100 on best practices.

The design uses ${primary.tokens.colors.length} dominant colors (primary: ${topColors}) and ${primary.tokens.fonts.length} font families, with ${topFont} as the most-used typeface. Spacing tokens cluster around ${primary.tokens.spacing.slice(0, 3).map(s => s.value).join(', ')}.

Across ${pages.length} analyzed pages, total content is ${totalWords} words across ${totalSentences} sentences.

Accessibility surfaces ${violationCount} WCAG issues on the primary page — ${critical} critical, ${serious} serious. These should be the first concerns in any redesign.

---

## Scores (Primary Page Only)

- Performance: ${scores.performance}/100
- Accessibility: ${scores.accessibility}/100
- SEO: ${scores.seo}/100
- Best Practices: ${scores.bestPractices}/100

## WCAG Violations (${violationCount})

${violations.length === 0 ? '_No violations found._' : violations.map(v => `### ${v.id} (${v.impact})

${v.description}

- Affected elements: ${v.nodeCount}
- Fix guide: ${v.help}
- Reference: ${v.helpUrl}
`).join('\n')}

## Design Tokens (Primary Page)

### Colors (top ${primary.tokens.colors.length})

${primary.tokens.colors.map(c => `- ${c.value} (rgb: ${c.rgb}) — used ${c.count} times`).join('\n')}

### Fonts (top ${primary.tokens.fonts.length})

${primary.tokens.fonts.map(f => `- ${f.value} — used ${f.count} times`).join('\n')}

### Spacing (top ${primary.tokens.spacing.length})

${primary.tokens.spacing.map(s => `- ${s.value} — used ${s.count} times`).join('\n')}

---

# Content by Page
`;

  // Per-page content section
  pages.forEach(page => {
    md += `

---

## ${page.url}

`;
    if (page.error) {
      md += `_Failed: ${page.error}_\n`;
      return;
    }
    const c = page.copy;
    md += `### Meta

- Title: ${c.meta.title || '_missing_'}
- Description: ${c.meta.description || '_missing_'}
- OG Title: ${c.meta.ogTitle || '_missing_'}
- OG Description: ${c.meta.ogDescription || '_missing_'}

### Stats

- Word count: ${c.stats.wordCount}
- Sentence count: ${c.stats.sentenceCount}
- Average sentence length: ${c.stats.avgSentenceLength} words
- Reading time: ${c.stats.readingTimeMinutes} minutes

### Sections

${c.sections.map(s => {
  const heading = s.heading ? `${'#'.repeat(Math.min(s.level + 3, 6))} ${s.heading}` : '#### (no heading)';
  const paragraphs = s.paragraphs.length ? '\n' + s.paragraphs.join('\n\n') : '';
  return heading + paragraphs;
}).join('\n\n')}

### CTAs / Buttons (${c.ctas.length})

${c.ctas.length === 0 ? '_None found._' : c.ctas.map(x => `- ${x}`).join('\n')}

### Image Alt Text (${c.altTexts.length})

${c.altTexts.length === 0 ? '_None found._' : c.altTexts.map(x => `- ${x}`).join('\n')}
`;
  });

  md += `\n\n---\n\n_Generated by site-analyzer_\n`;
  return md;
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'site-analyzer-api running' });
});

// Scout endpoint - finds internal links on a page
app.post('/api/scout', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'invalid url format' });
  }

  console.log(`[scout] Scanning: ${url}`);
  try {
    const result = await runScout(url);
    const data = result.data || {};
    console.log(`[scout] Found ${data.links?.length || 0} internal links`);
    res.json({
      startUrl: data.startUrl,
      title: data.title,
      links: data.links || [],
    });
  } catch (err) {
    console.error('[scout] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Analyze endpoint - takes URLs, runs full checks on primary, light on others
app.post('/api/analyze', async (req, res) => {
  const { urls, primaryUrl } = req.body;

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls array is required' });
  }
  if (!primaryUrl || !urls.includes(primaryUrl)) {
    return res.status(400).json({ error: 'primaryUrl must be in urls array' });
  }
  for (const u of urls) {
    try { new URL(u); } catch { return res.status(400).json({ error: `invalid url: ${u}` }); }
  }

  console.log(`[analyze] Starting multi-page run: ${urls.length} pages, primary: ${primaryUrl}`);
  const startTime = Date.now();
  const pages = [];

  try {
    for (const url of urls) {
      const isPrimary = url === primaryUrl;
      console.log(`[analyze] ${isPrimary ? '★ PRIMARY' : '  '} ${url}`);

      const page = { url, isPrimary };

      try {
        if (isPrimary) {
          console.log('  Running Lighthouse...');
          const report = await runLighthouse(url);
          page.scores = {
            performance: Math.round((report.data?.categories?.performance?.score || 0) * 100),
            accessibility: Math.round((report.data?.categories?.accessibility?.score || 0) * 100),
            seo: Math.round((report.data?.categories?.seo?.score || 0) * 100),
            bestPractices: Math.round((report.data?.categories?.['best-practices']?.score || 0) * 100),
          };

          console.log('  Running axe...');
          const axeResults = await runAxe(url);
          page.violations = (axeResults.data || []).map(v => ({
            id: v.id, impact: v.impact, description: v.description,
            help: v.help, helpUrl: v.helpUrl, nodeCount: v.nodes.length,
          }));
        }

        console.log('  Running tokens...');
        const tokenResults = await runTokens(url);
        page.tokens = formatTokens(tokenResults.data);

        console.log('  Running copy...');
        const copyResults = await runCopy(url);
        page.copy = copyResults.data || { meta: {}, sections: [], ctas: [], altTexts: [], stats: {} };
      } catch (err) {
        console.error(`  Failed on ${url}:`, err.message);
        page.error = err.message;
      }

      pages.push(page);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[analyze] Done in ${duration}s.`);

    res.json({
      primaryUrl,
      duration: `${duration}s`,
      pages,
    });
  } catch (err) {
    console.error('[analyze] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Export endpoint - takes analyze results, returns markdown file
app.post('/api/export', (req, res) => {
  const data = req.body;
  if (!data?.primaryUrl || !data?.pages) {
    return res.status(400).json({ error: 'invalid data - run /api/analyze first' });
  }
  try {
    const markdown = buildMarkdown(data);
    const hostname = new URL(data.primaryUrl).hostname.replace(/\./g, '-');
    const filename = `${hostname}-${Date.now()}.md`;
    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(markdown);
  } catch (err) {
    console.error('[export] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Endpoints: POST /api/scout, /api/analyze, /api/export`);
});