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

const CONTACT_PATHS = ['', '/contact', '/contact-us', '/about', '/about-us', '/contactus', '/get-in-touch'];

async function fetchWebsiteData(page, url) {
  const phones = [];
  const emails = new Set();
  try {
    const parsed = new URL(url);
    const baseDomain = `${parsed.protocol}//${parsed.host}`;
    for (const p of CONTACT_PATHS) {
      try {
        const target = p ? baseDomain + p : url;
        await page.goto(target, { waitUntil: 'load', timeout: 15000 });
        await randSleep(0.5, 1.0);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await randSleep(0.3, 0.6);
        const text = await page.evaluate(() => document.body.innerText);
        for (const ph of extractPhones(text)) if (!phones.includes(ph)) phones.push(ph);
        for (const em of extractEmails(text)) emails.add(em);
        const mailtoEls = await page.locator('a[href^="mailto:"]').all();
        for (const el of mailtoEls) {
          const href = await el.getAttribute('href');
          if (href) {
            const e = href.replace('mailto:', '').split('?')[0].trim();
            if (e && e.includes('@')) emails.add(e);
          }
        }
      } catch {}
    }
  } catch {}
  return { phones: phones.slice(0, 4), emails: [...emails].slice(0, 5) };
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
    for (let s = 0; s < 20; s++) {
      try { await page.evaluate(() => document.querySelector('[role=feed]')?.scrollBy(0, 1800)); } catch {}
      await randSleep(0.4, 0.9);
      const cur = await page.locator('[class*="Nv2PK"]').count();
      if (s > 3 && cur === prevCount) break;
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
        await randSleep(0.6, 1.5);

        const emails = [];
        let website = '';
        try {
          await page.keyboard.press('Escape');
          await randSleep(0.2, 0.5);
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

          for (const sel of ['a[data-item-id*="authority"]', 'a[href^="http"][rel="noopener"]']) {
            const wsEl = page.locator(sel);
              if (await wsEl.count() > 0) {
                const href = await wsEl.first().getAttribute('href');
              website = cleanWebsiteUrl(href);
              if (website) break;
            }
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
            const { phones: sp, emails: se } = await fetchWebsiteData(page, website);
            for (const e of se) if (!emails.find(x => x.toLowerCase() === e.toLowerCase())) emails.push(e);
            for (const p of sp) if (!phones.includes(p)) phones.push(p);
          } catch {}
        }

        const phonesFmt = phones.slice(0, 4).map(formatPhone);
        const entry = {
          city, company: name,
          email1: emails[0] || '', email2: emails[1] || '', email3: emails[2] || '',
          email4: emails[3] || '', email5: emails[4] || '',
          phone1: phonesFmt[0] || '', phone2: phonesFmt[1] || '',
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

  const browser = await chromium.launch({
    headless: true,
    timeout: 45000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-web-security'],
  });

  try {
    const parallel = 2;
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
    await browser.close();
  }

  return allResults;
}

module.exports = { runScraper };
