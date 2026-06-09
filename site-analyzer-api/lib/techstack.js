// lib/techstack.js
// Detects tech stack from HTML + HTTP headers. No external API, no Browserless.
// Pattern matches against a small Wappalyzer-style ruleset.

// Each rule has: name, category, and patterns to look for.
// html: regex tested against page HTML
// header: { name: regex } tested against HTTP response headers
// script: regex tested against <script src=> values
const RULES = [
  // CMS / no-code builders
  { name: 'WordPress', category: 'CMS', html: /wp-content|wp-includes|wp-json/i, header: { 'link': /wp-json/i } },
  { name: 'Webflow', category: 'CMS', html: /webflow\.com|data-wf-page/i },
  { name: 'Squarespace', category: 'CMS', html: /squarespace|static1\.squarespace/i },
  { name: 'Wix', category: 'CMS', html: /wix\.com|_wix_browser|wixsite/i },
  { name: 'Framer', category: 'CMS', html: /framerusercontent\.com|framer-/i, header: { 'server': /framer/i } },
  { name: 'Notion', category: 'CMS', html: /notion-static\.com|notion\.so/i },
  { name: 'Carrd', category: 'CMS', html: /carrd\.co/i },
  { name: 'Cargo', category: 'CMS', html: /cargo\.site|cargocollective/i },
  { name: 'Shopify', category: 'E-commerce', html: /cdn\.shopify\.com|shopify\.theme/i, header: { 'x-shopify-stage': /./ } },
  { name: 'Ghost', category: 'CMS', html: /ghost\.io|content="Ghost/i, header: { 'x-ghost-cache-status': /./ } },
  { name: 'Drupal', category: 'CMS', html: /drupal\.js|sites\/default\/files/i, header: { 'x-drupal-cache': /./ } },

  // Frameworks
  { name: 'Next.js', category: 'Framework', html: /__next|\/_next\//i, header: { 'x-powered-by': /next\.js/i } },
  { name: 'Nuxt', category: 'Framework', html: /__nuxt|\/_nuxt\//i },
  { name: 'Gatsby', category: 'Framework', html: /gatsby|___gatsby/i },
  { name: 'Astro', category: 'Framework', html: /astro-island|data-astro-/i },
  { name: 'SvelteKit', category: 'Framework', html: /__sveltekit|svelte-/i },
  { name: 'Remix', category: 'Framework', html: /__remix|remix:context/i },
  { name: 'React', category: 'JavaScript Library', html: /react\.production|react\.development|data-reactroot/i },
  { name: 'Vue.js', category: 'JavaScript Library', html: /vue\.runtime|__vue__|data-v-/i },

  // Hosting / CDN
  { name: 'Vercel', category: 'Hosting', header: { 'server': /vercel/i, 'x-vercel-id': /./ } },
  { name: 'Netlify', category: 'Hosting', header: { 'server': /netlify/i, 'x-nf-request-id': /./ } },
  { name: 'Cloudflare', category: 'CDN', header: { 'server': /cloudflare/i, 'cf-ray': /./ } },
  { name: 'AWS CloudFront', category: 'CDN', header: { 'via': /cloudfront/i, 'x-amz-cf-id': /./ } },
  { name: 'Fastly', category: 'CDN', header: { 'x-served-by': /cache-/i, 'fastly-debug-digest': /./ } },
  { name: 'GitHub Pages', category: 'Hosting', header: { 'server': /github\.com/i, 'x-github-request-id': /./ } },

  // Web server
  { name: 'Nginx', category: 'Web Server', header: { 'server': /nginx/i } },
  { name: 'Apache', category: 'Web Server', header: { 'server': /apache/i } },
  { name: 'LiteSpeed', category: 'Web Server', header: { 'server': /litespeed/i } },

  // Analytics & tags
  { name: 'Google Analytics', category: 'Analytics', html: /google-analytics\.com|gtag\(|googletagmanager/i },
  { name: 'Google Tag Manager', category: 'Tag Manager', html: /googletagmanager\.com\/gtm\.js/i },
  { name: 'Plausible', category: 'Analytics', html: /plausible\.io\/js/i },
  { name: 'Fathom', category: 'Analytics', html: /usefathom\.com|cdn\.usefathom/i },
  { name: 'Mixpanel', category: 'Analytics', html: /mixpanel\.com|mixpanel\.init/i },
  { name: 'Segment', category: 'Analytics', html: /cdn\.segment\.com|analytics\.load/i },
  { name: 'Hotjar', category: 'Analytics', html: /static\.hotjar\.com|hjSetting/i },

  // UI libs / CSS frameworks
  { name: 'Tailwind CSS', category: 'CSS Framework', html: /tailwind|tw-/i },
  { name: 'Bootstrap', category: 'CSS Framework', html: /bootstrap(\.min)?\.css|class="[^"]*\bcol-(xs|sm|md|lg|xl)-/i },
  { name: 'Bulma', category: 'CSS Framework', html: /bulma(\.min)?\.css/i },
  { name: 'Material-UI', category: 'UI Library', html: /MuiBox|MuiButton|@material-ui/i },

  // Fonts
  { name: 'Google Fonts', category: 'Font Service', html: /fonts\.googleapis\.com|fonts\.gstatic\.com/i },
  { name: 'Adobe Fonts', category: 'Font Service', html: /use\.typekit\.net|p\.typekit/i },

  // Email / forms
  { name: 'Mailchimp', category: 'Marketing', html: /mailchimp|list-manage\.com/i },
  { name: 'HubSpot', category: 'Marketing', html: /js\.hs-scripts\.com|hubspot|_hsq/i },
  { name: 'Intercom', category: 'Live Chat', html: /widget\.intercom\.io|intercomSettings/i },

  // Payments
  { name: 'Stripe', category: 'Payments', html: /js\.stripe\.com|stripe\.com\/v3/i },
  { name: 'PayPal', category: 'Payments', html: /paypal\.com\/sdk|paypalobjects/i },

  // jQuery
  { name: 'jQuery', category: 'JavaScript Library', html: /jquery(\.min)?\.js|jQuery v[\d.]+/i },
];

// Detects tech stack by running all rules against the given HTML + headers object.
// Returns matched tech grouped by category.
function detect({ html = '', headers = {} } = {}) {
  const matches = [];

  for (const rule of RULES) {
    let hit = false;

    if (rule.html && rule.html.test(html)) hit = true;

    if (!hit && rule.header) {
      for (const [headerName, pattern] of Object.entries(rule.header)) {
        const value = headers[headerName.toLowerCase()];
        if (value && pattern.test(value)) { hit = true; break; }
      }
    }

    if (hit) matches.push({ name: rule.name, category: rule.category });
  }

  // Group by category for cleaner output
  const grouped = {};
  for (const m of matches) {
    if (!grouped[m.category]) grouped[m.category] = [];
    grouped[m.category].push(m.name);
  }

  return { detected: matches, grouped, count: matches.length };
}

module.exports = { detect };