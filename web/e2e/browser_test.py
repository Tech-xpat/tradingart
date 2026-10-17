"""Drives the REAL UI in Chromium with a mock Wallet-Standard wallet (signs with a real ed25519 key held by this script)."""
import asyncio, base64, json, os, sys
import nacl.signing, nacl.encoding
from playwright.async_api import async_playwright

BASE = "http://localhost:3120"; OUT = sys.argv[1] if len(sys.argv) > 1 else "shots"
os.makedirs(OUT, exist_ok=True)
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58(b):
    n = int.from_bytes(b, "big"); s = ""
    while n: n, r = divmod(n, 58); s = B58[r] + s
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + s

MOCK_T = """
(() => {
  const pub = new Uint8Array(%s);
  const address = %s;
  const chains = ['solana:mainnet', 'solana:devnet', 'solana:localnet'];
  const account = { address, publicKey: pub, chains, features: ['solana:signMessage', 'solana:signTransaction', 'solana:signAndSendTransaction'], label: 'Mock' };
  const wallet = {
    version: '1.0.0', name: 'Mock Wallet', icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiPjxyZWN0IHdpZHRoPSIxIiBoZWlnaHQ9IjEiIGZpbGw9IiNjNmZmM2QiLz48L3N2Zz4=',
    chains, accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => {} },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signMessage': { version: '1.0.0', signMessage: async (...inputs) => Promise.all(inputs.map(async (i) => ({ signedMessage: i.message, signature: new Uint8Array(await window.__sign(Array.from(i.message))) }))) },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: async (...inputs) => Promise.all(inputs.map(async (i) => ({ signedTransaction: i.transaction }))) },
      'solana:signAndSendTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signAndSendTransaction: async (...inputs) => inputs.map(() => ({ signature: crypto.getRandomValues(new Uint8Array(64)) })) },
    },
  };
  const cb = ({ register }) => register(wallet);
  try { window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: cb })); } catch (e) {}
  try { window.addEventListener('wallet-standard:app-ready', ({ detail }) => cb(detail)); } catch (e) {}
})();
"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        results = []
        for name, vw, vh, dpr, touch in [("d", 1280, 900, 1, False), ("m", 390, 844, 2, True)]:
            sk = nacl.signing.SigningKey.generate(); pub = bytes(sk.verify_key)
            MOCK = MOCK_T % (json.dumps(list(pub)), json.dumps(b58(pub)))
            ctx = await b.new_context(viewport={"width": vw, "height": vh}, device_scale_factor=dpr, has_touch=touch, is_mobile=touch)
            pg = await ctx.new_page(); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.on("console", lambda m: errs.append(m.text) if m.type == "error" and "fonts" not in m.text and "ERR_" not in m.text and "Failed to load resource" not in m.text else None)
            await pg.route("**/fonts.g*/**", lambda r: r.abort())
            async def sign(arr): return list(sk.sign(bytes(arr)).signature)
            await pg.expose_function("__sign", sign)
            await pg.add_init_script(MOCK)
            MINT = "FoTestMint" + "1" * 34
            def on_ws(ws):
                def on_msg(m):
                    try: d = json.loads(m)
                    except Exception: return
                    if d.get("method") == "subscribeNewToken":
                        for i in range(12):
                            ws.send(json.dumps({"txType": "create", "mint": ("Mint%02d" % i) + "A" * 38, "name": "Coin %d" % i, "symbol": "C%d" % i, "uri": "", "marketCapSol": 30 + i, "vSolInBondingCurve": 31 + i * 7, "solAmount": 0.5}))
                        ws.send(json.dumps({"txType": "migrate", "mint": "MintMig" + "B" * 37}))
                ws.on_message(on_msg)
            await pg.route_web_socket("wss://pumpportal.fun/**", on_ws)
            async def tokens(route):
                import urllib.parse
                ms = urllib.parse.parse_qs(urllib.parse.urlparse(route.request.url).query).get("mints", [""])[0].split(",")
                tv = lambda m: {"mint": m, "name": "Dex Coin", "symbol": "DXC", "imageUrl": "https://dd.dexscreener.com/ds-data/tokens/solana/x.png", "priceUsd": 0.00042, "marketCapUsd": 420000, "liquidityUsd": 30000, "volume": {"m5": 1, "h1": 5000, "h6": 3, "h24": 9000}, "change": {"m5": 1, "h1": 7.5, "h6": 3, "h24": 4}, "txns1h": {"buys": 60, "sells": 30}, "pairAddress": "P" * 40, "dexId": "pumpswap", "pairCreatedAt": 1, "url": None, "websites": ["https://x.io"], "socials": []}
                await route.fulfill(status=200, content_type="application/json", body=json.dumps({"tokens": {m: tv(m) for m in ms[:3] if m}, "solUsd": 150}))
            async def one(route):
                url = route.request.url
                if "mint=" + MINT in url or "mint=" in url and "bad" not in url:
                    await route.fulfill(status=200, content_type="application/json", body=json.dumps({"token": {"mint": MINT, "name": "Search Coin", "symbol": "SRC", "imageUrl": None, "priceUsd": 0.0123, "marketCapUsd": 1234567, "liquidityUsd": 54321, "volume": {"m5": 1, "h1": 2, "h6": 3, "h24": 4567}, "change": {"m5": 1.5, "h1": -2.5, "h6": 3, "h24": 4}, "txns1h": {"buys": 10, "sells": 4}, "pairAddress": "PairAddr1111111111111111111111111111111111", "dexId": "pumpswap", "pairCreatedAt": 1, "url": "https://dexscreener.com/solana/x", "websites": [], "socials": []}}))
                else: await route.continue_()
            await pg.route("**/api/tokens?**", tokens)
            async def img(route):
                await route.fulfill(status=200, content_type="image/gif", body=base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"))
            await pg.route("**/api/img?**", img)
            await pg.route("**/api/token?**", one)
            async def chart(route):
                import time
                now = int(time.time()); path = [100]*3 + [100 - i*5 for i in range(1, 9)] + [60 + i*4 for i in range(1, 6)] + [80 - i*4 for i in range(1, 5)] + [64 + i*2 for i in range(1, 5)]
                bars = [[now - (len(path) - i) * 5, p, p + 1, p - 1, p, 0.5, 1, 0] for i, p in enumerate(path)]
                await route.fulfill(status=200, content_type="application/json", body=json.dumps({"chart": {"mint": MINT, "name": "Search Coin", "symbol": "SRC", "uri": None, "firstSeen": "2026-10-16T10:00:00Z", "mcapSol": 72, "vSol": 50, "migrated": False, "bars": bars, "bars1m": [], "bars5m": [], "trades": [[int(time.time()*1000) - i*3000, "b" if i % 3 else "s", 0.5 + i*0.1, 70 + i, "Abcd…wxyz", "sig%d" % i] for i in range(12)], "updatedAt": "2026-10-16T10:05:00Z"}}))
            await pg.route("**/api/chart?**", chart)
            async def board(route):
                import time
                row = lambda n, v: {"mint": n.ljust(44, "A"), "name": n, "symbol": n[:3].upper(), "uri": None, "createdAt": int(time.time()*1000) - 600000, "mcapSol": 60, "vSol": v, "migrated": False, "migratedAt": None, "stats": {"c5": 12.5, "c1h": 30, "volSol1h": 9, "buys1h": 30, "sells1h": 12}, "image": None, "description": None, "thumb": False, "updatedAt": int(time.time()*1000)}
                await route.fulfill(status=200, content_type="application/json", body=json.dumps({"new": [row("Fresh", 35)], "stretch": [row("Climber", 90)], "migrated": [], "trending": [row("Hotone", 40)], "topProgress": 0.7, "solUsd": 150}))
            await pg.route("**/api/board", board)
            await pg.goto(BASE + "/app"); await pg.wait_for_timeout(1500)
            # --- tokens tab (default, works signed out) ---
            await pg.wait_for_selector(".tkcard", timeout=8000)
            n_new = await pg.locator(".tkcard").count()
            assert n_new >= 3, f"expected live cards, got {n_new}"
            if name == "d":
                cols = await pg.locator(".col").count(); assert cols == 3
                assert await pg.locator(".col:nth-child(1) .tkcard").count() <= 20, "limit is 20 per list"
                assert await pg.locator(".col:nth-child(2) .tkcard").count() >= 1, "final stretch fills from the stream"
                assert await pg.locator(".col:nth-child(3) .tkcard").count() == 1, "migration shows up"
            # each card carries figures + a risk bar together, and token images are the small proxied thumbnails
            assert await pg.locator(".tkcard .riskbar").count() == await pg.locator(".tkcard").count(), "every card has a risk bar"
            first = await pg.locator(".tkcard").first.inner_text(); assert "Price" in first and "MC" in first and "Vol" in first and "Liq" in first, first
            await pg.wait_for_selector(".tkcard img", timeout=15000)
            imgs = await pg.locator(".tkcard img").evaluate_all("els => els.map(e => e.src)")
            assert imgs and all("/api/img?" in i for i in imgs), imgs
            assert await pg.locator(".tkcard .risk.low, .tkcard .risk.medium").count() >= 1, "enriched tokens read as safer than unknowns"
            # the lists survive a refresh: saved in the browser, shown again before any socket delivers anything
            await pg.wait_for_timeout(4600)
            pg2 = await ctx.new_page()
            await pg2.route_web_socket("wss://pumpportal.fun/**", lambda ws: ws.close())
            await pg.wait_for_selector(".tchip", timeout=6000); assert await pg.locator(".tchip").count() >= 1, "trending strip"
            await pg.wait_for_selector("section[aria-label='Final stretch'] >> text=Climber", state="attached", timeout=6000)
            await pg2.goto(BASE + "/app")
            await pg2.wait_for_selector(".tkcard", timeout=5000)
            assert await pg2.locator(".tkcard").count() >= n_new, "list is back after refresh"
            await pg2.close()
            await pg.get_by_label("Contract address").fill("not-an-address"); await pg.get_by_role("button", name="Search").click()
            await pg.wait_for_selector("text=Paste a full Solana token address")
            await pg.get_by_label("Contract address").fill(MINT); await pg.get_by_role("button", name="Search").click()
            await pg.wait_for_selector("text=Search Coin"); await pg.wait_for_selector("canvas[aria-label='Price chart']"); assert await pg.locator("iframe").count() == 0 and await pg.locator("a[href*='dexscreener']").count() == 0, "no third-party chart or promo links"; await pg.wait_for_selector(".hrow.buy"); assert await pg.locator(".hrow.sell").count() >= 1, "history shows buys and sells"
            await pg.get_by_role("button", name="Watch with my robot").click(); await pg.wait_for_selector("text=Connect your wallet and sign in first"); await pg.get_by_role("button", name="Close", exact=True).first.click() if False else None
            await pg.get_by_role("tab", name="1m").click(); await pg.get_by_role("tab", name="1D").click(); await pg.get_by_role("tab", name="15s").click()
            cvb = await pg.locator("canvas[aria-label='Price chart']").bounding_box()
            await pg.get_by_label("Draw trend line").click()
            await pg.mouse.move(cvb["x"] + 80, cvb["y"] + 120); await pg.mouse.down(); await pg.mouse.move(cvb["x"] + 200, cvb["y"] + 80, steps=5); await pg.mouse.up()
            await pg.get_by_label("Draw horizontal line").click(); await pg.mouse.click(cvb["x"] + 150, cvb["y"] + 150)
            saved = await pg.evaluate("(m)=>localStorage.getItem('art:draw:'+m)", MINT); import json as _j; dl = _j.loads(saved); assert [d["kind"] for d in dl] == ["line", "h"], dl
            await pg.mouse.move(cvb["x"] + 150, cvb["y"] + 60); await pg.mouse.down(); await pg.mouse.move(cvb["x"] + 90, cvb["y"] + 60, steps=4); await pg.mouse.up()
            await pg.get_by_label("Zoom out").click(); await pg.get_by_label("Jump to live").click(); await pg.screenshot(path=f"{OUT}/{name}_0_chart.png")
            await pg.screenshot(path=f"{OUT}/{name}_0_token.png")
            await pg.get_by_label("Close").click()
            await pg.screenshot(path=f"{OUT}/{name}_0_tokens.png", full_page=True)
            await pg.screenshot(path=f"{OUT}/{name}_1_connect.png")
            await pg.get_by_role("button", name="Select Wallet").first.click(); await pg.wait_for_timeout(500)
            await pg.screenshot(path=f"{OUT}/{name}_2_modal.png")
            await pg.get_by_text("Mock Wallet").first.click(); await pg.wait_for_timeout(1200)
            await pg.get_by_role("button", name="Robot", exact=True).click()
            await pg.get_by_role("button", name="Sign in").click(); await pg.get_by_role("button", name="Create my vault").wait_for(timeout=8000)
            await pg.screenshot(path=f"{OUT}/{name}_3_signedin.png")
            await pg.get_by_role("button", name="Create my vault").click(); await pg.wait_for_selector("text=Safety limits, signed", timeout=8000)
            await pg.get_by_role("button", name="Review what I will sign").click(); await pg.wait_for_selector("text=This is exactly what your wallet will ask you to sign")
            await pg.screenshot(path=f"{OUT}/{name}_4_consent.png")
            await pg.get_by_role("button", name="Sign with my wallet").click(); await pg.wait_for_selector("text=Consent signed and saved", timeout=8000)
            # plans: starter plans, edit size + age window, new plan, switch
            await pg.get_by_role("radio", name="Steady").wait_for(); await pg.get_by_role("radio", name="Sniper").wait_for()
            await pg.get_by_label("Trade size in dollars").fill("12")
            await pg.get_by_label("Maximum coin age value").fill("2"); await pg.get_by_label("Maximum coin age unit").select_option("h")
            await pg.get_by_label("Minimum coin age value").fill("45"); await pg.get_by_label("Minimum coin age unit").select_option("s")
            await pg.get_by_role("button", name="Save plan").click(); await pg.wait_for_selector("text=saved", timeout=8000)
            await pg.get_by_role("button", name="New plan").click(); await pg.wait_for_selector("text=New plan created", timeout=8000)
            await pg.get_by_role("radio", name="Sniper").click(); await pg.wait_for_timeout(900)
            assert await pg.get_by_role("radio", name="Sniper").get_attribute("aria-checked") == "true"
            await pg.get_by_role("radio", name="Steady").click(); await pg.wait_for_timeout(900)
            assert await pg.get_by_label("Trade size in dollars").input_value() == "12", "saved plan values persist"
            assert await pg.get_by_label("Maximum coin age value").input_value() == "2"
            await pg.screenshot(path=f"{OUT}/{name}_4b_plans.png", full_page=True)
            await pg.get_by_text("Robot service is not reporting in").wait_for(timeout=5000)  # no worker in this test: the banner says so
            await pg.get_by_role("switch", name="Start robot").click(); await pg.wait_for_selector("text=Robot started", timeout=8000)
            assert "on" in (await pg.locator(".rbar:not(.warnbar)").get_attribute("class")), "bar is green while trading"
            await pg.wait_for_timeout(1500)
            await pg.screenshot(path=f"{OUT}/{name}_5_running.png", full_page=True)
            await pg.get_by_role("button", name="Deposit", exact=True).click()
            await pg.get_by_role("button", name="Deposit from my wallet").click()
            try:
                await pg.wait_for_selector("text=Sent. It shows", timeout=8000)
            except Exception:
                print("FUND FAILED:", await pg.locator(".note").all_inner_texts(), [e[:200] for e in errs[:5]]); raise
            await pg.get_by_role("button", name="Withdraw", exact=True).click()
            await pg.get_by_placeholder("Amount in SOL, blank = all").fill("0.1")
            await pg.get_by_role("button", name="Review withdrawal").click(); await pg.wait_for_selector("text=Your wallet will ask you to sign this")
            await pg.get_by_role("button", name="Sign and withdraw").click(); await pg.wait_for_selector("text=Withdrawal requested", timeout=8000)
            await pg.get_by_role("switch", name="Pause robot").click(); await pg.wait_for_selector("text=Robot paused", timeout=8000)
            assert "off" in (await pg.locator(".rbar:not(.warnbar)").get_attribute("class")), "bar is red when off"
            await pg.wait_for_timeout(600)
            await pg.screenshot(path=f"{OUT}/{name}_6_final.png", full_page=True)
            # --- leaderboard: opt in for real, then browse a mocked board + profile, copy plan ---
            await pg.get_by_label("Leaderboard handle").fill("Coach_" + name + os.urandom(2).hex())
            assert await pg.get_by_role("button", name="Hide me from the leaderboard").count() == 1, "listed by default"
            await pg.get_by_role("button", name="Hide me from the leaderboard").click(); await pg.wait_for_selector("text=You are hidden from the leaderboard", timeout=8000)
            await pg.get_by_role("button", name="Show me on the leaderboard").click(); await pg.wait_for_selector("text=You are on the leaderboard", timeout=8000)
            curve = [0, 0.01, 0.008, 0.03, 0.05]
            async def board(route):
                await route.fulfill(status=200, content_type="application/json", body=json.dumps({"mode": "live", "period": "7d", "board": [
                    {"rank": 1, "handle": "alpha", "me": False, "followers": 3, "pnlSol": 1.234, "pnlUsd": 185.1, "roiPct": 42, "winRate": 61, "trades": 33, "curve": curve},
                    {"rank": 2, "handle": "coach_m", "me": True, "followers": 0, "pnlSol": -0.2, "pnlUsd": -30, "roiPct": -5, "winRate": 40, "trades": 5, "curve": [0, -0.1, -0.2]}]}))
            async def prof(route):
                await route.fulfill(status=200, content_type="application/json", body=json.dumps({"handle": "alpha", "me": False, "mode": "live", "following": False, "followers": 3,
                    "stats": {"pnlSol": 1.234, "pnlUsd": 185.1, "todaySol": 0.1, "roiPct": 42, "winRate": 61, "trades": 33},
                    "curve": [[i, v] for i, v in enumerate(curve)], "open": [{"mint": MINT, "openedAt": 1, "lastPnl": 12.5, "trail": [[1, 0], [2, 5], [3, 12.5]], "takeProfitPct": 50, "stopLossPct": 25}],
                    "recent": [{"at": "2026-10-15T10:00:00Z", "mint": MINT, "realizedSol": 0.02, "pct": 40, "holdSec": 95, "reason": "take_profit"}],
                    "plan": {"sizeUsd": 7, "minAgeSec": 30, "maxAgeSec": 1800, "takeProfitPct": 50, "stopLossPct": 25, "maxHoldMin": 3, "scanEverySec": 20, "maxTradesDay": 20, "minLiqUsd": 4000, "minVol1hUsd": 500, "minBuys1h": 5, "requireRising": False}}))
            copies = []
            async def copy(route):
                copies.append(route.request.post_data); await route.fulfill(status=200, content_type="application/json", body="{\"ok\":true}")
            await pg.route("**/api/leaderboard?**", board); await pg.route("**/api/profile?**", prof); await pg.route("**/api/copy", copy)
            await pg.get_by_role("button", name="Leaders", exact=True).click()
            await pg.get_by_role("button", name="Open @alpha").wait_for(timeout=8000)
            assert await pg.locator(".lbrow").count() == 2
            await pg.screenshot(path=f"{OUT}/{name}_7_leaders.png", full_page=True)
            await pg.get_by_role("button", name="Open @alpha").click(); await pg.wait_for_selector("text=Progress map")
            await pg.wait_for_selector("text=Trading now"); await pg.wait_for_selector("text=Their plan")
            await pg.screenshot(path=f"{OUT}/{name}_8_profile.png", full_page=True)
            await pg.get_by_role("button", name="Copy plan").click(); await pg.wait_for_selector("text=Saved @alpha")
            await pg.get_by_role("button", name="Auto-copy").click(); await pg.wait_for_selector("text=Auto-copy on")
            assert any('"auto":true' in (c or "") for c in copies) and any('"auto":false' in (c or "") for c in copies), copies
            await pg.get_by_label("Close").click()
            ov = await pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
            results.append((name, "overflow", ov, "errors", errs[:4]))
            await ctx.close()
        await b.close()
        print(json.dumps(results))
asyncio.run(main())
