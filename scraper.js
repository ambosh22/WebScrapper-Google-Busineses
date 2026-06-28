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

const NAV_TIMEOUT = 30000;

function randSleep(min = 0.2, max = 0.5) {
  return new Promise(r => setTimeout(r, (Math.random() * (max - min) + min) * 1000));
}

function extractPhones(text) {
  if (!text) return [];
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
  if (!text) return [];
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
  const obfPat = /([a-zA-Z0-9._%+-]+)\s*(?:\[?@\]?|\[?at\]?|\(?at\)?)\s*([a-zA-Z0-9.-]+)\s*(?:\[?dot\]?|\[?\.\]?|\(?dot\)?)\s*([a-zA-Z]{2,})/gi;
  let om;
  while ((om = obfPat.exec(text)) !== null) {
    const em = `${om[1]}@${om[2]}.${om[3]}`.toLowerCase();
    if (!seen.has(em) && !em.match(/\.(png|jpg|jpeg|gif|svg|css|js)$/)) {
      seen.add(em);
      emails.push(em);
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

function createContext(browser) {
  return browser.newContext({
    userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    viewport: VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)],
  });
}

async function fetchWebsiteData(ctx, url) {
  const timeout = 30000;
  const timer = new Promise((_, reject) => setTimeout(() => reject(new Error(`Website crawl timed out: ${url}`)), timeout));
  const work = (async () => {
  const wp = await ctx.newPage();
  const phones = [];
  const emails = new Set();
  try {
    const base = (() => { const p = new URL(url); return `${p.protocol}//${p.host}`; })();
    const pages = [url, base + '/contact', base + '/about'];

    for (const target of pages) {
      if (emails.size >= 3) break;
      try {
        await wp.goto(target, { waitUntil: 'load', timeout: 15000 }).catch(() =>
          wp.goto(target, { waitUntil: 'domcontentloaded', timeout: 10000 })
        );
        await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
        await wp.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
        await new Promise(r => setTimeout(r, 300 + Math.random() * 300));

        const text = await wp.evaluate(() => document.body.innerText || '');
        const html = await wp.evaluate(() => document.documentElement.outerHTML || '');

        for (const ph of extractPhones(text)) if (!phones.includes(ph)) phones.push(ph);

        const found = new Set();
        for (const em of extractEmails(text)) found.add(em);
        for (const em of extractEmails(html)) found.add(em);

        const mails = await wp.locator('a[href^="mailto:"]').all();
        for (const el of mails) {
          const h = await el.getAttribute('href');
          if (h) { const e = h.replace('mailto:', '').split('?')[0].trim(); if (e && e.includes('@')) found.add(e); }
        }

        for (const el of await wp.locator('[class*="email"],[id*="email"],[class*="mail"],[id*="mail"]').all()) {
          const t = await el.innerText().catch(() => '');
          for (const em of extractEmails(t)) found.add(em);
        }

        const tels = await wp.locator('a[href^="tel:"]').all();
        for (const el of tels) {
          const h = await el.getAttribute('href');
          if (h) { const n = h.replace('tel:', '').split(/[;,#]/)[0].trim().replace(/[^\d+]/g, ''); if (n.length >= 10 && !phones.includes(n)) phones.push(n); }
        }

        for (const em of found) emails.add(em);
      } catch {}
    }
  } catch {}
  await wp.close();
  return { phones: phones.slice(0, 3), emails: [...emails].slice(0, 5) };
  })();
  return Promise.race([work, timer]);
}

async function scrapeCity(browser, city, state, niche, maxCount, maxTotal, currentTotal, seenPhones, seenNameCity, onProgress) {
  const timeout = 120000;
  const timer = new Promise((_, reject) => setTimeout(() => reject(new Error(`City ${city} timed out after ${timeout/1000}s`)), timeout));
  const work = (async () => {
  let ctx;
  let page;
  const results = [];
  try {
    ctx = await createContext(browser);
    page = await ctx.newPage();
    const query = encodeURIComponent(niche.replace(/ /g, '+'));
    const searchUrl = `https://www.google.com/maps/search/${query}+in+${city},+${state}/`;

    if (onProgress) onProgress('status', { message: `Searching Maps for ${city}...` });
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(async (err) => {
      console.error(`[MAPS] ${city}: first goto failed: ${err.message}, retrying...`);
      await randSleep(1.0, 2.0);
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    });
    await randSleep(1.5, 2.5);

    let cards = page.locator('[class*="Nv2PK"]');
    let cardCount = 0;
    try {
      cardCount = await cards.count();
    } catch {}

    if (cardCount === 0) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await randSleep(1.0, 2.0);
      cards = page.locator('[class*="Nv2PK"]');
      try {
        cardCount = await cards.count();
      } catch {}
    }

    if (cardCount === 0) {
      try {
        await page.waitForSelector('[class*="Nv2PK"]', { timeout: 15000 });
        cardCount = await cards.count();
      } catch {
        return results;
      }
    }

    if (cardCount === 0) return results;

    let prevCount = 0;
    for (let s = 0; s < 10; s++) {
      try { await page.evaluate(() => document.querySelector('[role=feed]')?.scrollBy(0, 2000)); } catch {}
      await randSleep(0.3, 0.5);
      try {
        const cur = await cards.count();
        if (s > 2 && cur === prevCount) break;
        prevCount = cur;
      } catch { break; }
    }

    await randSleep(0.5, 1.0);
    cards = page.locator('[class*="Nv2PK"]');
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
        await randSleep(0.3, 0.6);

        const emails = [];
        let website = '';
        try {
          await page.keyboard.press('Escape');
          await randSleep(0.1, 0.2);
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
          const telEls = await page.locator('a[href^="tel:"]').all();
          for (const el of telEls) {
            const href = await el.getAttribute('href');
            if (href) {
              const num = href.replace('tel:', '').split(/[;,#]/)[0].trim().replace(/[^\d+]/g, '');
              if (num.length >= 10 && !phones.includes(num)) phones.push(num);
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
              for (const el of document.querySelectorAll('a[href]')) {
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
          } catch (err) {
            console.error(`[WEBSITE] ${name}: fetchWebsiteData failed: ${err.message}`);
          }
        }

        const phonesFmt = phones.slice(0, 3).map(formatPhone);
        const entry = {
          city, company: name,
          email1: emails[0] || '',
          email2: emails[1] || '',
          email3: emails[2] || '',
          phone1: phonesFmt[0] || '',
          phone2: phonesFmt[1] || '',
          phone3: phonesFmt[2] || '',
          website,
        };
        results.push(entry);
        if (onProgress) onProgress('business', { entry });
        await randSleep(0.2, 0.4);
      } catch {}
    }
  } catch {} finally {
    if (page) try { await page.close(); } catch {}
    if (ctx) try { await ctx.close(); } catch {}
  }
  return results;
  })();
  return Promise.race([work, timer]).catch(err => {
    console.error(`[CITY] ${err.message}`);
    return [];
  });
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
