'use client';

import { useState, useEffect, useRef } from 'react';

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