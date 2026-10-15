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
                await route.fulfill(status=200, content_type="application/json", body=json.dumps({"tokens": {}, "solUsd": 150}))
            async def one(route):
                url = route.request.url
                if "mint=" + MINT in url or "mint=" in url and "bad" not in url:
                    await route.fulfill(status=200, content_type="application/json", body=json.dumps({"token": {"mint": MINT, "name": "Search Coin", "symbol": "SRC", "imageUrl": None, "priceUsd": 0.0123, "marketCapUsd": 1234567, "liquidityUsd": 54321, "volume": {"m5": 1, "h1": 2, "h6": 3, "h24": 4567}, "change": {"m5": 1.5, "h1": -2.5, "h6": 3, "h24": 4}, "txns1h": {"buys": 10, "sells": 4}, "pairAddress": "PairAddr1111111111111111111111111111111111", "dexId": "pumpswap", "pairCreatedAt": 1, "url": "https://dexscreener.com/solana/x", "websites": [], "socials": []}}))
                else: await route.continue_()
            await pg.route("**/api/tokens?**", tokens)
            await pg.route("**/api/token?**", one)
            await pg.goto(BASE + "/app"); await pg.wait_for_timeout(1500)
            # --- tokens tab (default, works signed out) ---
            await pg.wait_for_selector(".tkcard", timeout=8000)
            n_new = await pg.locator(".tkcard").count()
            assert n_new >= 3, f"expected live cards, got {n_new}"
            if name == "d":
                cols = await pg.locator(".col").count(); assert cols == 3
                assert await pg.locator(".col:nth-child(1) .tkcard").count() <= 10, "limit is 10 per list"
                assert await pg.locator(".col:nth-child(2) .tkcard").count() >= 1, "final stretch fills from the stream"
                assert await pg.locator(".col:nth-child(3) .tkcard").count() == 1, "migration shows up"
            await pg.get_by_label("Contract address").fill("not-an-address"); await pg.get_by_role("button", name="Search").click()
            await pg.wait_for_selector("text=Paste a full Solana token address")
            await pg.get_by_label("Contract address").fill(MINT); await pg.get_by_role("button", name="Search").click()
            await pg.wait_for_selector("text=Search Coin"); await pg.wait_for_selector("iframe[src*='dexscreener.com/solana/PairAddr']")
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
            await pg.get_by_role("switch", name="Start robot").click(); await pg.wait_for_selector("text=Robot started", timeout=8000)
            assert "on" in (await pg.locator(".rbar").get_attribute("class")), "bar is green while trading"
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
            assert "off" in (await pg.locator(".rbar").get_attribute("class")), "bar is red when off"
            await pg.wait_for_timeout(600)
            await pg.screenshot(path=f"{OUT}/{name}_6_final.png", full_page=True)
            ov = await pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
            results.append((name, "overflow", ov, "errors", errs[:4]))
            await ctx.close()
        await b.close()
        print(json.dumps(results))
asyncio.run(main())
