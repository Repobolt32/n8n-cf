// server.js
const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '2mb' }));

const USER_AGENT = process.env.DEFAULT_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

function safeUrl(base, href) {
  try { return new URL(href, base).href; } catch (e) { return null; }
}

async function tryNavigateToContact(page, baseUrl) {
  const patterns = [
    'a[href*="contact"]',
    'a:has-text("Contact")',
    'a:has-text("Contact Us")',
    'a[href*="contact-us"]',
    'a[href^="/contact"]',
    'a[href^="#contact"]'
  ];
  for (const sel of patterns) {
    try {
      const el = await page.$(sel);
      if (el) {
        const href = await el.getAttribute('href');
        if (href) {
          const target = safeUrl(baseUrl, href);
          if (target) {
            await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>null);
            return true;
          }
        }
      }
    } catch (e) {}
  }
  // fallback: scan anchors for "contact" text
  try {
    const anchors = await page.$$eval('a', nodes => nodes.map(n => ({ href: n.href, text: n.innerText })));
    for (const a of anchors) {
      if (!a.href) continue;
      if (/contact/i.test(a.text) || /contact/i.test(a.href)) {
        const target = safeUrl(baseUrl, a.href);
        if (target) {
          await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>null);
          return true;
        }
      }
    }
  } catch(e){}
  return false;
}

async function fillHeuristics(page, data) {
  const { name, email, message } = data;
  const nameSelectors = ['input[name*=name i]', 'input[id*=name i]', 'input[placeholder*=name i]'];
  const emailSelectors = ['input[type="email"]', 'input[name*=email i]', 'input[id*=email i]'];
  const messageSelectors = ['textarea[name*=message i]', 'textarea[id*=message i]', 'textarea[placeholder*=message i]', 'textarea'];

  const typed = { name:false, email:false, message:false };

  const tryFill = async (selectors, value, key) => {
    if (!value) return false;
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.fill('');
          await el.type(value, { delay: 20 });
          typed[key] = true;
          return true;
        }
      } catch(e){}
    }
    return false;
  };

  await tryFill(emailSelectors, email, 'email');
  await tryFill(nameSelectors, name, 'name');
  await tryFill(messageSelectors, message, 'message');

  // fallback: fill first textarea if message not typed
  if (!typed.message) {
    const ta = await page.$('textarea');
    if (ta && message) {
      try { await ta.type(message, { delay: 20 }); typed.message = true; } catch(e){}
    }
  }

  return typed;
}

async function clickSubmit(page) {
  const submitSelectors = [
    'button[type=submit]', 'input[type=submit]',
    'button:has-text("Send")', 'button:has-text("Send Message")',
    'button:has-text("Submit")', 'button:has-text("Contact")'
  ];
  for (const s of submitSelectors) {
    try {
      const el = await page.$(s);
      if (el) {
        await Promise.all([ el.click().catch(()=>{}), page.waitForTimeout(2500) ]);
        return true;
      }
    } catch(e){}
  }
  try { await page.keyboard.press('Enter'); await page.waitForTimeout(1500); return true; } catch(e){}
  return false;
}

app.get('/', (req, res) => res.json({ status: 'Playwright server running' }));

app.post('/submit', async (req, res) => {
  const { url, name, email, message } = req.body || {};
  if (!url) return res.status(400).json({ success:false, reason: 'missing url' });

  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // if no form visible, try to go to contact page
    const hasForm = !!(await page.$('form'));
    if (!hasForm) {
      await tryNavigateToContact(page, url);
    }

    // run fill heuristics
    await fillHeuristics(page, {name, email, message});

    // detect captcha
    const captcha = !!(await page.$('iframe[src*="recaptcha"], .h-captcha, .g-recaptcha'));
    if (captcha) {
      const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
      await browser.close();
      return res.json({ success: false, captcha: true, reason: 'captcha detected', screenshot });
    }

    // attempt submit
    const clicked = await clickSubmit(page);
    await page.waitForTimeout(2000);

    const html = await page.content();
    const success = /thank you|we received|message sent|thanks for contacting|we will contact you/i.test(html);

    let screenshot = null;
    if (!success) screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });

    await browser.close();
    return res.json({ success: !!success, captcha: false, clicked: !!clicked, reason: success ? null : 'no success message', screenshot });

  } catch (err) {
    try { if (browser) await browser.close(); } catch(e){}
    console.error('submit error', err);
    return res.status(500).json({ success:false, reason: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Playwright server running on port ${PORT}`));
