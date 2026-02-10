# Playwright Stealth Research

> How to make Playwright undetectable by bot protection (Cloudflare, Akamai, DataDome, etc.)
>
> Last updated: 2026-02-10

## Current State of web-browse Plugin

The plugin (`index.ts`) currently uses vanilla Playwright with:
- `chromium.launch({ headless: true, args: ['--remote-debugging-port=9222'] })`
- A hardcoded Chrome 131 user agent string
- Cookie persistence via `~/.toebeans/secrets/browser-cookies.json`
- No stealth measures whatsoever

This is trivially detected by every major bot protection system.

---

## What Bot Protection Systems Detect

Detection is multi-layered. Understanding the layers is essential because different stealth approaches address different layers.

### Layer 1: TLS/Network Fingerprinting (before any HTTP)

- **JA3/JA4 fingerprinting**: The TLS ClientHello reveals cipher suites, extensions, and elliptic curves, hashed into a fingerprint. Playwright's bundled Chromium has a different JA3 than real Chrome. Cloudflare maintains a massive database of known fingerprints. This happens *before HTTP*, so a perfect user-agent header is irrelevant.
- **HTTP/2 fingerprinting**: SETTINGS frame parameters, header order, priority tree structure.
- **IP reputation**: Datacenter vs residential vs mobile ASN. IP geolocation vs claimed timezone.

### Layer 2: Browser Environment Fingerprinting (JavaScript)

- **`navigator.webdriver`**: Set to `true` in automated browsers. The most basic check.
- **CDP Runtime.enable detection**: The big one since 2024. Uses a `stack` getter trick on an Error object logged via `console.log()`. When `Runtime.enable` is active (which Playwright enables by default), CDP serializes the error, triggering the getter:
  ```javascript
  var detected = false;
  var e = new Error();
  Object.defineProperty(e, 'stack', { get() { detected = true; } });
  console.log(e);
  // detected === true means CDP Runtime.enable is active
  ```
  Recent V8 changes may have broken this specific technique, but vendors likely have alternatives.
- **Automation globals**: `window.__playwright__binding__`, `document.cdc_asdjflasutopfhvcZLmcfl_` (Selenium)
- **Canvas fingerprinting**: SwiftShader (headless Chrome's software GPU) produces a fingerprint that doesn't match any real GPU.
- **WebGL fingerprinting**: `WEBGL_debug_renderer_info` exposes GPU vendor/renderer. "Google SwiftShader" is an instant flag.
- **`chrome.runtime`, `chrome.app`, `chrome.csi`, `chrome.loadTimes`**: Real Chrome has these; headless Chromium often doesn't.
- **Media codecs**: Headless Chromium lacks proprietary codecs (H.264, AAC).
- **Screen/window dimensions**: `window.outerWidth`/`outerHeight` are 0 in headless mode.
- **`navigator.plugins`**: Empty in headless Chrome; real Chrome has at least PDF Viewer.
- **`navigator.languages`**: Must be consistent with `Accept-Language` header.
- **`navigator.hardwareConcurrency`**, **`navigator.deviceMemory`**: Can reveal virtual environments.

### Layer 3: Cross-Context Consistency

- UA claims "Chrome on Windows" but WebGL renderer says "Apple"? Flagged.
- Timezone doesn't match IP geolocation? Flagged.
- Fingerprint attributes must be consistent across main context, iframes, and workers.

### Layer 4: Input/Behavioral Analysis

- **CDP input artifacts**: CDP dispatches events where `e.pageX === e.screenX && e.pageY === e.screenY` (unless fullscreen). Real input never does this. CDP also can't dispatch CoalescedEvents.
- **Mouse movement patterns**: Linear paths, perfect precision, no micro-movements.
- **Typing patterns**: Uniform inter-key timing, no corrections.
- **Scroll patterns**: Uniform, no momentum.
- **Timing**: Too fast, too regular, no idle/blur/focus events.

### Layer 5: HTTP-Level Signals

- Default headless UA includes "HeadlessChrome".
- Missing or malformed `Accept-Language`.
- `Sec-CH-UA-*` client hints must match claimed browser.
- Header order differs from real browsers.

---

## Approach 1: playwright-extra + puppeteer-extra-plugin-stealth

**How it works**: `playwright-extra` wraps Playwright to load `puppeteer-extra` plugins. The stealth plugin injects JS before page scripts to override ~17 detection vectors: `navigator.webdriver`, `chrome.runtime`, `navigator.plugins`, WebGL vendor/renderer, `window.outerWidth`/`outerHeight`, media codecs, permissions API, and more.

**Implementation difficulty**: Low. Install packages and wrap launch call.

```typescript
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
chromium.use(stealth());
const browser = await chromium.launch();
```

**Effectiveness**: **Poor.** Only works against the most basic protections. Does NOT address:
- CDP `Runtime.enable` detection (the #1 vector since 2024)
- TLS fingerprinting
- Behavioral analysis
- Input event artifacts

**Downsides**: Effectively abandoned. Last npm publish ~3 years ago. Hundreds of open issues. Maintainer MIA.

**Repo**: [puppeteer-extra](https://github.com/berstend/puppeteer-extra) | npm: `playwright-extra`, `puppeteer-extra-plugin-stealth`

**Verdict**: Not worth using. Superseded by every other approach below.

---

## Approach 2: Manual JS Injection (DIY Stealth)

**How it works**: Write custom `page.addInitScript()` to override detectable properties.

```javascript
// Remove webdriver flag
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

// Mock chrome objects
window.chrome = { runtime: { ... }, app: { ... }, csi: () => {...}, loadTimes: () => {...} };

// Fix plugins
Object.defineProperty(navigator, 'plugins', {
  get: () => [/* PDF Viewer, Chrome PDF Viewer, etc. */]
});

// WebGL vendor/renderer spoofing
const getParameter = WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter = function(parameter) {
  if (parameter === 37445) return 'Intel Inc.';
  if (parameter === 37446) return 'Intel Iris OpenGL Engine';
  return getParameter.call(this, parameter);
};

// Fix outer dimensions, hardwareConcurrency, deviceMemory, languages, etc.
```

**Implementation difficulty**: Medium-high. Must understand each detection vector, keep up with new ones, and ensure overrides survive `toString()` checks (detection scripts verify functions return `[native code]`).

**Effectiveness**: **Limited.** Same fundamental problem as stealth plugin — does NOT fix CDP-level detection, TLS fingerprinting, or input event artifacts. JS overrides can be detected via `toString()` mismatches, prototype chain inspection, and cross-context comparison.

**Downsides**: High maintenance burden. Every vendor update requires new research. You're reimplementing what stealth plugins do, but worse.

**Verdict**: Useful as a supplement, not a primary strategy.

---

## Approach 3: Persistent Browser Contexts / Real Chrome Profiles

**How it works**: Use `launchPersistentContext` with a real Chrome binary instead of bundled Chromium.

```typescript
const context = await chromium.launchPersistentContext('/path/to/profile', {
  channel: 'chrome',       // use real Chrome, not bundled Chromium
  headless: false,         // avoid headless detection artifacts
  viewport: null,          // use natural window size
  args: ['--disable-blink-features=AutomationControlled'],
});
```

**What this fixes**:
- Real Chrome binary = genuine TLS fingerprint, proprietary codecs, Google API keys
- Persistent cookies, localStorage, browsing history = looks like a real user
- Real GPU rendering = realistic canvas/WebGL fingerprints
- System fonts present = passes font enumeration checks

**Implementation difficulty**: Low. Built-in Playwright feature.

**Effectiveness**: **Moderate.** Eliminates many Chromium-vs-Chrome fingerprint differences and the "fresh browser" signal. Does NOT fix CDP detection or `navigator.webdriver`.

**Downsides**: Can't easily parallelize (each instance needs its own profile). Heavy on disk. Profile corruption possible. Requires Chrome installed on the system.

**Verdict**: Essential building block. Should be combined with CDP fixes (approach 5 or 6).

---

## Approach 4: External Chrome + CDP Connection

**How it works**: Launch Chrome yourself, then connect Playwright to it:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-profile
```

```typescript
const browser = await chromium.connectOverCDP('http://localhost:9222');
const context = browser.contexts()[0];
```

**Why it helps**:
- Full control over Chrome binary and launch flags
- Strip automation flags (`--enable-automation`)
- Genuine TLS fingerprint, GPU rendering, codec support

**Implementation difficulty**: Medium. Must manage Chrome process lifecycle, handle connection failures, manage profile directories.

**Effectiveness**: **Moderate-to-good.** Eliminates Chromium fingerprint differences. But CDP connection itself is still detectable via Runtime.enable technique. `connectOverCDP` also has lower fidelity than Playwright's native protocol.

**Downsides**: CDP detection still applies. Some Playwright features have limited support. Connection management overhead.

**Verdict**: Useful when combined with rebrowser-patches. Otherwise similar to approach 3.

---

## Approach 5: rebrowser-patches ★

**What it is**: Source-level patches for Playwright that fix specific code paths responsible for automation detection leaks.

**What it patches** (4 core patches):

1. **Runtime.enable leak fix** (critical): Disables automatic `Runtime.enable` CDP command. Three modes:
   - `addBinding` (default): Uses `Runtime.addBinding` for context IDs without enabling Runtime domain
   - `alwaysIsolated`: Executes all scripts in isolated contexts
   - `enableDisable`: Brief toggle with minimal detection window

2. **SourceURL obfuscation**: Replaces Playwright markers in `//# sourceURL=` comments

3. **Utility world name**: Changes default isolation world identifier to prevent fingerprinting

4. **Browser CDP access**: Adds `_connection()` for direct protocol operations

**Usage**:
```bash
# Patch existing installation
npx rebrowser-patches@latest patch --packageName playwright-core

# Or use drop-in replacement
npm install rebrowser-playwright
```

```bash
# Configuration via environment variables
REBROWSER_PATCHES_RUNTIME_FIX_MODE=addBinding
REBROWSER_PATCHES_SOURCE_URL=generic.js
REBROWSER_PATCHES_UTILITY_WORLD_NAME=my-world
```

**Implementation difficulty**: Low. Drop-in replacement or single patch command.

**Effectiveness**: **High.** Passes Cloudflare and DataDome CDP detection. Combined with real Chrome + persistent context, one of the most effective approaches.

**Downsides**:
- `page.pause()` doesn't work with runtime fix enabled
- Patches need reapplication after dependency updates
- Still needs good proxies, fingerprints, and behavioral mimicry

**Maintenance**: Actively maintained. Tested with Playwright v1.52.0 (patch v1.0.19). Python package also available.

**Repo**: [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches) | [rebrowser.net](https://rebrowser.net/docs/patches-for-puppeteer-and-playwright)

---

## Approach 6: Patchright ★

**What it is**: A complete fork of Playwright (not just patches) with stealth modifications baked directly into the codebase.

**What it patches**:
1. **Runtime.enable**: Executes JS through isolated `ExecutionContext`s instead of enabling Runtime domain
2. **Console.enable**: Completely disabled
3. **Launch flags**: Removes `--enable-automation`, adds `--disable-blink-features=AutomationControlled`
4. **Isolated context control**: `evaluate()` etc. have `isolated_context` parameter (defaults to `true`)

**Usage**:
```typescript
import { chromium } from 'patchright';

const browser = await chromium.launchPersistentContext('./profile', {
  channel: 'chrome',
  headless: false,
  viewport: null,
});
```

**Implementation difficulty**: Very low. True drop-in replacement — change import from `playwright` to `patchright`.

**Effectiveness**: **High.** Claims to bypass Cloudflare, Kasada, Akamai, Shape/F5, DataDome, Fingerprint.com. CreepJS headless score drops from 100% to ~67% with real Chrome in headed mode.

**Downsides**:
- **Chromium only.** No Firefox or WebKit.
- Console functionality completely disabled
- Automated version deployment means occasional bugs when Playwright codebase changes

**Maintenance**: Actively maintained. Versions track Playwright releases automatically.

**Related**: [CDP-Patches](https://github.com/Kaliiiiiiiiii-Vinyzu/CDP-Patches) — OS-level input dispatch (sends mouse/keyboard at the OS level instead of via CDP, fixing `pageX === screenX` detection).

**Repo**: [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) | npm: `patchright`

---

## Approach 7: Camoufox (Firefox-based)

**What it is**: An anti-detect browser built on Firefox with modifications at the **C++ level**.

**How it works**:
- C++ level patching intercepts browser API calls. Hijacked objects appear genuinely native — no `toString()` red flags, no prototype chain anomalies.
- Uses Juggler protocol (not CDP) for Playwright automation, which is less prone to JS leaks.
- All Playwright Page Agent code is sandboxed — `__playwright__binding__` etc. invisible to page JS.
- Fingerprint rotation via BrowserForge: auto-generates consistent fingerprints (navigator, screen, WebGL, audio, fonts, timezone).
- Anti-font fingerprinting based on claimed OS.
- Human-like mouse movement (C++ rewrite of HumanCursor).
- Virtual display mode (Xvfb) for headless without headless artifacts.
- Debloated Firefox: ~200MB memory vs ~400MB stock.

**Usage** (Python):
```python
from camoufox.sync_api import Camoufox

with Camoufox(headless=True) as browser:
    page = browser.new_page()
    page.goto("https://example.com")
```

**Implementation difficulty**: Low for Python. **No native Node.js SDK** (remote server mode exists).

**Effectiveness**: **Very high.** Passes CreepJS, DataDome, Cloudflare Turnstile, Imperva, reCAPTCHA v2/v3, Fingerprint.com. C++ level patching is fundamentally harder to detect than JS injection.

**Downsides**:
- Firefox only — some sites behave differently or block Firefox
- Cannot spoof Chromium-specific fingerprints
- Python-only SDK (Node.js requires remote server)
- Original maintainer (@daijro) hospitalized since March 2025; community fork by @coryking upgraded to Firefox 142.0.1

**Repo**: [camoufox](https://github.com/daijro/camoufox) | [camoufox.com](https://camoufox.com/) | Fork: [coryking/camoufox](https://github.com/coryking/camoufox)

---

## Approach 8: Nodriver / Zendriver (CDP-Minimal)

**What it is**: The successor to `undetected-chromedriver`. Fundamentally different architecture: no WebDriver, no Selenium, no chromedriver binary. Communicates directly with Chrome via CDP but avoids enabling high-risk domains.

**Key techniques**:
- **CDP-minimal**: Doesn't enable `Runtime`, `Console`, or other leak-prone domains
- **OS-level input**: Sends mouse/keyboard events at the OS level (indistinguishable from human)
- **No automation binary**: Uses stock Chrome directly

**Zendriver**: Active fork of Nodriver with faster development. Achieved 75% bypass rate across Cloudflare, CloudFront, Akamai, and DataDome in benchmarks — highest of any tested tool.

**Implementation difficulty**: Low-medium. Python-only. Async-only API.

**Effectiveness**: **High.** Consistently bypasses protections that block Patchright. Lack of traditional automation signatures means fewer detection patterns.

**Downsides**: Python only. Async-only. Fewer features than Playwright. Smaller community.

---

## Approach 9: BotBrowser (Modified Chromium Binary)

**What it is**: Custom Chromium binary compiled with C++ source-level modifications.

**Modifications**:
- Deterministic Canvas/WebGL/WebGPU/Audio noise
- Embedded font engines for cross-platform rendering consistency
- Native CDP integration with minimized fingerprint leakage
- Full-proxy QUIC/STUN (UDP over SOCKS5)
- No JS-level modifications (nothing to detect via `toString()`)
- Cross-platform fingerprint unification

**Effectiveness**: **Very high.** The most technically advanced approach.

**Downsides**: Requires building Chromium from source (hours). Heavy binary distribution. Considered dangerous in anti-fraud contexts.

**Repo**: [BotBrowser](https://github.com/botswin/BotBrowser)

---

## Approach 10: Other Tools & Services

### Ulixee Hero (formerly SecretAgent)
Node.js framework built from scratch for undetectability. Emulates real browser fingerprints from a database, realistic input patterns, TLS fingerprint matching. Currently in alpha.
- [ulixee/hero](https://github.com/ulixee/hero)

### SeleniumBase + Playwright
SeleniumBase's "Undetected ChromeDriver" mode launches a stealthy Chrome session, then Playwright connects via `connect_over_cdp()`. Piggybacks on SeleniumBase's stealth infrastructure.
- [SeleniumBase Stealthy Playwright](https://seleniumbase.io/examples/cdp_mode/playwright/ReadMe/)

### Commercial Anti-Detect Browsers
- **Multilogin** ($99+/month): Mimic (Chromium) and Stealthfox (Firefox). Deep fingerprint customization.
- **Kameleo**: Highly customizable profiles, claims Pixelscan bypass. Has automation API.
- **GoLogin**: Budget alternative. Orbita browser (Chromium-based).
- **Nstbrowser**: Free tier. Dynamic fingerprint generation, Playwright integration.

### Residential Proxies (Essential Complement)
Datacenter IPs are trivially flagged. Quality proxies are as important as browser stealth.
- **Residential**: Real ISP IPs. Required for serious anti-bot bypass.
- **Mobile**: Even more trusted (carrier-grade NAT, many real users per IP).
- **ISP proxies**: Static residential IPs. Best for persistent sessions.
- Providers: Bright Data, Oxylabs, SOAX, IPRoyal.

### CAPTCHA Solving Services
When stealth fails: 2Captcha, CapSolver, Anti-Captcha. API-based human/AI solving for Cloudflare Turnstile, reCAPTCHA, hCaptcha.

---

## Comparison Matrix

| Approach | CDP Fix | TLS Fix | Fingerprint | Input Fix | Difficulty | Node.js | Maintenance |
|---|---|---|---|---|---|---|---|
| playwright-extra stealth | No | No | Partial | No | Low | Yes | Dead |
| Manual JS injection | No | No | Partial | No | High | Yes | DIY |
| Persistent context + real Chrome | No | Yes | Good | No | Low | Yes | N/A |
| External Chrome + CDP | No | Yes | Good | No | Medium | Yes | N/A |
| **rebrowser-patches** | **Yes** | No | No | No | Low | Yes | Active |
| **Patchright** | **Yes** | No | No | No | Very Low | Yes | Active |
| Camoufox | Yes | N/A (FF) | Excellent | Partial | Low | Python only | Community |
| Nodriver/Zendriver | Yes | Yes | Good | Yes | Low | Python only | Active |
| BotBrowser | Yes | Yes | Excellent | Yes | High | Yes | Active |

---

## Effectiveness by Vendor

| Approach | Cloudflare | DataDome | Akamai | PerimeterX | Kasada |
|---|---|---|---|---|---|
| Vanilla Playwright | No | No | No | No | No |
| playwright-extra stealth | Weak | No | Weak | No | No |
| Patchright + real Chrome | Yes | Yes | Yes | Partial | Yes |
| rebrowser-patches + Chrome | Yes | Yes | Partial | Partial | Partial |
| Camoufox | Yes | Yes | Yes | Yes | Partial |
| Nodriver/Zendriver | Yes | Partial | Yes | Partial | Partial |
| BotBrowser | Yes | Yes | Yes | Yes | Yes |

Results depend heavily on proxy quality, fingerprint consistency, and behavioral patterns.

---

## Recommended Strategy for toebeans

### Minimum Viable Stealth (Node.js/TypeScript, easiest)

1. **Replace `playwright` with `patchright`** — drop-in, fixes CDP leaks
2. **Use `channel: 'chrome'`** — real Chrome binary, genuine TLS/fingerprints
3. **Use `launchPersistentContext`** — warm profile with cookies/state
4. **Run headed** or use Xvfb — avoid headless artifacts
5. **Set `--disable-blink-features=AutomationControlled`** — removes webdriver flag

This combo should handle Cloudflare, Akamai, and DataDome for most sites.

### Full Stealth Stack (if minimum isn't enough)

6. Add residential proxy rotation
7. Implement human-like delays and mouse movement
8. Ensure fingerprint consistency (timezone ↔ IP geo, language ↔ locale)
9. Use CAPTCHA solving service as fallback
10. Consider Camoufox (via remote server) for the hardest targets

### The Generational Insight

The field has evolved through three generations:
1. **Gen 1 (2018-2022)**: JS property patching. Mostly dead.
2. **Gen 2 (2023-2024)**: CDP leak patching. Currently mainstream. (Patchright, rebrowser-patches)
3. **Gen 3 (2024-2026)**: CDP-free architectures and C++-level browser modification. Emerging frontier. (Nodriver, Camoufox, BotBrowser)

No single tool is a silver bullet. Detection is multi-layered and probabilistic. The winning strategy combines protocol-level stealth + real browser binary + consistent fingerprinting + quality proxies + behavioral realism.

---

## References

- [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches)
- [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)
- [CDP-Patches (OS-level input)](https://github.com/Kaliiiiiiiiii-Vinyzu/CDP-Patches)
- [Camoufox](https://github.com/daijro/camoufox) | [camoufox.com](https://camoufox.com/)
- [BotBrowser](https://github.com/botswin/BotBrowser)
- [Ulixee Hero](https://github.com/ulixee/hero)
- [SeleniumBase Stealthy Playwright](https://seleniumbase.io/examples/cdp_mode/playwright/ReadMe/)
- [Rebrowser blog: Runtime.enable detection](https://rebrowser.net/blog/how-to-fix-runtime-enable-cdp-detection-of-puppeteer-playwright-and-other-automation-libraries)
- [Castle.io: From Puppeteer Stealth to Nodriver](https://blog.castle.io/from-puppeteer-stealth-to-nodriver-how-anti-detect-frameworks-evolved-to-evade-bot-detection/)
- [Castle.io: Why CDP signal stopped working](https://blog.castle.io/why-a-classic-cdp-bot-detection-signal-suddenly-stopped-working-and-nobody-noticed/)
- [DataDome: Headless Chrome & CDP Signal](https://datadome.co/threat-research/how-new-headless-chrome-the-cdp-signal-are-impacting-bot-detection/)
- [Browserless: TLS Fingerprinting](https://www.browserless.io/blog/tls-fingerprinting-explanation-detection-and-bypassing-it-in-playwright-and-puppeteer)
- [Nodriver benchmark comparison](https://medium.com/@dimakynal/baseline-performance-comparison-of-nodriver-zendriver-selenium-and-playwright-against-anti-bot-2e593db4b243)
- [ScrapeOps: Make Playwright Undetectable](https://scrapeops.io/playwright-web-scraping-playbook/nodejs-playwright-make-playwright-undetectable/)
- [Detecting Headless Chrome 2024](https://deviceandbrowserinfo.com/learning_zone/articles/detecting-headless-chrome-puppeteer-2024)
