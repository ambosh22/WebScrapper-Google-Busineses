#!/usr/bin/env python3
import sys, json, re, asyncio, argparse, time, urllib.parse

try:
    from playwright.async_api import async_playwright
except ImportError:
    print("Install: pip install playwright && playwright install chromium", file=sys.stderr)
    sys.exit(1)


def log(msg, type="info"):
    print(json.dumps({"type": type, "message": msg}), file=sys.stderr, flush=True)


def extract_phones(text):
    phones, seen = [], set()
    patterns = [
        r'(?:\+1[\s\-\.]?)?\(?\d{3}\)?[\s\-\.]?\d{3}[\s\-\.]?\d{4}(?:\s*(?:x|ext|#)\s*\d+)?',
        r'\d{3}[\s\-\.]\d{3}[\s\-\.]\d{4}',
    ]
    for pat in patterns:
        for m in re.findall(pat, text, re.IGNORECASE):
            clean = re.sub(r'[^\d]', '', m.split('x')[0].split('#')[0].split('ext')[0])
            key = clean[-10:] if len(clean) >= 10 else clean
            if len(clean) >= 10 and key not in seen:
                seen.add(key)
                phones.append(clean)
    return phones


def extract_emails(text):
    emails, seen = [], set()
    for m in re.findall(r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}', text):
        ml = m.lower()
        if ml not in seen and not ml.endswith(('.png', '.jpg', '.jpeg', '.gif', '.svg', '.css', '.js')):
            seen.add(ml)
            emails.append(m)
    return emails


def format_phone(p):
    digits = re.sub(r'[^\d]', '', p)
    if len(digits) == 10:
        return f"({digits[:3]}) {digits[3:6]}-{digits[6:]}"
    if len(digits) == 11 and digits[0] == '1':
        return f"+1 ({digits[1:4]}) {digits[4:7]}-{digits[7:]}"
    return p


def clean_website_url(href):
    if not href:
        return ""
    if href.startswith("/url?"):
        try:
            parsed = urllib.parse.urlparse(href)
            params = urllib.parse.parse_qs(parsed.query)
            if 'q' in params:
                return params['q'][0]
        except:
            pass
    if "google.com" in href or "maps" in href:
        return ""
    return href.split("?")[0].rstrip('/')


CONTACT_PATHS = ["", "/contact", "/contact-us", "/about", "/about-us", "/contactus", "/get-in-touch"]


async def fetch_website_data(ctx, url):
    """Visit website pages and extract phones + emails."""
    page = await ctx.new_page()
    phones, emails = [], []
    try:
        parsed = urllib.parse.urlparse(url.rstrip('/'))
        base_domain = f"{parsed.scheme}://{parsed.netloc}"

        for path in CONTACT_PATHS:
            try:
                target = url if not path else base_domain + path
                await page.goto(target, wait_until="domcontentloaded", timeout=10000)
                await asyncio.sleep(0.5)
                text = await page.inner_text("body")
                for p in extract_phones(text):
                    if p not in phones:
                        phones.append(p)
                for e in extract_emails(text):
                    if e not in emails:
                        emails.append(e)
                for el in await page.locator('a[href^="mailto:"]').all():
                    href = await el.get_attribute("href")
                    if href:
                        e = href.replace("mailto:", "").split("?")[0].strip()
                        if e and "@" in e and e not in emails:
                            emails.append(e)
            except:
                pass
    except:
        pass
    await page.close()
    return phones[:4], emails[:5]


async def scrape_city(browser, city, state, max_count=999):
    ctx = await browser.new_context(
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        viewport={"width": 1920, "height": 1080}
    )
    page = await ctx.new_page()
    results = []
    try:
        search_url = f"https://www.google.com/maps/search/businesses+in+{city},+{state}/"
        await page.goto(search_url, wait_until="domcontentloaded", timeout=20000)
        await asyncio.sleep(2)

        try:
            await page.wait_for_selector('[class*="Nv2PK"]', timeout=10000)
        except:
            log(f"No results for {city}", "error")
            return results

        prev_count = 0
        for _ in range(15):
            try:
                await page.evaluate('document.querySelector("[role=feed]")?.scrollBy(0, 1500)')
            except:
                pass
            await asyncio.sleep(0.4)
            cards = page.locator('[class*="Nv2PK"]')
            cur = await cards.count()
            if cur == prev_count and _ > 3:
                break
            prev_count = cur

        await asyncio.sleep(1)

        cards = page.locator('[class*="Nv2PK"]')
        total = await cards.count()
        limit = min(total, max_count)
        log(f"Found {limit} businesses in {city}", "info")

        for i in range(limit):
            try:
                card_text = await cards.nth(i).inner_text()
                lines = [l.strip() for l in card_text.split('\n') if l.strip()]
                name = lines[0] if lines else "Unknown"

                if name.lower() == "sponsored":
                    continue

                raw_phones = extract_phones(card_text)
                phones = []
                seen_10 = set()
                for p in raw_phones:
                    k = p[-10:]
                    if k not in seen_10:
                        seen_10.add(k)
                        phones.append(p)

                website = ""
                card_link = cards.nth(i).locator('a[href*="http"]')
                if await card_link.count() > 0:
                    href = await card_link.first.get_attribute("href")
                    website = clean_website_url(href)
                if not website:
                    card_link2 = cards.nth(i).locator('a[href*="/url?"]')
                    if await card_link2.count() > 0:
                        href = await card_link2.first.get_attribute("href")
                        website = clean_website_url(href)

                await cards.nth(i).click()
                await asyncio.sleep(0.8)

                emails = []
                try:
                    await page.keyboard.press("Escape")
                    await asyncio.sleep(0.3)
                    body_text = await page.inner_text("body")
                    for e in extract_emails(body_text):
                        if e not in emails:
                            emails.append(e)
                    for el in await page.locator('a[href^="mailto:"]').all():
                        href = await el.get_attribute("href")
                        if href:
                            e = href.replace("mailto:", "").split("?")[0].strip()
                            if e and "@" in e and e not in emails:
                                emails.append(e)
                except:
                    pass

                phones_fmt = [format_phone(p) for p in phones[:4]]
                entry = {
                    "city": city,
                    "company": name,
                    "phone1": phones_fmt[0] if len(phones_fmt) > 0 else "",
                    "phone2": phones_fmt[1] if len(phones_fmt) > 1 else "",
                    "email1": emails[0] if len(emails) > 0 else "",
                    "email2": emails[1] if len(emails) > 1 else "",
                    "email3": emails[2] if len(emails) > 2 else "",
                    "email4": emails[3] if len(emails) > 3 else "",
                    "email5": emails[4] if len(emails) > 4 else "",
                    "website": website
                }
                results.append(entry)
                print(json.dumps({"type": "business", "entry": entry}), file=sys.stderr, flush=True)
                log(f"  [{i+1}/{limit}] {name} - p:{entry['phone1'] or 'no'} e:{entry['email1'] or 'no'}", "success")

            except Exception as e:
                log(f"  [{i+1}] Error: {str(e)[:80]}", "error")

    except Exception as e:
        log(f"City error {city}: {e}", "error")
    finally:
        await ctx.close()

    return results


async def enrich_from_websites(browser, results):
    """Visit business websites to get more phones and emails."""
    unique_urls = {}
    for i, r in enumerate(results):
        w = r.get("website", "").strip()
        if w and w.startswith("http"):
            domain = urllib.parse.urlparse(w).netloc
            if domain not in unique_urls:
                unique_urls[domain] = []
            unique_urls[domain].append(i)

    if not unique_urls:
        return

    ctx = await browser.new_context(
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        viewport={"width": 1280, "height": 800}
    )

    domains = list(unique_urls.keys())
    sem = asyncio.Semaphore(4)
    enriched = 0

    async def process_domain(domain):
        nonlocal enriched
        idx = unique_urls[domain][0]
        url = results[idx]["website"]
        async with sem:
            site_phones, site_emails = await fetch_website_data(ctx, url)

        if site_phones or site_emails:
            for i in unique_urls[domain]:
                er = results[i]
                existing_phones = set()
                if er.get("phone1"):
                    existing_phones.add(re.sub(r'[^\d]', '', er["phone1"])[-10:])
                if er.get("phone2"):
                    existing_phones.add(re.sub(r'[^\d]', '', er["phone2"])[-10:])

                if site_phones:
                    for sp in site_phones:
                        key = re.sub(r'[^\d]', '', sp)[-10:]
                        if key not in existing_phones:
                            if not er.get("phone1"):
                                er["phone1"] = format_phone(sp)
                                existing_phones.add(key)
                            elif not er.get("phone2"):
                                er["phone2"] = format_phone(sp)
                                existing_phones.add(key)

                existing_emails = set()
                for ek in ["email1","email2","email3","email4","email5"]:
                    if er.get(ek):
                        existing_emails.add(er[ek].lower())

                if site_emails:
                    for se in site_emails:
                        if se.lower() not in existing_emails:
                            for ek in ["email1","email2","email3","email4","email5"]:
                                if not er.get(ek):
                                    er[ek] = se
                                    existing_emails.add(se.lower())
                                    break
            enriched += 1
            for i in unique_urls[domain]:
                print(json.dumps({"type": "business_update", "index": i, "entry": results[i]}), file=sys.stderr, flush=True)
            log(f"  {domain}: {len(site_emails)} emails, {len(site_phones)} phones", "success")

    await asyncio.gather(*[process_domain(d) for d in domains])
    await ctx.close()
    log(f"Website enrichment: {enriched}/{len(domains)} sites yielded data", "info")


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", required=True)
    parser.add_argument("--cities", required=True)
    parser.add_argument("--max", type=int, default=999)
    parser.add_argument("--parallel-cities", type=int, default=3)
    args = parser.parse_args()

    cities = [c.strip() for c in args.cities.split(",") if c.strip()]
    total = len(cities)

    log(f"Scraping {args.state} ({total} cities, all businesses, {args.parallel_cities}x parallel)", "info")
    start_time = time.time()
    all_results = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
                  "--disable-web-security", "--window-size=1920,1080"]
        )

        for batch_start in range(0, len(cities), args.parallel_cities):
            batch = cities[batch_start:batch_start + args.parallel_cities]

            async def scrape_one(city):
                results = await scrape_city(browser, city, args.state, args.max)
                return city, results

            batch_results = await asyncio.gather(*[scrape_one(c) for c in batch])

            for city, city_results in batch_results:
                all_results.extend(city_results)
                idx = cities.index(city) + 1
                elapsed = time.time() - start_time
                progress = {
                    "type": "progress", "city": city, "index": idx, "total": total,
                    "businesses": len(city_results), "total_businesses": len(all_results),
                    "percent": round((idx / total) * 100), "elapsed_secs": round(elapsed)
                }
                print(json.dumps(progress), file=sys.stderr, flush=True)

        if all_results:
            log(f"Enriching from websites ({len(all_results)} businesses)...", "info")
            await enrich_from_websites(browser, all_results)

        await browser.close()

    print(json.dumps(all_results))
    log(f"Complete! {len(all_results)} businesses in {time.time()-start_time:.0f}s", "success")


if __name__ == "__main__":
    asyncio.run(main())
