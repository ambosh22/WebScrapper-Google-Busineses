const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
];

function randSleep(min = 0.3, max = 1.2) {
  return new Promise(r => setTimeout(r, (Math.random() * (max - min) + min) * 1000));
}

function extractPhones(text) {
  const phones = [];
  const seen = new Set();
  const patterns = [
    /(?:\+1[\s\-\.]?)?\(?\d{3}\)?[\s\-\.]?\d{3}[\s\-\.]?\d{4}(?:\s*(?:x|ext|#)\s*\d+)?/g,
    /\d{3}[\s\-\.]\d{3}[\s\-\.]\d{4}/g,
  ];
  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(text)) !== null) {
      let clean = m[0].replace(/[^\d]/g, '').split('x')[0].split('#')[0].split('ext')[0];
      const key = clean.length >= 10 ? clean.slice(-10) : clean;
      if (clean.length >= 10 && !seen.has(key)) {
        seen.add(key);
        phones.push(clean);
      }
    }
  }
  return phones;
}

function extractEmails(text) {
  const emails = [];
  const seen = new Set();
  const pat = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  let m;
  while ((m = pat.exec(text)) !== null) {
    const ml = m[0].toLowerCase();
    if (!seen.has(ml) && !ml.match(/\.(png|jpg|jpeg|gif|svg|css|js)$/)) {
      seen.add(ml);
      emails.push(m[0]);
    }
  }
  return emails;
}

function formatPhone(p) {
  const d = p.replace(/[^\d]/g, '');
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === '1') return `+1 (${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  return p;
}

function cleanWebsiteUrl(href) {
  if (!href) return '';
  if (href.startsWith('/url?')) {
    try {
      const u = new URL(href, 'https://google.com');
      const q = u.searchParams.get('q');
      if (q) return q;
    } catch {}
  }
  if (href.includes('google.com') || href.includes('maps')) return '';
  return href.split('?')[0].replace(/\/$/, '');
}

async function fetchWebsiteData(ctx, url) {
  const wp = await ctx.newPage();
  const phones = [];
  const emails = new Set();
  const visited = new Set();
  const queue = [url];
  try {
    const parsed = new URL(url);
    const maxPages = 8;

    while (queue.length > 0 && emails.size < 3 && visited.size < maxPages) {
      const target = queue.shift();
      if (visited.has(target)) continue;
      visited.add(target);
      try {
        await wp.goto(target, { waitUntil: 'domcontentloaded', timeout: 8000 });
        await randSleep(0.2, 0.5);
        try { await wp.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await randSleep(0.2, 0.3); } catch {}
        const text = await wp.evaluate(() => document.body.innerText || document.documentElement.outerText || '');
        for (const ph of extractPhones(text)) if (!phones.includes(ph)) phones.push(ph);
        for (const em of extractEmails(text)) emails.add(em);
        const mailtoEls = await wp.locator('a[href^="mailto:"]').all();
        for (const el of mailtoEls) {
          const href = await el.getAttribute('href');
          if (href) {
            const e = href.replace('mailto:', '').split('?')[0].trim();
            if (e && e.includes('@') && !emails.has(e.toLowerCase())) emails.add(e);
          }
        }
        try {
          const html = await wp.evaluate(() => document.documentElement.outerHTML);
          for (const em of extractEmails(html)) emails.add(em);
        } catch {}

        if (emails.size < 3 && visited.size < maxPages) {
          try {
            const links = await wp.evaluate((domain) => {
              const result = [];
              const anchors = document.querySelectorAll('a[href]');
              for (const a of anchors) {
                try {
                  const href = a.href.split('#')[0].split('?')[0].replace(/\/$/, '');
                  const u = new URL(href);
                  if (u.hostname === domain && !result.includes(href) && !href.match(/\.(pdf|doc|docx|xls|xlsx|zip|tar|gz|png|jpg|jpeg|gif|svg|css|js|json|xml|mp4|mp3)$/i)) {
                    const skip = ['/wp-content', '/wp-includes', '/wp-json', '/cdn-cgi', 'facebook.com', 'twitter.com', 'linkedin.com', 'instagram.com', 'youtube.com'];
                    if (!skip.some(s => href.includes(s))) result.push(href);
                  }
                } catch {}
              }
              return result;
            }, parsed.hostname);
            for (const link of links) {
              if (!visited.has(link) && !queue.includes(link)) queue.push(link);
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}
  await wp.close();
  return { phones: phones.slice(0, 2), emails: [...emails].slice(0, 5) };
}

async function scrapeCity(browser, city, state, niche, maxCount, maxTotal, currentTotal, seenPhones, seenNameCity, onProgress) {
  const ctx = await browser.newContext({
    userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    viewport: VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)],
  });
  const page = await ctx.newPage();
  const results = [];
  try {
    const query = encodeURIComponent(niche.replace(/ /g, '+'));
    const searchUrl = `https://www.google.com/maps/search/${query}+in+${city},+${state}/`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randSleep(1.5, 3.0);

    try {
      await page.waitForSelector('[class*="Nv2PK"]', { timeout: 15000 });
    } catch {
      return results;
    }

    let prevCount = 0;
    for (let s = 0; s < 12; s++) {
      try { await page.evaluate(() => document.querySelector('[role=feed]')?.scrollBy(0, 2500)); } catch {}
      await randSleep(0.3, 0.6);
      const cur = await page.locator('[class*="Nv2PK"]').count();
      if (s > 2 && cur === prevCount) break;
      prevCount = cur;
    }

    await randSleep(0.8, 1.5);
    const cards = page.locator('[class*="Nv2PK"]');
    const total = Math.min(await cards.count(), maxCount, maxTotal - currentTotal);
    if (total <= 0) return results;

    for (let i = 0; i < total; i++) {
      try {
        if (currentTotal + results.length >= maxTotal) break;
        const cardText = await cards.nth(i).innerText();
        const lines = cardText.split('\n').map(l => l.trim()).filter(Boolean);
        const name = lines[0] || 'Unknown';
        if (name.toLowerCase() === 'sponsored') continue;

        const rawPhones = extractPhones(cardText);
        const phones = [];
        const seen10 = new Set();
        for (const p of rawPhones) {
          const k = p.slice(-10);
          if (!seen10.has(k)) { seen10.add(k); phones.push(p); }
        }

        let phoneKey = null;
        for (const p of phones) {
          const d = p.replace(/[^\d]/g, '');
          if (d.length >= 10) { phoneKey = d.slice(-10); break; }
        }

        const nameCityKey = `${name.toLowerCase().trim()}|${city.toLowerCase().trim()}`;
        if ((phoneKey && seenPhones.has(phoneKey)) || seenNameCity.has(nameCityKey)) continue;
        if (phoneKey) seenPhones.add(phoneKey);
        seenNameCity.add(nameCityKey);

        await cards.nth(i).click();
        await randSleep(0.3, 0.8);

        const emails = [];
        let website = '';
        try {
          await page.keyboard.press('Escape');
          await randSleep(0.1, 0.3);
          const bodyText = await page.evaluate(() => document.body.innerText);

          for (const e of extractEmails(bodyText)) if (!emails.includes(e)) emails.push(e);
          const mailtoEls = await page.locator('a[href^="mailto:"]').all();
          for (const el of mailtoEls) {
            const href = await el.getAttribute('href');
            if (href) {
              const e = href.replace('mailto:', '').split('?')[0].trim();
              if (e && e.includes('@') && !emails.includes(e)) emails.push(e);
            }
          }

          for (const sel of [
            'a[data-item-id*="authority"]',
            'a[href^="http"][rel="noopener"]',
            'a[href*="http"]:not([href*="google"]):not([href*="maps"])',
          ]) {
            const wsEl = page.locator(sel);
            if (await wsEl.count() > 0) {
              const href = await wsEl.first().getAttribute('href');
              website = cleanWebsiteUrl(href);
              if (website) break;
            }
          }

          if (!website) {
            website = await page.evaluate(() => {
              const els = document.querySelectorAll('a[href]:not([href*="google"]):not([href*="maps"])');
              for (const el of els) {
                const h = el.href;
                if (h && h.startsWith('http') && !h.includes('google') && !h.includes('maps')) return h;
              }
              return '';
            });
          }

          const detailPhones = extractPhones(bodyText);
          for (const p of detailPhones) {
            const d = p.replace(/[^\d]/g, '');
            if (d.length >= 10) {
              const k = d.slice(-10);
              if (!seen10.has(k)) { seen10.add(k); phones.push(p); }
            }
          }
        } catch {}

        if (!website) {
          try {
            const cardLink = cards.nth(i).locator('a[href*="http"]');
            if (await cardLink.count() > 0) {
              const href = await cardLink.first().getAttribute('href');
              website = cleanWebsiteUrl(href);
            }
          } catch {}
        }

        if (website && website.startsWith('http')) {
          try {
            const { phones: sp, emails: se } = await fetchWebsiteData(ctx, website);
            for (const e of se) if (!emails.find(x => x.toLowerCase() === e.toLowerCase())) emails.push(e);
            for (const p of sp) if (!phones.includes(p)) phones.push(p);
          } catch {}
        }

        const phonesFmt = phones.slice(0, 1).map(formatPhone);
        const entry = {
          city, company: name,
          phone: phonesFmt[0] || '',
          email: emails[0] || '',
          website,
        };
        results.push(entry);
        if (onProgress) onProgress('business', { entry });
        await randSleep(0.2, 0.6);
      } catch {}
    }
  } catch {} finally {
    await ctx.close();
  }
  return results;
}

async function runScraper({ state, cities, niche, maxPerCity, maxTotal, onProgress }) {
  const startTime = Date.now();
  const allResults = [];
  const seenPhones = new Set();
  const seenNameCity = new Set();

  let browser;
  if (onProgress) onProgress('status', { message: 'Starting Chromium browser...' });
  try {
    browser = await chromium.launch({
      headless: true,
      timeout: 30000,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--no-zygote',
        '--disable-accelerated-2d-canvas', '--disable-accelerated-video-decode',
        '--js-flags=--max_old_space_size=256',
        '--disable-web-security',
      ],
    });
  } catch (err) {
    console.error('[SCRAPER] chromium.launch failed:', err.message);
    if (onProgress) onProgress('error', { message: `Chromium launch failed: ${err.message}` });
    throw err;
  }

  if (onProgress) onProgress('status', { message: 'Browser ready, starting scrape...' });
  try {
    const parallel = 1;
    for (let i = 0; i < cities.length; i += parallel) {
      if (allResults.length >= maxTotal) break;
      const batch = cities.slice(i, i + parallel);
      const batchResults = await Promise.all(batch.map(city =>
        scrapeCity(browser, city, state, niche, maxPerCity, maxTotal,
          allResults.length, seenPhones, seenNameCity, onProgress)
      ));
      for (const res of batchResults) {
        allResults.push(...res);
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        if (onProgress) onProgress('progress', {
          totalBusinesses: allResults.length,
          percent: Math.min(100, Math.round((allResults.length / maxTotal) * 100)),
          elapsedSecs: elapsed,
          city: res[0]?.city || '',
        });
      }
      if (allResults.length >= maxTotal) break;
    }
  } finally {
    if (browser) await browser.close();
  }

  return allResults;
}

module.exports = { runScraper };