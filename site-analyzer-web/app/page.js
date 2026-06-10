'use client';

import { useState, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';

// react-d3-tree uses document on import, so load it client-only.
const Tree = dynamic(() => import('react-d3-tree'), { ssr: false });

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// Estimated time per page in seconds. Tuned from observed runs:
// primary page (Lighthouse + axe + tokens + copy) ~60s
// secondary pages (tokens + copy only) ~25s
const PRIMARY_PAGE_SECONDS = 60;
const SECONDARY_PAGE_SECONDS = 25;
const SCOUT_SECONDS = 8;

export default function Home() {
  const [stage, setStage] = useState('input');
  const [url, setUrl] = useState('');
  const [scoutLoading, setScoutLoading] = useState(false);
  const [error, setError] = useState(null);

  const [scoutData, setScoutData] = useState(null);
  const [selectedUrls, setSelectedUrls] = useState(new Set());
  const [primaryUrl, setPrimaryUrl] = useState('');

  const [data, setData] = useState(null);

  // Progress state for analyzing stage
  const [elapsed, setElapsed] = useState(0); // seconds
  const [estimatedTotal, setEstimatedTotal] = useState(0); // seconds
  const [scoutElapsed, setScoutElapsed] = useState(0);
  const timerRef = useRef(null);

  function startTimer(onTick) {
    stopTimer();
    const startedAt = Date.now();
    timerRef.current = setInterval(() => {
      const secs = Math.floor((Date.now() - startedAt) / 1000);
      onTick(secs);
    }, 250);
  }

  function stopTimer() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  useEffect(() => () => stopTimer(), []);

  function estimateTotal(urls) {
    if (urls.length === 0) return 0;
    // First page = primary (full checks), rest are secondary
    return PRIMARY_PAGE_SECONDS + (urls.length - 1) * SECONDARY_PAGE_SECONDS + 10; // 10s buffer
  }

  function currentPageNumber(elapsedSecs, total) {
    if (total === 0) return 0;
    if (elapsedSecs < PRIMARY_PAGE_SECONDS) return 1;
    const afterPrimary = elapsedSecs - PRIMARY_PAGE_SECONDS;
    return Math.min(2 + Math.floor(afterPrimary / SECONDARY_PAGE_SECONDS), total);
  }

  function formatTime(secs) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  async function handleScout(e) {
    e.preventDefault();
    if (!url) return;
    setScoutLoading(true);
    setError(null);
    setScoutElapsed(0);
    startTimer(setScoutElapsed);

    try {
      const res = await fetch(`${API_URL}/api/scout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Scout failed');
      }
      const result = await res.json();
      const allLinks = new Set([result.startUrl, ...result.links]);
      const sorted = Array.from(allLinks).sort();
      setScoutData({ ...result, links: sorted });
      setPrimaryUrl(result.startUrl);
      setSelectedUrls(new Set([result.startUrl]));
      setStage('select');
    } catch (err) {
      setError(err.message);
    } finally {
      stopTimer();
      setScoutLoading(false);
    }
  }

  function toggleUrl(u) {
    const next = new Set(selectedUrls);
    if (next.has(u)) {
      if (u === primaryUrl) return;
      next.delete(u);
    } else {
      next.add(u);
    }
    setSelectedUrls(next);
  }

  function selectAll() {
    setSelectedUrls(new Set(scoutData.links));
  }

  function selectNone() {
    setSelectedUrls(new Set([primaryUrl]));
  }

  async function handleAnalyze() {
    if (selectedUrls.size === 0) return;
    setStage('analyzing');
    setError(null);
    setElapsed(0);

    const urls = Array.from(selectedUrls);
    const total = estimateTotal(urls);
    setEstimatedTotal(total);
    startTimer(setElapsed);

    try {
      const res = await fetch(`${API_URL}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls, primaryUrl }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Analysis failed');
      }
      const result = await res.json();
      setData(result);
      setStage('results');
    } catch (err) {
      setError(err.message);
      setStage('select');
    } finally {
      stopTimer();
    }
  }

  async function handleDownload() {
    if (!data) return;
    try {
      const res = await fetch(`${API_URL}/api/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const blob = await res.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      const hostname = new URL(data.primaryUrl).hostname.replace(/\./g, '-');
      a.download = `${hostname}-${Date.now()}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(downloadUrl);
    } catch (err) {
      setError('Download failed: ' + err.message);
    }
  }

  function reset() {
    stopTimer();
    setStage('input');
    setUrl('');
    setScoutData(null);
    setSelectedUrls(new Set());
    setPrimaryUrl('');
    setData(null);
    setError(null);
    setElapsed(0);
    setEstimatedTotal(0);
  }

  function scoreColor(score) {
    if (score >= 90) return 'text-emerald-700';
    if (score >= 50) return 'text-amber-700';
    return 'text-red-700';
  }

  function impactColor(impact) {
    if (impact === 'critical') return 'bg-red-100 text-red-900 border-red-300';
    if (impact === 'serious') return 'bg-orange-100 text-orange-900 border-orange-300';
    if (impact === 'moderate') return 'bg-amber-100 text-amber-900 border-amber-300';
    return 'bg-stone-100 text-stone-700 border-stone-300';
  }
  // Parse an rgb() or rgba() string into {r, g, b} 0-255 components.
  // Returns null if the string can't be parsed.
  function parseColor(str) {
    if (!str) return null;
    const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return null;
    return { r: parseInt(m[1]), g: parseInt(m[2]), b: parseInt(m[3]) };
  }

  // Compute relative luminance per WCAG formula.
  function luminance(rgb) {
    const norm = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * norm(rgb.r) + 0.7152 * norm(rgb.g) + 0.0722 * norm(rgb.b);
  }

  // WCAG contrast ratio between two colors. Returns a number like 4.52, or null if unparseable.
  function contrastRatio(fg, bg) {
    const fgc = parseColor(fg);
    const bgc = parseColor(bg);
    if (!fgc || !bgc) return null;
    const l1 = luminance(fgc);
    const l2 = luminance(bgc);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }
  // Convert a flat list of URLs into a tree structure for react-d3-tree.
  // Groups URLs by their path segments. Root = origin, branches = path depth.
  function buildSitemapTree(urls, primaryUrl) {
    if (!urls || urls.length === 0) return { name: 'empty', children: [] };

    let origin = '';
    try { origin = new URL(primaryUrl || urls[0]).origin; } catch { origin = 'site'; }

    const root = { name: origin.replace(/^https?:\/\//, ''), children: [], _path: '/' };

    urls.forEach(url => {
      let path;
      try {
        path = new URL(url).pathname;
      } catch {
        return;
      }
      if (path === '/' || path === '') return;

      const segments = path.split('/').filter(Boolean);
      let cursor = root;

      segments.forEach((segment, i) => {
        const currentPath = '/' + segments.slice(0, i + 1).join('/');
        let child = cursor.children.find(c => c._path === currentPath);
        if (!child) {
          child = { name: segment, children: [], _path: currentPath };
          cursor.children.push(child);
        }
        cursor = child;
      });
    });

    return root;
  }

  const primary = data?.pages?.find(p => p.url === data.primaryUrl) || data?.pages?.[0];

  // Progress calculations
  const progressPct = estimatedTotal > 0 ? Math.min(99, (elapsed / estimatedTotal) * 100) : 0;
  const currentPage = currentPageNumber(elapsed, selectedUrls.size);
  const remaining = Math.max(0, estimatedTotal - elapsed);

  // Scout progress
  const scoutPct = Math.min(95, (scoutElapsed / SCOUT_SECONDS) * 100);

  return (
    <main className="min-h-screen bg-[#faf8f3] text-[#1a1a1a]">
      <header className="border-b border-[#1a1a1a]/15 px-6 py-5">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3 cursor-pointer" onClick={reset}>
            <div className="w-2 h-2 bg-[#b8893d]"></div>
            <span className="font-mono text-xs tracking-widest uppercase">Site Analyzer</span>
          </div>
          <span className="font-mono text-xs tracking-widest uppercase text-[#1a1a1a]/60">
            {stage === 'input' && '/ 01 — enter url'}
            {stage === 'select' && '/ 02 — select pages'}
            {stage === 'analyzing' && '/ 03 — analyzing'}
            {stage === 'results' && '/ 04 — results'}
          </span>
        </div>
      </header>

      {/* STAGE: URL Input */}
      {stage === 'input' && (
        <section className="px-6 py-12">
          <div className="max-w-7xl mx-auto">
            <h1 className="text-4xl md:text-6xl font-light tracking-tight mb-2 leading-[1.05]">
              Analyze any site for <span className="italic text-[#b8893d]">performance, accessibility, and design.</span>
            </h1>
            <p className="text-sm md:text-base text-[#1a1a1a]/60 mt-4 max-w-2xl">
              Enter a homepage URL. The tool will scout internal pages, you pick which to analyze, then download a combined markdown report.
            </p>

            <form onSubmit={handleScout} className="mt-10 flex flex-col md:flex-row gap-3">
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com"
                required
                disabled={scoutLoading}
                className="flex-1 bg-transparent border border-[#1a1a1a]/30 px-4 py-3 text-base font-mono focus:outline-none focus:border-[#b8893d] disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={scoutLoading || !url}
                className="bg-[#1a1a1a] text-[#faf8f3] px-8 py-3 text-sm font-mono tracking-widest uppercase hover:bg-[#b8893d] transition-colors disabled:opacity-50 disabled:hover:bg-[#1a1a1a]"
              >
                {scoutLoading ? 'Scouting...' : 'Scout pages →'}
              </button>
            </form>

            {scoutLoading && (
              <div className="mt-6">
                <div className="flex items-baseline justify-between font-mono text-xs tracking-widest uppercase text-[#1a1a1a]/60 mb-2">
                  <span>Scanning for internal pages</span>
                  <span>{formatTime(scoutElapsed)}</span>
                </div>
                <div className="h-1 bg-[#1a1a1a]/10 overflow-hidden">
                  <div
                    className="h-full bg-[#b8893d] transition-all duration-200 ease-linear"
                    style={{ width: `${scoutPct}%` }}
                  />
                </div>
              </div>
            )}

            {error && (
              <div className="mt-6 border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
                {error}
              </div>
            )}
          </div>
        </section>
      )}

      {/* STAGE: Select pages */}
      {stage === 'select' && scoutData && (
        <section className="px-6 py-12">
          <div className="max-w-7xl mx-auto">
            <div className="flex items-baseline justify-between mb-2 flex-wrap gap-3">
              <h2 className="text-2xl md:text-4xl font-light tracking-tight">
                Found <span className="italic text-[#b8893d]">{scoutData.links.length} pages</span> on this site.
              </h2>
              <button onClick={reset} className="font-mono text-xs tracking-widest uppercase text-[#1a1a1a]/60 hover:text-[#b8893d]">
                ← Start over
              </button>
            </div>
            <p className="text-sm text-[#1a1a1a]/60 mt-2">
              Pick the pages you want analyzed. The primary page (highlighted) gets full Lighthouse + WCAG scoring. Other pages get tokens + copy extraction only.
            </p>

            <div className="mt-6 flex items-center gap-4 text-xs font-mono tracking-widest uppercase">
              <span className="text-[#1a1a1a]/60">{selectedUrls.size} selected</span>
              <button onClick={selectAll} className="text-[#1a1a1a] hover:text-[#b8893d]">Select all</button>
              <button onClick={selectNone} className="text-[#1a1a1a] hover:text-[#b8893d]">Primary only</button>
            </div>

            <div className="mt-6 border border-[#1a1a1a]/15 divide-y divide-[#1a1a1a]/10">
              {scoutData.links.map(linkUrl => {
                const isSelected = selectedUrls.has(linkUrl);
                const isPrimary = linkUrl === primaryUrl;
                const path = (() => {
                  try { return new URL(linkUrl).pathname || '/'; } catch { return linkUrl; }
                })();
                return (
                  <label
                    key={linkUrl}
                    className={`flex items-center gap-4 px-4 py-3 cursor-pointer hover:bg-white/40 ${isPrimary ? 'bg-[#b8893d]/5' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleUrl(linkUrl)}
                      disabled={isPrimary}
                      className="w-4 h-4 accent-[#b8893d]"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-sm truncate">{path}</div>
                      <div className="font-mono text-[10px] text-[#1a1a1a]/40 truncate">{linkUrl}</div>
                    </div>
                    {isPrimary && (
                      <span className="font-mono text-[10px] tracking-widest uppercase text-[#b8893d] border border-[#b8893d] px-2 py-0.5 shrink-0">
                        Primary
                      </span>
                    )}
                  </label>
                );
              })}
            </div>

            <div className="mt-8 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 border-t border-[#1a1a1a]/15 pt-6">
              <div className="font-mono text-xs text-[#1a1a1a]/60">
                Estimated time: ~{formatTime(estimateTotal(Array.from(selectedUrls)))}
              </div>
              <button
                onClick={handleAnalyze}
                disabled={selectedUrls.size === 0}
                className="bg-[#1a1a1a] text-[#faf8f3] px-8 py-3 text-sm font-mono tracking-widest uppercase hover:bg-[#b8893d] transition-colors disabled:opacity-50"
              >
                Analyze {selectedUrls.size} page{selectedUrls.size !== 1 ? 's' : ''} →
              </button>
            </div>

            {error && (
              <div className="mt-6 border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
                {error}
              </div>
            )}
          </div>
        </section>
      )}

      {/* STAGE: Analyzing with progress bar */}
      {stage === 'analyzing' && (
        <section className="px-6 py-16 md:py-24">
          <div className="max-w-3xl mx-auto">
            <div className="font-mono text-xs tracking-widest uppercase text-[#1a1a1a]/60 mb-6">
              / running analysis
            </div>

            <h2 className="text-3xl md:text-5xl font-light tracking-tight mb-2">
              Analyzing page <span className="italic text-[#b8893d]">{currentPage} of {selectedUrls.size}</span>
            </h2>
            <p className="text-sm text-[#1a1a1a]/60 mb-10">
              Don't close this tab. Browserless is running Lighthouse, WCAG checks, and content extraction on a real browser.
            </p>

            {/* Progress bar */}
            <div className="mb-3">
              <div className="h-2 bg-[#1a1a1a]/10 overflow-hidden">
                <div
                  className="h-full bg-[#b8893d] transition-all duration-200 ease-linear"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>

            <div className="flex items-baseline justify-between font-mono text-xs tracking-widest uppercase text-[#1a1a1a]/60">
              <span>{Math.round(progressPct)}% complete</span>
              <span>
                {formatTime(elapsed)} elapsed · ~{formatTime(remaining)} remaining
              </span>
            </div>

            {/* Page status list */}
            <div className="mt-10 border-t border-[#1a1a1a]/15 pt-6">
              <div className="font-mono text-[10px] tracking-widest uppercase text-[#1a1a1a]/60 mb-3">
                Pages
              </div>
              <div className="space-y-2">
                {Array.from(selectedUrls).map((u, i) => {
                  const pageNum = i + 1;
                  const isDone = pageNum < currentPage;
                  const isActive = pageNum === currentPage;
                  const isPending = pageNum > currentPage;
                  const isPrimary = u === primaryUrl;
                  const path = (() => {
                    try { return new URL(u).pathname || '/'; } catch { return u; }
                  })();
                  return (
                    <div
                      key={u}
                      className={`flex items-center gap-3 font-mono text-xs ${
                        isDone ? 'text-[#1a1a1a]/40' :
                        isActive ? 'text-[#1a1a1a]' :
                        'text-[#1a1a1a]/30'
                      }`}
                    >
                      <span className={`w-2 h-2 shrink-0 ${
                        isDone ? 'bg-[#1a1a1a]/30' :
                        isActive ? 'bg-[#b8893d] animate-pulse' :
                        'bg-[#1a1a1a]/10 border border-[#1a1a1a]/20'
                      }`} />
                      <span className="truncate flex-1">{path}</span>
                      {isPrimary && (
                        <span className="text-[10px] tracking-widest uppercase text-[#b8893d] shrink-0">primary</span>
                      )}
                      {isDone && <span className="text-[10px] tracking-widest uppercase text-[#1a1a1a]/40 shrink-0">done</span>}
                      {isActive && <span className="text-[10px] tracking-widest uppercase text-[#b8893d] shrink-0">running</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* STAGE: Results */}
      {stage === 'results' && data && primary && (
        <>
          <section className="border-b border-[#1a1a1a]/15 px-6 py-5 bg-[#1a1a1a]/[0.02]">
            <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
              <div className="font-mono text-xs tracking-widest uppercase text-[#1a1a1a]/60">
                <span className="text-[#1a1a1a]">{data.pages.length} pages</span> · {data.duration}
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={reset}
                  className="font-mono text-xs tracking-widest uppercase text-[#1a1a1a]/60 hover:text-[#b8893d]"
                >
                  ← New analysis
                </button>
                <button
                  onClick={handleDownload}
                  className="border border-[#1a1a1a] px-5 py-2 text-xs font-mono tracking-widest uppercase hover:bg-[#1a1a1a] hover:text-[#faf8f3] transition-colors"
                >
                  Download Report ↓
                </button>
              </div>
            </div>
          </section>

          <section className="border-b border-[#1a1a1a]/15 px-6 py-12">
            <div className="max-w-7xl mx-auto">
              <div className="font-mono text-xs tracking-widest uppercase text-[#1a1a1a]/60 mb-6">
                / 02 — scores · primary page
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-[#1a1a1a]/15">
                {[
                  ['Performance', primary.scores.performance],
                  ['Accessibility', primary.scores.accessibility],
                  ['SEO', primary.scores.seo],
                  ['Best Practices', primary.scores.bestPractices],
                ].map(([label, score]) => (
                  <div key={label} className="bg-[#faf8f3] p-6 md:p-8">
                    <div className={`text-5xl md:text-7xl font-light tracking-tight ${scoreColor(score)}`}>
                      {score}
                    </div>
                    <div className="font-mono text-[10px] tracking-widest uppercase text-[#1a1a1a]/60 mt-4">
                      {label}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {primary.techStack && primary.techStack.count > 0 && (
            <section className="border-b border-[#1a1a1a]/15 px-6 py-12">
              <div className="max-w-7xl mx-auto">
                <div className="flex items-baseline justify-between mb-6">
                  <div className="font-mono text-xs tracking-widest uppercase text-[#1a1a1a]/60">
                    / tech stack · primary page
                  </div>
                  <div className="font-mono text-xs tracking-widest text-[#1a1a1a]/60">
                    {primary.techStack.count} detected
                  </div>
                </div>
                <div className="grid md:grid-cols-3 gap-px bg-[#1a1a1a]/15">
                  {Object.entries(primary.techStack.grouped).map(([category, items]) => (
                    <div key={category} className="bg-[#faf8f3] p-6">
                      <h3 className="font-mono text-[10px] tracking-widest uppercase text-[#1a1a1a]/60 mb-4">
                        {category}
                      </h3>
                      <div className="space-y-1">
                        {items.map((name) => (
                          <div key={name} className="text-sm">{name}</div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          <section className="border-b border-[#1a1a1a]/15 px-6 py-12">
            <div className="max-w-7xl mx-auto">
              <div className="flex items-baseline justify-between mb-6">
                <div className="font-mono text-xs tracking-widest uppercase text-[#1a1a1a]/60">
                  / 03 — wcag violations · primary page
                </div>
                <div className="font-mono text-xs tracking-widest text-[#1a1a1a]/60">
                  {primary.violations.length} found
                </div>
              </div>

              {primary.violations.length === 0 ? (
                <p className="text-sm text-[#1a1a1a]/60 italic">No violations detected.</p>
              ) : (
                <div className="space-y-3">
                  {primary.violations.map((v) => (
                    <div key={v.id} className="border border-[#1a1a1a]/15 p-4 bg-white/40">
                      <div className="flex flex-wrap items-baseline gap-3 mb-2">
                        <span className={`font-mono text-[10px] tracking-widest uppercase border px-2 py-0.5 ${impactColor(v.impact)}`}>
                          {v.impact}
                        </span>
                        <span className="font-mono text-sm">{v.id}</span>
                        <span className="text-xs text-[#1a1a1a]/60">{v.nodeCount} element{v.nodeCount !== 1 ? 's' : ''}</span>
                      </div>
                      <p className="text-sm text-[#1a1a1a]/80 mb-1">{v.description}</p>
                      <a href={v.helpUrl} target="_blank" rel="noopener noreferrer" className="text-xs font-mono text-[#b8893d] hover:underline">
                        View fix guide →
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {primary.http && (
            <section className="border-b border-[#1a1a1a]/15 px-6 py-12">
              <div className="max-w-7xl mx-auto">
                <div className="font-mono text-xs tracking-widest uppercase text-[#1a1a1a]/60 mb-6">
                  / http · primary page
                </div>

                {primary.http.redirects && primary.http.redirects.length > 1 && (
                  <div className="mb-8">
                    <h3 className="font-mono text-[10px] tracking-widest uppercase text-[#1a1a1a]/60 mb-3">
                      Redirect chain ({primary.http.redirects.length} hops)
                    </h3>
                    <div className="border border-[#1a1a1a]/15 divide-y divide-[#1a1a1a]/10 bg-white/40">
                      {primary.http.redirects.map((hop, i) => (
                        <div key={i} className="px-4 py-2 font-mono text-xs flex items-center gap-3">
                          <span className="text-[#1a1a1a]/40 w-6">{i + 1}.</span>
                          <span className={`shrink-0 w-12 ${hop.status >= 400 ? 'text-red-700' : hop.status >= 300 ? 'text-amber-700' : 'text-emerald-700'}`}>
                            {hop.status || 'ERR'}
                          </span>
                          <span className="truncate">{hop.url}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <h3 className="font-mono text-[10px] tracking-widest uppercase text-[#1a1a1a]/60 mb-3">
                  Response headers
                </h3>
                <div className="border border-[#1a1a1a]/15 bg-white/40 divide-y divide-[#1a1a1a]/10">
                  {Object.entries(primary.http.headers || {}).map(([key, value]) => (
                    <div key={key} className="px-4 py-2 font-mono text-xs flex gap-4">
                      <span className="text-[#1a1a1a]/60 w-48 shrink-0 truncate">{key}</span>
                      <span className="break-all flex-1">{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {(primary.robots || primary.sitemap) && (
            <section className="border-b border-[#1a1a1a]/15 px-6 py-12">
              <div className="max-w-7xl mx-auto">
                <div className="font-mono text-xs tracking-widest uppercase text-[#1a1a1a]/60 mb-6">
                  / crawl · primary page
                </div>

                <div className="grid md:grid-cols-2 gap-px bg-[#1a1a1a]/15">
                  <div className="bg-[#faf8f3] p-6">
                    <div className="flex items-baseline justify-between mb-3">
                      <h3 className="font-mono text-[10px] tracking-widest uppercase text-[#1a1a1a]/60">
                        robots.txt
                      </h3>
                      <span className={`font-mono text-[10px] tracking-widest uppercase ${primary.robots?.found ? 'text-emerald-700' : 'text-red-700'}`}>
                        {primary.robots?.found ? 'Found' : 'Missing'}
                      </span>
                    </div>
                    {primary.robots?.found ? (
                      <pre className="font-mono text-xs bg-white/60 border border-[#1a1a1a]/10 p-3 overflow-x-auto whitespace-pre-wrap break-all">{primary.robots.content}</pre>
                    ) : (
                      <p className="text-xs text-[#1a1a1a]/60 italic">No robots.txt at site root.</p>
                    )}
                  </div>

                  <div className="bg-[#faf8f3] p-6">
                    <div className="flex items-baseline justify-between mb-3">
                      <h3 className="font-mono text-[10px] tracking-widest uppercase text-[#1a1a1a]/60">
                        sitemap.xml
                      </h3>
                      <span className={`font-mono text-[10px] tracking-widest uppercase ${primary.sitemap?.found ? 'text-emerald-700' : 'text-red-700'}`}>
                        {primary.sitemap?.found ? `${primary.sitemap.urlCount} URLs` : 'Missing'}
                      </span>
                    </div>
                    {primary.sitemap?.found ? (
                      <div className="border border-[#1a1a1a]/10 bg-white/60 max-h-64 overflow-y-auto">
                        {primary.sitemap.urls.slice(0, 30).map((u, i) => (
                          <div key={i} className="px-3 py-1.5 font-mono text-xs truncate border-b border-[#1a1a1a]/5 last:border-b-0">{u}</div>
                        ))}
                        {primary.sitemap.urls.length > 30 && (
                          <div className="px-3 py-2 font-mono text-[10px] text-[#1a1a1a]/40">+ {primary.sitemap.urls.length - 30} more</div>
                        )}
                      </div>
                    ) : (
                      <p className="text-xs text-[#1a1a1a]/60 italic">No sitemap.xml at site root.</p>
                    )}
                  </div>
                </div>
              </div>
            </section>
          )}
          {primary.sitemap?.found && primary.sitemap?.urls?.length > 1 && (
            <section className="border-b border-[#1a1a1a]/15 px-6 py-12">
              <div className="max-w-7xl mx-auto">
                <div className="flex items-baseline justify-between mb-6">
                  <div className="font-mono text-xs tracking-widest uppercase text-[#1a1a1a]/60">
                    / sitemap diagram · primary page
                  </div>
                  <div className="font-mono text-xs tracking-widest text-[#1a1a1a]/60">
                    {primary.sitemap.urls.length} URLs · drag to pan · scroll to zoom
                  </div>
                </div>

                <div className="border border-[#1a1a1a]/15 bg-white/40" style={{ height: '500px' }}>
                  <Tree
                    data={buildSitemapTree(primary.sitemap.urls, primary.url)}
                    orientation="vertical"
                    pathFunc="step"
                    translate={{ x: 500, y: 80 }}
                    nodeSize={{ x: 180, y: 90 }}
                    separation={{ siblings: 1, nonSiblings: 1.8 }}
                    collapsible={true}
                    initialDepth={2}
                    zoom={0.7}
                    renderCustomNodeElement={({ nodeDatum, toggleNode }) => {
                      const childCount = nodeDatum.children?.length || nodeDatum._children?.length || 0;
                      const isCollapsed = nodeDatum.__rd3t?.collapsed;
                      const fullLabel = nodeDatum.name;
                      const truncatedLabel = fullLabel.length > 18 ? fullLabel.slice(0, 17) + '…' : fullLabel;
                      const isTruncated = fullLabel.length > 18;
                      const countLabel = childCount > 0 ? ` (${childCount})` : '';
                      const displayText = truncatedLabel + countLabel;
                      const charWidth = 6.8;
                      const padding = 20;
                      const textWidth = Math.max(displayText.length * charWidth + padding, 80);

                      let bgFill, textColor, strokeColor, strokeWidth;
                      if (childCount === 0) {
                        bgFill = '#faf8f3';
                        textColor = '#1a1a1a';
                        strokeColor = '#1a1a1a';
                        strokeWidth = 1;
                      } else if (isCollapsed) {
                        bgFill = '#b8893d';
                        textColor = '#faf8f3';
                        strokeColor = '#b8893d';
                        strokeWidth = 0;
                      } else {
                        bgFill = '#4a7c4e';
                        textColor = '#faf8f3';
                        strokeColor = '#4a7c4e';
                        strokeWidth = 0;
                      }

                      return (
                        <g onClick={toggleNode} style={{ cursor: childCount > 0 ? 'pointer' : 'default' }}>
                          <rect
                            x={-textWidth / 2}
                            y={-14}
                            width={textWidth}
                            height={28}
                            fill={bgFill}
                            stroke={strokeColor}
                            strokeWidth={strokeWidth}
                            rx={0}
                          />
                          <text
                            fill={textColor}
                            x={0}
                            y={5}
                            textAnchor="middle"
                            style={{ fontSize: '11px', fontFamily: 'monospace', fontWeight: 400 }}
                          >
                            {truncatedLabel}
                            {childCount > 0 && (
                              <tspan opacity={0.6} dx={4} style={{ fontSize: '9px' }}>
                                ({childCount})
                              </tspan>
                            )}
                          </text>
                          {isTruncated && (
                            <title>{fullLabel}</title>
                          )}
                        </g>
                      );
                    }}
                  />
                </div>
              </div>
            </section>
          )}

          {primary.linkCheck && (
            <section className="border-b border-[#1a1a1a]/15 px-6 py-12">
              <div className="max-w-7xl mx-auto">
                <div className="flex items-baseline justify-between mb-6">
                  <div className="font-mono text-xs tracking-widest uppercase text-[#1a1a1a]/60">
                    / links · primary page
                  </div>
                  <div className="font-mono text-xs tracking-widest text-[#1a1a1a]/60">
                    {primary.linkCheck.total} checked · {primary.linkCheck.broken} broken
                  </div>
                </div>

                {primary.linkCheck.broken === 0 ? (
                  <p className="text-sm text-[#1a1a1a]/60 italic">All links responded with 2xx or 3xx status codes.</p>
                ) : (
                  <div className="space-y-2">
                    {primary.linkCheck.brokenLinks.map((link, i) => (
                      <div key={i} className="border border-[#1a1a1a]/15 bg-white/40 px-4 py-3 font-mono text-xs flex items-center gap-4">
                        <span className={`shrink-0 w-12 ${link.status >= 500 ? 'text-red-700' : link.status >= 400 ? 'text-amber-700' : 'text-red-700'}`}>
                          {link.status || 'ERR'}
                        </span>
                        <span className="truncate flex-1">{link.url}</span>
                        {link.error && <span className="text-[#1a1a1a]/40 text-[10px] shrink-0">{link.error}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          {primary.imageAudit && (
            <section className="border-b border-[#1a1a1a]/15 px-6 py-12">
              <div className="max-w-7xl mx-auto">
                <div className="flex items-baseline justify-between mb-6">
                  <div className="font-mono text-xs tracking-widest uppercase text-[#1a1a1a]/60">
                    / images · primary page
                  </div>
                  <div className="font-mono text-xs tracking-widest text-[#1a1a1a]/60">
                    {primary.imageAudit.total} total
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-[#1a1a1a]/15 mb-6">
                  <div className="bg-[#faf8f3] p-4">
                    <div className={`text-3xl font-light ${primary.imageAudit.missingAlt > 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                      {primary.imageAudit.missingAlt}
                    </div>
                    <div className="font-mono text-[10px] tracking-widest uppercase text-[#1a1a1a]/60 mt-2">Missing alt</div>
                  </div>
                  <div className="bg-[#faf8f3] p-4">
                    <div className={`text-3xl font-light ${primary.imageAudit.emptyAlt > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
                      {primary.imageAudit.emptyAlt}
                    </div>
                    <div className="font-mono text-[10px] tracking-widest uppercase text-[#1a1a1a]/60 mt-2">Empty alt</div>
                  </div>
                  <div className="bg-[#faf8f3] p-4">
                    <div className={`text-3xl font-light ${primary.imageAudit.notLazyLoaded > primary.imageAudit.total / 2 ? 'text-amber-700' : 'text-emerald-700'}`}>
                      {primary.imageAudit.notLazyLoaded}
                    </div>
                    <div className="font-mono text-[10px] tracking-widest uppercase text-[#1a1a1a]/60 mt-2">Not lazy</div>
                  </div>
                  <div className="bg-[#faf8f3] p-4">
                    <div className={`text-3xl font-light ${primary.imageAudit.oversized > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
                      {primary.imageAudit.oversized}
                    </div>
                    <div className="font-mono text-[10px] tracking-widest uppercase text-[#1a1a1a]/60 mt-2">Oversized</div>
                  </div>
                </div>

                {primary.imageAudit.formatBreakdown && Object.keys(primary.imageAudit.formatBreakdown).length > 0 && (
                  <div>
                    <h3 className="font-mono text-[10px] tracking-widest uppercase text-[#1a1a1a]/60 mb-3">
                      Format breakdown
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(primary.imageAudit.formatBreakdown).map(([format, count]) => (
                        <div key={format} className="border border-[#1a1a1a]/15 bg-white/40 px-3 py-1.5 font-mono text-xs">
                          <span className="uppercase">{format}</span>
                          <span className="text-[#1a1a1a]/60 ml-2">{count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {primary.ariaReport && (
            <section className="border-b border-[#1a1a1a]/15 px-6 py-12">
              <div className="max-w-7xl mx-auto">
                <div className="font-mono text-xs tracking-widest uppercase text-[#1a1a1a]/60 mb-6">
                  / accessibility · primary page
                </div>

                <div className="grid md:grid-cols-3 gap-px bg-[#1a1a1a]/15 mb-6">
                  <div className="bg-[#faf8f3] p-6">
                    <h3 className="font-mono text-[10px] tracking-widest uppercase text-[#1a1a1a]/60 mb-4">
                      Landmarks
                    </h3>
                    <div className="space-y-2">
                      {Object.entries(primary.ariaReport.landmarks).map(([name, count]) => (
                        <div key={name} className="flex items-center justify-between font-mono text-xs">
                          <span className="capitalize">{name}</span>
                          <span className={count === 0 && ['main', 'nav'].includes(name) ? 'text-red-700' : count === 0 ? 'text-[#1a1a1a]/40' : 'text-emerald-700'}>
                            {count}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="bg-[#faf8f3] p-6">
                    <h3 className="font-mono text-[10px] tracking-widest uppercase text-[#1a1a1a]/60 mb-4">
                      Headings
                    </h3>
                    <div className="space-y-2">
                      {Object.entries(primary.ariaReport.headings).map(([level, count]) => (
                        <div key={level} className="flex items-center justify-between font-mono text-xs">
                          <span className="uppercase">{level}</span>
                          <span className={count === 0 ? 'text-[#1a1a1a]/40' : 'text-[#1a1a1a]'}>{count}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="bg-[#faf8f3] p-6">
                    <h3 className="font-mono text-[10px] tracking-widest uppercase text-[#1a1a1a]/60 mb-4">
                      ARIA attributes
                    </h3>
                    <div className="space-y-2 font-mono text-xs">
                      <div className="flex items-center justify-between">
                        <span>aria-label</span>
                        <span>{primary.ariaReport.ariaLabels}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>aria-labelledby</span>
                        <span>{primary.ariaReport.ariaLabelledby}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>aria-describedby</span>
                        <span>{primary.ariaReport.ariaDescribedby}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>aria-hidden</span>
                        <span>{primary.ariaReport.ariaHidden}</span>
                      </div>
                      <div className="flex items-center justify-between pt-2 mt-2 border-t border-[#1a1a1a]/10">
                        <span>Skip link</span>
                        <span className={primary.ariaReport.hasSkipLink ? 'text-emerald-700' : 'text-amber-700'}>
                          {primary.ariaReport.hasSkipLink ? 'Yes' : 'No'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>lang attr</span>
                        <span className={primary.ariaReport.hasLangAttr ? 'text-emerald-700' : 'text-red-700'}>
                          {primary.ariaReport.hasLangAttr ? 'Yes' : 'No'}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {Object.keys(primary.ariaReport.roles).length > 0 && (
                  <div>
                    <h3 className="font-mono text-[10px] tracking-widest uppercase text-[#1a1a1a]/60 mb-3">
                      ARIA roles in use
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(primary.ariaReport.roles).map(([role, count]) => (
                        <div key={role} className="border border-[#1a1a1a]/15 bg-white/40 px-3 py-1.5 font-mono text-xs">
                          <span>{role}</span>
                          <span className="text-[#1a1a1a]/60 ml-2">{count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {primary.formAudit && primary.formAudit.total > 0 && (
            <section className="border-b border-[#1a1a1a]/15 px-6 py-12">
              <div className="max-w-7xl mx-auto">
                <div className="flex items-baseline justify-between mb-6">
                  <div className="font-mono text-xs tracking-widest uppercase text-[#1a1a1a]/60">
                    / forms · primary page
                  </div>
                  <div className="font-mono text-xs tracking-widest text-[#1a1a1a]/60">
                    {primary.formAudit.total} form{primary.formAudit.total !== 1 ? 's' : ''} · {primary.formAudit.totalInputs} input{primary.formAudit.totalInputs !== 1 ? 's' : ''}
                  </div>
                </div>

                <div className="space-y-4">
                  {primary.formAudit.forms.map((form, i) => (
                    <div key={i} className="border border-[#1a1a1a]/15 bg-white/40 p-5">
                      <div className="flex flex-wrap items-baseline gap-3 mb-4 pb-3 border-b border-[#1a1a1a]/10">
                        <span className="font-mono text-[10px] tracking-widest uppercase text-[#b8893d]">
                          Form {i + 1}
                        </span>
                        <span className="font-mono text-xs text-[#1a1a1a]/60">
                          {form.method.toUpperCase()} · {form.inputCount} inputs
                        </span>
                        {form.action && (
                          <span className="font-mono text-[10px] text-[#1a1a1a]/40 truncate">→ {form.action}</span>
                        )}
                        {form.unlabeled > 0 && (
                          <span className="font-mono text-[10px] tracking-widest uppercase text-red-700 border border-red-300 px-2 py-0.5">
                            {form.unlabeled} unlabeled
                          </span>
                        )}
                        {form.missingAutocomplete > 0 && (
                          <span className="font-mono text-[10px] tracking-widest uppercase text-amber-700 border border-amber-300 px-2 py-0.5">
                            {form.missingAutocomplete} missing autocomplete
                          </span>
                        )}
                      </div>

                      <div className="space-y-2">
                        {form.inputs.map((input, j) => (
                          <div key={j} className="flex items-center gap-3 font-mono text-xs">
                            <span className="text-[#1a1a1a]/60 w-20 shrink-0 truncate">{input.type}</span>
                            <span className="flex-1 truncate">
                              {input.name || input.id || <span className="text-[#1a1a1a]/40 italic">unnamed</span>}
                            </span>
                            {input.required && (
                              <span className="text-[10px] tracking-widest uppercase text-[#b8893d] shrink-0">req</span>
                            )}
                            {!input.hasLabel && (
                              <span className="text-[10px] tracking-widest uppercase text-red-700 shrink-0">no label</span>
                            )}
                            {input.hasAutocomplete && (
                              <span className="text-[10px] text-[#1a1a1a]/40 shrink-0 truncate">auto: {input.autocomplete}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {primary.contrastPairs && primary.contrastPairs.length > 0 && (
            <section className="border-b border-[#1a1a1a]/15 px-6 py-12">
              <div className="max-w-7xl mx-auto">
                <div className="flex items-baseline justify-between mb-6">
                  <div className="font-mono text-xs tracking-widest uppercase text-[#1a1a1a]/60">
                    / contrast pairs · primary page
                  </div>
                  <div className="font-mono text-xs tracking-widest text-[#1a1a1a]/60">
                    {primary.contrastPairs.length} pairs
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {primary.contrastPairs.map((pair, i) => {
                    const ratio = contrastRatio(pair.foreground, pair.background);
                    const ratioStr = ratio ? ratio.toFixed(2) : '—';
                    const passAA = ratio && ratio >= 4.5;
                    const passAAA = ratio && ratio >= 7;
                    const passAALarge = ratio && ratio >= 3;
                    return (
                      <div key={i} className="border border-[#1a1a1a]/15 bg-white/40 flex items-stretch">
                        <div
                          className="flex-1 px-4 py-3 flex items-center justify-center font-mono text-sm"
                          style={{ color: pair.foreground, backgroundColor: pair.background }}
                        >
                          Aa sample
                        </div>
                        <div className="px-4 py-3 bg-[#faf8f3] border-l border-[#1a1a1a]/10 flex flex-col justify-center min-w-[200px]">
                          <div className="flex items-baseline justify-between mb-1">
                            <span className="font-mono text-sm">{ratioStr}<span className="text-[#1a1a1a]/40">:1</span></span>
                            <div className="flex gap-1">
                              <span className={`font-mono text-[9px] tracking-widest uppercase border px-1.5 py-0.5 ${passAA ? 'text-emerald-700 border-emerald-300' : 'text-red-700 border-red-300'}`}>
                                AA {passAA ? '✓' : '✗'}
                              </span>
                              <span className={`font-mono text-[9px] tracking-widest uppercase border px-1.5 py-0.5 ${passAAA ? 'text-emerald-700 border-emerald-300' : 'text-[#1a1a1a]/40 border-[#1a1a1a]/15'}`}>
                                AAA {passAAA ? '✓' : '✗'}
                              </span>
                            </div>
                          </div>
                          <div className="font-mono text-[10px] text-[#1a1a1a]/60 truncate">FG: {pair.foreground}</div>
                          <div className="font-mono text-[10px] text-[#1a1a1a]/60 truncate">BG: {pair.background}</div>
                          <div className="font-mono text-[10px] text-[#1a1a1a]/40 mt-1">{pair.count}× used{!passAA && passAALarge && ' · ok for large text'}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
          )}

          {primary.fontLoading && (
            (primary.fontLoading.preloadLinks.length > 0 ||
             primary.fontLoading.googleFontLinks.length > 0 ||
             primary.fontLoading.fontFaceRules.length > 0) && (
              <section className="border-b border-[#1a1a1a]/15 px-6 py-12">
                <div className="max-w-7xl mx-auto">
                  <div className="flex items-baseline justify-between mb-6">
                    <div className="font-mono text-xs tracking-widest uppercase text-[#1a1a1a]/60">
                      / font loading · primary page
                    </div>
                    <div className="font-mono text-xs tracking-widest text-[#1a1a1a]/60">
                      font-display: <span className={primary.fontLoading.hasFontDisplay ? 'text-emerald-700' : 'text-amber-700'}>{primary.fontLoading.hasFontDisplay ? 'set' : 'unset'}</span>
                    </div>
                  </div>

                  {primary.fontLoading.googleFontLinks.length > 0 && (
                    <div className="mb-6">
                      <h3 className="font-mono text-[10px] tracking-widest uppercase text-[#1a1a1a]/60 mb-3">
                        Google Fonts ({primary.fontLoading.googleFontLinks.length})
                      </h3>
                      <div className="border border-[#1a1a1a]/15 bg-white/40 divide-y divide-[#1a1a1a]/10">
                        {primary.fontLoading.googleFontLinks.map((href, i) => (
                          <div key={i} className="px-4 py-2 font-mono text-xs truncate">{href}</div>
                        ))}
                      </div>
                    </div>
                  )}

                  {primary.fontLoading.preloadLinks.length > 0 && (
                    <div className="mb-6">
                      <h3 className="font-mono text-[10px] tracking-widest uppercase text-[#1a1a1a]/60 mb-3">
                        Preload links ({primary.fontLoading.preloadLinks.length})
                      </h3>
                      <div className="border border-[#1a1a1a]/15 bg-white/40 divide-y divide-[#1a1a1a]/10">
                        {primary.fontLoading.preloadLinks.map((link, i) => (
                          <div key={i} className="px-4 py-2 font-mono text-xs">
                            <span className="text-[#1a1a1a]/60 mr-2">{link.rel}</span>
                            <span className="truncate">{link.href}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {primary.fontLoading.fontFaceRules.length > 0 && (
                    <div>
                      <h3 className="font-mono text-[10px] tracking-widest uppercase text-[#1a1a1a]/60 mb-3">
                        @font-face rules ({primary.fontLoading.fontFaceRules.length})
                      </h3>
                      <div className="border border-[#1a1a1a]/15 bg-white/40 divide-y divide-[#1a1a1a]/10">
                        {primary.fontLoading.fontFaceRules.map((rule, i) => (
                          <div key={i} className="px-4 py-2 font-mono text-xs flex gap-4">
                            <span className="w-48 shrink-0 truncate">{rule.family || <span className="text-[#1a1a1a]/40 italic">unnamed</span>}</span>
                            <span className="text-[#1a1a1a]/60 w-24 shrink-0">{rule.display}</span>
                            <span className="text-[#1a1a1a]/40 truncate flex-1">{rule.src}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </section>
            )
          )}

          {primary.structure && primary.structure.length > 0 && (
            <section className="border-b border-[#1a1a1a]/15 px-6 py-12">
              <div className="max-w-7xl mx-auto">
                <div className="flex items-baseline justify-between mb-6">
                  <div className="font-mono text-xs tracking-widest uppercase text-[#1a1a1a]/60">
                    / structure · primary page
                  </div>
                  <div className="font-mono text-xs tracking-widest text-[#1a1a1a]/60">
                    {primary.structure.length} semantic region{primary.structure.length !== 1 ? 's' : ''}
                  </div>
                </div>

                <div className="space-y-2">
                  {primary.structure.map((region, i) => (
                    <div key={i} className="border border-[#1a1a1a]/15 bg-white/40 p-4">
                      <div className="flex flex-wrap items-baseline gap-3 mb-2">
                        <span className="font-mono text-xs tracking-widest uppercase text-[#b8893d]">
                          &lt;{region.tag}&gt;
                        </span>
                        {region.role && (
                          <span className="font-mono text-[10px] text-[#1a1a1a]/60">role={region.role}</span>
                        )}
                        {region.ariaLabel && (
                          <span className="font-mono text-[10px] text-[#1a1a1a]/60">aria-label="{region.ariaLabel}"</span>
                        )}
                        {region.firstHeading && (
                          <span className="text-sm">{region.firstHeading}</span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-4 font-mono text-[10px] text-[#1a1a1a]/60">
                        <span>{region.childCount} children</span>
                        {region.imageCount > 0 && <span>{region.imageCount} img</span>}
                        {region.linkCount > 0 && <span>{region.linkCount} links</span>}
                        {region.buttonCount > 0 && <span>{region.buttonCount} buttons</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          <section className="border-b border-[#1a1a1a]/15 px-6 py-12">
            <div className="max-w-7xl mx-auto">
              <div className="font-mono text-xs tracking-widest uppercase text-[#1a1a1a]/60 mb-6">
                / 04 — design tokens · primary page
              </div>

              <div className="grid md:grid-cols-3 gap-px bg-[#1a1a1a]/15">
                <div className="bg-[#faf8f3] p-6">
                  <h3 className="font-mono text-[10px] tracking-widest uppercase text-[#1a1a1a]/60 mb-4">
                    Colors ({primary.tokens.colors.length})
                  </h3>
                  <div className="space-y-2">
                    {primary.tokens.colors.map((c, i) => (
                      <div key={i} className="flex items-center gap-3">
                        <div className="w-8 h-8 border border-[#1a1a1a]/15 shrink-0" style={{ backgroundColor: c.value }} />
                        <div className="flex-1 min-w-0">
                          <div className="font-mono text-xs">{c.value}</div>
                          <div className="font-mono text-[10px] text-[#1a1a1a]/60">{c.count}×</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="bg-[#faf8f3] p-6">
                  <h3 className="font-mono text-[10px] tracking-widest uppercase text-[#1a1a1a]/60 mb-4">
                    Fonts ({primary.tokens.fonts.length})
                  </h3>
                  <div className="space-y-3">
                    {primary.tokens.fonts.map((f, i) => (
                      <div key={i}>
                        <div className="text-sm truncate" style={{ fontFamily: f.value }}>{f.value}</div>
                        <div className="font-mono text-[10px] text-[#1a1a1a]/60 mt-0.5">{f.count}×</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="bg-[#faf8f3] p-6">
                  <h3 className="font-mono text-[10px] tracking-widest uppercase text-[#1a1a1a]/60 mb-4">
                    Spacing ({primary.tokens.spacing.length})
                  </h3>
                  <div className="space-y-2">
                    {primary.tokens.spacing.map((s, i) => (
                      <div key={i} className="flex items-center justify-between">
                        <span className="font-mono text-xs">{s.value}</span>
                        <span className="font-mono text-[10px] text-[#1a1a1a]/60">{s.count}×</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="px-6 py-12">
            <div className="max-w-7xl mx-auto">
              <div className="font-mono text-xs tracking-widest uppercase text-[#1a1a1a]/60 mb-6">
                / 05 — content · all pages
              </div>

              <div className="space-y-4">
                {data.pages.map((p, i) => (
                  <div key={i} className="border border-[#1a1a1a]/15 p-5 bg-white/40">
                    <div className="flex flex-wrap items-baseline justify-between gap-3 mb-3">
                      <div className="flex items-center gap-3 min-w-0">
                        {p.isPrimary && (
                          <span className="font-mono text-[10px] tracking-widest uppercase text-[#b8893d] border border-[#b8893d] px-2 py-0.5 shrink-0">
                            Primary
                          </span>
                        )}
                        <div className="font-mono text-sm truncate">{p.url}</div>
                      </div>
                      {p.copy?.stats && (
                        <div className="font-mono text-[10px] tracking-widest uppercase text-[#1a1a1a]/60">
                          {p.copy.stats.wordCount} words · {p.copy.stats.readingTimeMinutes}m read
                        </div>
                      )}
                    </div>

                    {p.error ? (
                      <p className="text-xs text-red-700 font-mono">Failed: {p.error}</p>
                    ) : (
                      <>
                        {p.copy?.meta?.title && (
                          <p className="text-sm mb-1"><span className="font-mono text-[10px] text-[#1a1a1a]/60 mr-2">TITLE</span>{p.copy.meta.title}</p>
                        )}
                        {p.copy?.meta?.description && (
                          <p className="text-xs text-[#1a1a1a]/70 line-clamp-2"><span className="font-mono text-[10px] text-[#1a1a1a]/60 mr-2">DESC</span>{p.copy.meta.description}</p>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </section>

          <footer className="border-t border-[#1a1a1a]/15 px-6 py-6">
            <div className="max-w-7xl mx-auto flex items-center justify-between font-mono text-[10px] tracking-widest uppercase text-[#1a1a1a]/40">
              <span>Built with Browserless + Lighthouse + axe-core</span>
              <span>by Ashlen Singh</span>
            </div>
          </footer>
        </>
      )}
    </main>
  );
}