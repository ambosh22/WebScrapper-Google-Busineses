#!/usr/bin/env python3
import sys, json, re, asyncio, argparse, time, urllib.parse, random, os, concurrent.futures

import subprocess

IMPORT_SOURCE = "playwright"

try:
    from rebrowser_playwright.async_api import async_playwright
    IMPORT_SOURCE = "rebrowser_playwright"
except ImportError:
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print(json.dumps({"type": "status", "message": "Installing rebrowser-playwright..."}), file=sys.stderr)
        subprocess.check_call([sys.executable, "-m", "pip", "install", "rebrowser-playwright>=1.52.0"])
        try:
            from rebrowser_playwright.async_api import async_playwright
            IMPORT_SOURCE = "rebrowser_playwright"
        except ImportError:
            from playwright.async_api import async_playwright

try:
    from scrapling.fetchers import Fetcher, AsyncFetcher
    HAS_ASYNC_FETCHER = True
except ImportError:
    Fetcher = None
    AsyncFetcher = None
    HAS_ASYNC_FETCHER = False

PW_INSTALL_MODULE = "rebrowser_playwright" if IMPORT_SOURCE == "rebrowser_playwright" else "playwright"
try:
    subprocess.check_call([sys.executable, "-m", PW_INSTALL_MODULE, "install", "--force", "chromium", "chromium-headless-shell"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=300000)
    msg = json.dumps({"type": "info", "message": f"Browsers installed via {PW_INSTALL_MODULE}"})
    print(msg, file=sys.stderr, flush=True)
except Exception as e:
    msg = json.dumps({"type": "info", "message": f"Browser install warning: {e}"})
    print(msg, file=sys.stderr, flush=True)

PROXY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "proxies.txt")

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
]

VIEWPORTS = [
    {"width": 1920, "height": 1080},
    {"width": 1366, "height": 768},
    {"width": 1440, "height": 900},
]

STEALTH_SCRIPT = """
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
// Override chrome runtime
window.chrome = { runtime: {} };
// Remove headless flags
const originalQuery = window.navigator.permissions.query;
window.navigator.permissions.query = (parameters) => (
  parameters.name === 'notifications' ?
    Promise.resolve({ state: Notification.permission }) :
    originalQuery(parameters)
);
"""


async def rand_sleep(min_s=0.2, max_s=0.6):
    await asyncio.sleep(random.uniform(min_s, max_s))


def log(msg, type="info"):
    print(json.dumps({"type": type, "message": msg}), file=sys.stderr, flush=True)


def load_proxies():
    proxies = []
    try:
        if os.path.exists(PROXY_FILE):
            with open(PROXY_FILE, "r") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#"):
                        proxies.append(line)
        log(f"Loaded {len(proxies)} proxies from proxies.txt", "info")
    except Exception as e:
        log(f"Failed to load proxies: {e}", "error")
    return proxies

PROXIES = load_proxies()

def pick_proxy():
    if not PROXIES:
        return None
    proxy_str = random.choice(PROXIES)
    parsed = urllib.parse.urlparse(proxy_str)
    result = {"server": proxy_str}
    if parsed.username and parsed.password:
        result["username"] = parsed.username
        result["password"] = parsed.password
    elif "@" in proxy_str and "://" in proxy_str:
        userinfo, server = proxy_str.split("://")[1].split("@", 1)
        if ":" in userinfo:
            result = {"server": f"{parsed.scheme}://{server}", "username": userinfo.split(":")[0], "password": ":".join(userinfo.split(":")[1:])}
    return result


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
        if ml not in seen and not re.search(r'\.(png|jpg|jpeg|gif|svg|css|js)$', ml):
            seen.add(ml)
            emails.append(m)
    obf_pat = re.compile(r'([a-zA-Z0-9._%+-]+)\s*(?:\[?@\]?|\[?at\]?|\(?at\)?)\s*([a-zA-Z0-9.-]+)\s*(?:\[?dot\]?|\[?\.\]?|\(?dot\)?)\s*([a-zA-Z]{2,})', re.I)
    for om in obf_pat.finditer(text):
        em = f"{om.group(1)}@{om.group(2)}.{om.group(3)}".lower()
        if em not in seen and not re.search(r'\.(png|jpg|jpeg|gif|svg|css|js)$', em):
            seen.add(em)
            emails.append(em)
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


CONTACT_PATHS = ["", "/contact", "/about", "/contact-us", "/about-us", "/contactus", "/get-in-touch"]
SKIP_EMAILS = {"admin@", "support@", "info@", "noreply@", "no-reply@", "hello@", "contact@", "mail@", "webmaster@", "enquiries@", "sales@", "orders@", "help@"}


def extract_contacts_from_html(html):
    emails = []
    phones = []
    html_lower = html.lower()
    for e in extract_emails(html):
        prefix = e.split('@')[0].lower() + '@'
        skip = False
        for s in SKIP_EMAILS:
            if prefix.startswith(s) or prefix == s:
                skip = True
                break
        if not skip and e not in emails:
            emails.append(e)
    for m in re.finditer(r'href=["\']mailto:([^"\']+)["\']', html, re.I):
        e = m.group(1).split('?')[0].strip()
        if e and '@' in e and e not in emails and len(e) < 100:
            prefix = e.split('@')[0].lower() + '@'
            skip = False
            for s in SKIP_EMAILS:
                if prefix.startswith(s) or prefix == s:
                    skip = True
                    break
            if not skip:
                emails.append(e)
    for ph in extract_phones(html):
        if ph not in phones:
            phones.append(ph)
    return emails, phones


def fetch_single_page(target, timeout):
    if Fetcher:
        try:
            resp = Fetcher.get(target, impersonate='chrome', timeout=timeout, follow_redirects=True)
            raw = resp.body
            html = raw.decode('utf-8', errors='ignore') if isinstance(raw, bytes) else str(raw)
            return extract_contacts_from_html(html)
        except:
            pass
    try:
        import urllib.request, ssl
        ctx = ssl._create_unverified_context()
        req = urllib.request.Request(
            target,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
            }
        )
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            html = resp.read().decode('utf-8', errors='ignore')
        return extract_contacts_from_html(html)
    except:
        pass
    return [], []


async def fetch_website_data_fast(url, timeout=15):
    emails = []
    phones = []
    try:
        parsed = urllib.parse.urlparse(url.rstrip('/'))
        base_domain = f"{parsed.scheme}://{parsed.netloc}"
        targets = [url if not p else base_domain + p for p in CONTACT_PATHS]

        if HAS_ASYNC_FETCHER:
            async def fetch_one(target):
                try:
                    resp = await AsyncFetcher.get(target, timeout=timeout, retries=1)
                    if resp and resp.status == 200:
                        raw = resp.body
                        html = raw.decode('utf-8', errors='ignore') if isinstance(raw, bytes) else str(raw)
                        return extract_contacts_from_html(html)
                except:
                    pass
                return [], []
            results = await asyncio.gather(*[fetch_one(t) for t in targets], return_exceptions=True)
            valid = [r for r in results if isinstance(r, tuple)]
        else:
            with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
                futures = {pool.submit(fetch_single_page, t, timeout): t for t in targets}
                valid = [future.result() for future in concurrent.futures.as_completed(futures)]

        for page_emails, page_phones in valid:
            if len(emails) >= 5:
                break
            for e in page_emails:
                if e not in emails:
                    emails.append(e)
            for p in page_phones:
                if p not in phones:
                    phones.append(p)
    except:
        pass
    return phones[:3], emails[:5]


async def scrape_city(browser, city, state, niche="businesses", max_count=999, max_total=1000, current_total=0, seen_phones=None, seen_name_city=None, proxy=None):
    if seen_phones is None:
        seen_phones = set()
    if seen_name_city is None:
        seen_name_city = set()

    ctx_kwargs = {
        "user_agent": random.choice(USER_AGENTS),
        "viewport": random.choice(VIEWPORTS),
    }
    if proxy:
        ctx_kwargs["proxy"] = proxy
    ctx = await browser.new_context(**ctx_kwargs)
    page = await ctx.new_page()
    results = []

    await page.add_init_script(STEALTH_SCRIPT)

    try:
        query = urllib.parse.quote(niche.replace(" ", "+"))
        search_url = f"https://www.google.com/maps/search/{query}+in+{city},+{state}/"
        for attempt in range(3):
            try:
                await page.goto(search_url, wait_until="load", timeout=90000)
                break
            except:
                if attempt < 2:
                    log(f"Retry {attempt+1} for {city}", "info")
                    await rand_sleep(2, 4)
                else:
                    raise
        await rand_sleep(1.5, 2.5)

        try:
            await page.wait_for_selector('[class*="Nv2PK"]', timeout=15000)
        except:
            log(f"No results for {city}", "error")
            return results

        prev_count = 0
        no_progress = 0
        for _ in range(15):
            try:
                await page.evaluate('document.querySelector("[role=feed]")?.scrollBy(0, 2000)')
            except:
                pass
            await rand_sleep()
            cards = page.locator('[class*="Nv2PK"]')
            cur = await cards.count()
            if cur == prev_count:
                no_progress += 1
                if no_progress >= 3:
                    break
            else:
                no_progress = 0
            prev_count = cur

        await rand_sleep(0.5, 1.0)

        cards = page.locator('[class*="Nv2PK"]')
        total = await cards.count()
        limit = min(total, max_count, max_total - current_total)
        if limit <= 0:
            return results

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

                if (phone_key and phone_key in seen_phones) or (name_city_key in seen_name_city):
                    continue

                if phone_key:
                    seen_phones.add(phone_key)
                seen_name_city.add(name_city_key)

                await cards.nth(i).click()
                await rand_sleep(0.3, 0.5)

                emails = []
                website = ""
                try:
                    await page.keyboard.press("Escape")
                    await rand_sleep(0.1, 0.2)
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

                if website and website.startswith("http") and len(emails) < 3:
                    try:
                        sp, se = await fetch_website_data_fast(website)
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
                    "phone1": phones_fmt[0] if len(phones_fmt) > 0 else "",
                    "phone2": phones_fmt[1] if len(phones_fmt) > 1 else "",
                    "phone3": phones_fmt[2] if len(phones_fmt) > 2 else "",
                    "website": website
                }
                results.append(entry)
                print(json.dumps({"type": "business", "entry": entry}), file=sys.stderr, flush=True)

            except:
                pass

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
    parser.add_argument("--proxy", type=str, default="", help="Direct proxy URL (e.g. http://user:pass@host:port)")
    args = parser.parse_args()

    if args.proxy:
        parsed = urllib.parse.urlparse(args.proxy)
        PROXIES.insert(0, args.proxy)
        log(f"Using direct proxy: {parsed.hostname}:{parsed.port}", "info")

    cities = [c.strip() for c in args.cities.split(",") if c.strip()]
    total = len(cities)

    pw_source = f"via {IMPORT_SOURCE}"
    proxy_count = len(PROXIES)
    proxy_status = f"{proxy_count} proxies" if proxy_count > 0 else "no proxies"
    scrapling_status = "with AsyncFetcher" if HAS_ASYNC_FETCHER else "with sync Fetcher" if Fetcher else "without Scrapling (no email extraction)"
    log(f"Scraping {args.state} for '{args.niche}' ({total} cities, max {args.max_total} total, {args.parallel_cities}x parallel, {pw_source}, {proxy_status}, {scrapling_status})", "info")
    start_time = time.time()
    all_results = []
    seen_phones = set()
    seen_name_city = set()
    total_count = 0

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
                "--disable-gpu", "--no-zygote",
                "--disable-blink-features=AutomationControlled",
                "--window-size=1920,1080",
                "--disable-features=IsolateOrigins,site-per-process",
                "--disable-web-security",
                "--disable-features=BlockInsecurePrivateNetworkRequests",
            ]
        )

        for batch_start in range(0, len(cities), args.parallel_cities):
            if total_count >= args.max_total:
                break
            batch = cities[batch_start:batch_start + args.parallel_cities]

            async def scrape_one(city):
                proxy = pick_proxy() if PROXIES else None
                results = await scrape_city(browser, city, args.state,
                                            niche=args.niche,
                                            max_count=args.max,
                                            max_total=args.max_total,
                                            current_total=total_count,
                                            seen_phones=seen_phones,
                                            seen_name_city=seen_name_city,
                                            proxy=proxy)
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
                    break

        await browser.close()

    print(json.dumps(all_results))
    log(f"Complete! {len(all_results)} businesses in {time.time()-start_time:.0f}s", "success")


if __name__ == "__main__":
    asyncio.run(main())
