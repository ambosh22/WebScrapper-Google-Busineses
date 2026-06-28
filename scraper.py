#!/usr/bin/env python3
import sys, json, re, asyncio, argparse, time, urllib.parse, random, os, urllib.request, ssl

try:
    from playwright.async_api import async_playwright
except ImportError:
    print("Install: pip install playwright && playwright install chromium", file=sys.stderr)
    sys.exit(1)

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
]

VIEWPORTS = [
    {"width": 1920, "height": 1080},
    {"width": 1920, "height": 1040},
    {"width": 1366, "height": 768},
    {"width": 1440, "height": 900},
    {"width": 1536, "height": 864},
    {"width": 1280, "height": 800},
]

PROXIES = []
PROXY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "proxies.txt")


async def rand_sleep(min_s=0.3, max_s=1.2):
    await asyncio.sleep(random.uniform(min_s, max_s))


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


FREE_PROXY_URLS = [
    "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all",
    "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
    "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt",
    "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt",
]


def fetch_free_proxies():
    proxies = set()
    ctx = ssl._create_unverified_context()
    for url in FREE_PROXY_URLS:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}, method="GET")
            with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
                raw = resp.read().decode("utf-8")
                for line in raw.splitlines():
                    line = line.strip().lower()
                    if line and ":" in line and not line.startswith("#"):
                        proxies.add(f"http://{line}")
            log(f"Fetched proxies from {url.split('/')[2]}", "info")
        except Exception as e:
            log(f"Failed to fetch {url.split('/')[2]}: {str(e)[:50]}", "error")
    return list(proxies)


def load_proxies():
    if os.path.exists(PROXY_FILE):
        proxies = []
        with open(PROXY_FILE) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    proxies.append(line)
        if proxies:
            log(f"Loaded {len(proxies)} proxies from proxies.txt", "info")
            return proxies

    log("No proxies configured — running direct connections", "info")
    return []

PROXIES[:] = load_proxies()


def get_proxy():
    if PROXIES:
        return random.choice(PROXIES)
    return None


def get_context_kwargs():
    ua = random.choice(USER_AGENTS)
    vp = random.choice(VIEWPORTS)
    kwargs = {"user_agent": ua, "viewport": vp}
    proxy = get_proxy()
    if proxy:
        kwargs["proxy"] = {"server": proxy}
    return kwargs


CONTACT_PATHS = ["", "/contact", "/contact-us", "/about", "/about-us", "/contactus", "/get-in-touch"]


async def fetch_website_data(ctx, url):
    page = await ctx.new_page()
    phones, emails = [], set()
    try:
        parsed = urllib.parse.urlparse(url.rstrip('/'))
        base_domain = f"{parsed.scheme}://{parsed.netloc}"

        for path in CONTACT_PATHS:
            try:
                target = url if not path else base_domain + path
                await page.goto(target, wait_until="load", timeout=15000)
                await rand_sleep(0.5, 1.0)
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                await rand_sleep(0.3, 0.6)
                text = await page.inner_text("body")
                for p in extract_phones(text):
                    if p not in phones:
                        phones.append(p)
                for e in extract_emails(text):
                    emails.add(e)
                for el in await page.locator('a[href^="mailto:"]').all():
                    href = await el.get_attribute("href")
                    if href:
                        e = href.replace("mailto:", "").split("?")[0].strip()
                        if e and "@" in e:
                            emails.add(e)
            except:
                pass
    except:
        pass
    await page.close()
    return phones[:4], list(emails)[:5]


async def scrape_city(browser, city, state, niche="businesses", max_count=999, max_total=1000, current_total=0, seen_phones=None, seen_name_city=None):
    if seen_phones is None:
        seen_phones = set()
    if seen_name_city is None:
        seen_name_city = set()

    ctx = await browser.new_context(**get_context_kwargs())
    page = await ctx.new_page()
    results = []
    try:
        query = urllib.parse.quote(niche.replace(" ", "+"))
        search_url = f"https://www.google.com/maps/search/{query}+in+{city},+{state}/"
        await page.goto(search_url, wait_until="domcontentloaded", timeout=30000)
        await rand_sleep(1.5, 3.0)

        try:
            await page.wait_for_selector('[class*="Nv2PK"]', timeout=15000)
        except:
            log(f"No results for {city}", "error")
            return results

        prev_count = 0
        no_progress = 0
        for _ in range(20):
            try:
                await page.evaluate('document.querySelector("[role=feed]")?.scrollBy(0, 1800)')
            except:
                pass
            await rand_sleep(0.4, 0.9)
            cards = page.locator('[class*="Nv2PK"]')
            cur = await cards.count()
            if cur == prev_count:
                no_progress += 1
                if no_progress >= 4:
                    break
            else:
                no_progress = 0
            prev_count = cur

        await rand_sleep(0.8, 1.5)

        cards = page.locator('[class*="Nv2PK"]')
        total = await cards.count()
        limit = min(total, max_count, max_total - current_total)
        if limit <= 0:
            return results
        log(f"Found {limit} businesses in {city}", "info")

        for i in range(limit):
            try:
                if current_total + len(results) >= max_total:
                    break

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

                phone_key = None
                for p in phones:
                    digits = re.sub(r'[^\d]', '', p)
                    if len(digits) >= 10:
                        phone_key = digits[-10:]
                        break

                name_city_key = (name.lower().strip(), city.lower().strip())

                is_dup = (phone_key and phone_key in seen_phones) or (name_city_key in seen_name_city)
                if is_dup:
                    log(f"  [{i+1}/{limit}] Skipped duplicate: {name}", "info")
                    continue

                if phone_key:
                    seen_phones.add(phone_key)
                seen_name_city.add(name_city_key)

                await cards.nth(i).click()
                await rand_sleep(0.6, 1.5)

                emails = []
                website = ""
                try:
                    await page.keyboard.press("Escape")
                    await rand_sleep(0.2, 0.5)
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

                    for sel in ['a[data-item-id*="authority"]', 'a[href^="http"][rel="noopener"]', 'a[href*="http"]:not([href*="google"])']:
                        ws_el = page.locator(sel)
                        if await ws_el.count() > 0:
                            href = await ws_el.first.get_attribute("href")
                            website = clean_website_url(href)
                            if website:
                                break

                    detail_phones = extract_phones(body_text)
                    for p in detail_phones:
                        digits = re.sub(r'[^\d]', '', p)
                        if len(digits) >= 10:
                            k = digits[-10:]
                            if k not in seen_10:
                                seen_10.add(k)
                                phones.append(p)
                except:
                    pass

                if not website:
                    try:
                        card_link = cards.nth(i).locator('a[href*="http"]')
                        if await card_link.count() > 0:
                            href = await card_link.first.get_attribute("href")
                            website = clean_website_url(href)
                    except:
                        pass

                if website and website.startswith("http"):
                    try:
                        sp, se = await fetch_website_data(ctx, website)
                        for e in se:
                            if e.lower() not in [x.lower() for x in emails]:
                                emails.append(e)
                        for p in sp:
                            if p not in phones:
                                phones.append(p)
                    except:
                        pass

                phones_fmt = [format_phone(p) for p in phones[:4]]
                entry = {
                    "city": city,
                    "company": name,
                    "email1": emails[0] if len(emails) > 0 else "",
                    "email2": emails[1] if len(emails) > 1 else "",
                    "email3": emails[2] if len(emails) > 2 else "",
                    "email4": emails[3] if len(emails) > 3 else "",
                    "email5": emails[4] if len(emails) > 4 else "",
                    "phone1": phones_fmt[0] if len(phones_fmt) > 0 else "",
                    "phone2": phones_fmt[1] if len(phones_fmt) > 1 else "",
                    "website": website
                }
                results.append(entry)
                print(json.dumps({"type": "business", "entry": entry}), file=sys.stderr, flush=True)
                log(f"  [{i+1}/{limit}] {name} - e:{entry['email1'] or 'no'} p:{entry['phone1'] or 'no'}", "success")
                await rand_sleep(0.2, 0.6)

            except Exception as e:
                log(f"  [{i+1}] Error: {str(e)[:80]}", "error")

    except Exception as e:
        log(f"City error {city}: {e}", "error")
    finally:
        await ctx.close()

    return results


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", required=True)
    parser.add_argument("--cities", required=True)
    parser.add_argument("--niche", type=str, default="businesses")
    parser.add_argument("--max", type=int, default=200)
    parser.add_argument("--max-total", type=int, default=1000)
    parser.add_argument("--parallel-cities", type=int, default=3)
    args = parser.parse_args()

    cities = [c.strip() for c in args.cities.split(",") if c.strip()]
    total = len(cities)

    proxy_status = f"{len(PROXIES)} proxies" if PROXIES else "no proxies (direct)"
    log(f"Scraping {args.state} for '{args.niche}' ({total} cities, max {args.max_total} total, {args.parallel_cities}x parallel, {proxy_status})", "info")
    start_time = time.time()
    all_results = []
    seen_phones = set()
    seen_name_city = set()
    total_count = 0

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
                  "--disable-web-security", "--window-size=1920,1080"]
        )

        for batch_start in range(0, len(cities), args.parallel_cities):
            if total_count >= args.max_total:
                break
            batch = cities[batch_start:batch_start + args.parallel_cities]

            async def scrape_one(city):
                results = await scrape_city(browser, city, args.state,
                                            niche=args.niche,
                                            max_count=args.max,
                                            max_total=args.max_total,
                                            current_total=total_count,
                                            seen_phones=seen_phones,
                                            seen_name_city=seen_name_city)
                return city, results

            batch_results = await asyncio.gather(*[scrape_one(c) for c in batch])

            for city, city_results in batch_results:
                all_results.extend(city_results)
                total_count = len(all_results)
                idx = cities.index(city) + 1
                elapsed = time.time() - start_time
                progress = {
                    "type": "progress", "city": city, "index": idx, "total": total,
                    "businesses": len(city_results), "total_businesses": total_count,
                    "percent": min(100, round((total_count / args.max_total) * 100)) if args.max_total else 0,
                    "elapsed_secs": round(elapsed)
                }
                print(json.dumps(progress), file=sys.stderr, flush=True)
                if total_count >= args.max_total:
                    log(f"Reached max total of {args.max_total} businesses, stopping.", "info")
                    break

        await browser.close()

    print(json.dumps(all_results))
    log(f"Complete! {len(all_results)} businesses in {time.time()-start_time:.0f}s", "success")


if __name__ == "__main__":
    asyncio.run(main())
