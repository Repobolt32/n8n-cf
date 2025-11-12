// server.js
const express = require('express');
const bodyParser = require('body-parser');
const { chromium } = require('playwright');

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

const USER_AGENT = process.env.DEFAULT_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

function safeUrl(base, href) {
  try {
    return new URL(href, base).href;
  } catch (e) {
    return null;
  }
}

async function tryNavigateToContact(page, baseUrl) {
  // Try obvious patterns first
  const patterns = [
    'a[href*="contact"]',
    'a[href*="Contact"]',
    'a:has-text("Contact")',
    'a:has-text("Contact Us")',
    'a:has-text("Get in touch")',
    'a[href*="contact-us"]',
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
    } catch (e) {
      // ignore selector errors and continue
    }
  }

  // also try searching page for links that contain the text "contact"
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
  } catch (e) {}

  return false;
}

async function fillHeuristics(page, data) {
  const { name, email, message } = data;
  // Candidate selectors for name/email/phone/message/company
  const nameSelectors = [
    'input[name*=name i]', 'input[id*=name i]', 'input[placeholder*=name i]',
    'input[aria-label*=name i]', 'input[placeholder*="Full Name"]'
  ];
  const emailSelectors = [
    'input[type="email"]', 'input[name*=email i]', 'input[id*=email i]', 'input[placeholder*=email i]'
  ];
  const phoneSelectors = [
    'input[name*=phone i]', 'input[id*=phone i]', 'input[placeholder*=phone i]', 'input[type=tel]'
  ];
  const messageSelectors = [
    'textarea[name*=message i]', 'textarea[id*=message i]', 'textarea[placeholder*=message i]',
    'textarea[aria-label*=message i]'
  ];
  const companySelectors = [
    'input[name*=company i]', 'input[id*=company i]', 'input[placeholder*=company i]'
  ];

  const typed = { name: false, email: false, phone: false, message: false, company: false };

  const tryFillList = async (selectors, value, key) => {
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
      } catch (e) {}
    }
    return false;
  };

  await tryFillList(emailSelectors, email, 'email');
  await tryFillList(nameSelectors, name, 'name');
  await tryFillList(messageSelectors, message, 'message');
  await tryFillList(phoneSelectors, data.phone || '', 'phone');
  await tryFillList(companySelectors, data.company || '', 'company');

  // As fallback attempt to fill the first visible input/textarea if message not set
  if (!typed.message) {
    const firstTextarea = await page.$('textarea');
    if (firstTextarea) {
      try { await firstTextarea.type(message, { delay: 20 }); typed.message = true; } catch(e){}
    }
  }

  return typed;
}

async function clickSubmit(page) {
  const submitSelectors = [
    'button[type=submit]', 'input[type=submit]', 'button:has-text("Send")',
    'button:has-text("Submit")', 'button:has-text("Send Message")', 'button:has-text("Contact Us")'
  ];
  for (const s of submitSelectors) {
    try {
      const el = await page.$(s);
      if (el) {
        await Promise.all([
          el.click().catch(()=>{}),
          page.waitForTimeout(2500)
        ]);
        return true;
      }
    } catch (e) {}
  }
  // try pressing Enter in the last filled input
  try {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    return true;
  } catch(e){}
  return false;
}

app.post('/submit', async (req, res) => {
  const { url, name, email, message } = req.body || {};
  if (!url) return res.status(400).json({ success: false, reason: 'missing url' });

  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // If contact form not found on current page, try to navigate to a contact page
    let foundForm = await page.$('form');
    if (!foundForm) {
      await tryNavigateToContact(page, url);
      foundForm = await page.$('form');
    }

    // try fill heuristics
    const fillResult = await fillHeuristics(page, { name, email, message });

    // detect captcha before submit
    const captchaDetected = !!(await page.$('iframe[src*="recaptcha"], .h-captcha, .g-recaptcha'));
    if (captchaDetected) {
      const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
      await browser.close();
      return res.json({ success: false, captcha: true, reason: 'captcha detected', screenshot });
    }

    // try submit
    const clicked = await clickSubmit(page);

    // wait a short while and check for success messages
    await page.waitForTimeout(2000);
    const html = await page.content();
    const success = /thank you|we received your message|message sent|thanks for contacting|we will contact you/i.test(html);

    let screenshot = null;
    if (!success) {
      // take screenshot for debugging
      screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
    }

    await browser.close();
    return res.json({ success: !!success, captcha: false, clicked: !!clicked, reason: success ? null : 'no success message', screenshot });
  } catch (err) {
    try { if (browser) await browser.close(); } catch(e){}
    console.error('submit error', err);
    return res.status(500).json({ success: false, reason: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Server listening on', port));
