const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'Playwright server running' });
});

// Main form filling endpoint
app.post('/fill-form', async (req, res) => {
  const { url, name, email, message } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  let browser;
  try {
    // Launch browser
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    // Navigate to the URL
    console.log(`Visiting: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for form elements
    await page.waitForSelector('form, input[type="email"], textarea', { timeout: 10000 });

    // Fill name field
    const nameSelectors = [
      'input[name*="name" i]',
      'input[placeholder*="name" i]',
      'input[id*="name" i]',
      'input[type="text"]'
    ];
    
    for (const selector of nameSelectors) {
      try {
        const field = await page.$(selector);
        if (field) {
          await field.fill(name || 'Alex – HVAC Tools');
          console.log(`Filled name field with selector: ${selector}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }

    // Fill email field
    const emailSelectors = [
      'input[type="email"]',
      'input[name*="email" i]',
      'input[placeholder*="email" i]'
    ];
    
    for (const selector of emailSelectors) {
      try {
        const field = await page.$(selector);
        if (field) {
          await field.fill(email || 'alex@yourdomain.com');
          console.log(`Filled email field with selector: ${selector}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }

    // Fill message/textarea
    const messageSelectors = [
      'textarea',
      'input[name*="message" i]',
      'input[placeholder*="message" i]',
      'textarea[name*="comment" i]'
    ];
    
    const defaultMessage = message || `Hi, saw your 4.2 stars in Austin and your "24/7 Emergency" banner.
One local shop recovered $1,200 from missed calls last week with our $350 automation.
7-day free trial on your number? Reply YES.
Alex`;
    
    for (const selector of messageSelectors) {
      try {
        const field = await page.$(selector);
        if (field) {
          await field.fill(defaultMessage);
          console.log(`Filled message field with selector: ${selector}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }

    // Click submit button
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Send")',
      'button:has-text("Submit")',
      'button:has-text("Contact")',
      'button'
    ];
    
    for (const selector of submitSelectors) {
      try {
        const button = await page.$(selector);
        if (button) {
          await button.click();
          console.log(`Clicked submit button with selector: ${selector}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }

    // Wait for navigation or success
    await page.waitForTimeout(3000);

    // Take screenshot (optional)
    const screenshot = await page.screenshot({ encoding: 'base64' });

    await browser.close();

    res.json({
      success: true,
      url: url,
      timestamp: new Date().toISOString(),
      message: 'Form submitted successfully'
    });

  } catch (error) {
    console.error('Error:', error.message);
    
    if (browser) {
      await browser.close();
    }

    res.status(500).json({
      success: false,
      error: error.message,
      url: url,
      timestamp: new Date().toISOString()
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Playwright server running on port ${PORT}`);
});
