import express from 'express';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Recursively parse a sitemap URL and collect all page URLs
async function parseSitemap(sitemapUrl, collected, depth = 0) {
  if (depth > 3) return;
  const response = await axios.get(sitemapUrl, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PerfMonitor/1.0)' },
  });
  const result = await parseStringPromise(response.data, { explicitArray: true });

  if (result.urlset && result.urlset.url) {
    for (const entry of result.urlset.url) {
      const loc = entry.loc?.[0];
      if (loc) collected.add(loc.trim());
    }
  } else if (result.sitemapindex && result.sitemapindex.sitemap) {
    for (const sitemap of result.sitemapindex.sitemap) {
      const loc = sitemap.loc?.[0];
      if (loc) {
        try { await parseSitemap(loc.trim(), collected, depth + 1); } catch {}
      }
    }
  }
}

async function discoverSitemapUrls(baseUrl) {
  const candidates = [];

  // Try robots.txt first
  try {
    const robots = await axios.get(`${baseUrl}/robots.txt`, { timeout: 8000 });
    const matches = robots.data.match(/^Sitemap:\s*(.+)$/gim) || [];
    for (const m of matches) {
      const url = m.replace(/^Sitemap:\s*/i, '').trim();
      if (url) candidates.push(url);
    }
  } catch {}

  if (candidates.length === 0) {
    candidates.push(`${baseUrl}/sitemap.xml`);
  }

  const collected = new Set();
  for (const candidate of candidates) {
    try { await parseSitemap(candidate, collected); } catch {}
  }
  return [...collected];
}

// --- Routes ---

app.post('/api/sitemap', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    const base = url.replace(/\/$/, '');
    const urls = await discoverSitemapUrls(base);
    if (urls.length === 0) {
      return res.status(404).json({ error: 'No URLs found in sitemap. The site may not have a sitemap.xml or robots.txt Sitemap directive.' });
    }
    res.json({ urls, count: urls.length });
  } catch (err) {
    res.status(500).json({ error: `Sitemap fetch failed: ${err.message}` });
  }
});

app.post('/api/audit', async (req, res) => {
  const { urls, device = 'desktop' } = req.body;
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls array is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const isMobile = device === 'mobile';
  const results = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    send({ type: 'progress', current: i + 1, total: urls.length, url });

    let chrome;
    try {
     chrome = await chromeLauncher.launch({
  chromePath: process.env.CHROME_PATH || undefined,
  chromeFlags: [
    '--headless',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu'
  ],
});

      const lhOptions = {
        logLevel: 'error',
        output: 'json',
        onlyCategories: ['performance'],
        port: chrome.port,
        formFactor: isMobile ? 'mobile' : 'desktop',
        screenEmulation: isMobile
          ? { mobile: true, width: 375, height: 812, deviceScaleFactor: 3, disabled: false }
          : { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
        throttling: isMobile
          ? undefined
          : { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1, requestLatencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0 },
      };

      const run = await lighthouse(url, lhOptions);
      await chrome.kill();
      chrome = null;

      const { audits, categories } = run.lhr;

      const metric = (key) => ({
        display: audits[key]?.displayValue ?? 'N/A',
        numericValue: audits[key]?.numericValue ?? null,
        score: audits[key]?.score ?? null,
      });

      results.push({
        url,
        performance: Math.round((categories.performance.score ?? 0) * 100),
        fcp: metric('first-contentful-paint'),
        lcp: metric('largest-contentful-paint'),
        tbt: metric('total-blocking-time'),
        cls: metric('cumulative-layout-shift'),
        si: metric('speed-index'),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      if (chrome) { try { await chrome.kill(); } catch {} }
      results.push({ url, error: err.message, timestamp: new Date().toISOString() });
    }
  }

  send({ type: 'complete', results });
  res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Performance Monitor  →  http://localhost:${PORT}\n`);
});
