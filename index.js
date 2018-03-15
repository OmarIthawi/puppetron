const fs = require('fs');
const http = require('http');
const url = require('url');

const sleep = (time) => {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), time);
  })
};

const { URL } = require('url');
const { DEBUG, HEADFUL, CHROME_BIN, PORT } = process.env;


const puppeteer = require('puppeteer');
const jimp = require('jimp');
const pTimeout = require('p-timeout');

const blocked = require('./blocked.json');
const blockedRegExp = new RegExp('(' + blocked.join('|') + ')', 'i');

const truncate = (str, len) => str.length > len ? str.slice(0, len) + '…' : str;

let browser;

require('http').createServer(async (req, res) => {
  const { host } = req.headers;

  if (req.url == '/'){
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8'
    });
    res.end(fs.readFileSync('index.html'));
    return;
  }

  if (req.url == '/favicon.ico'){
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url == '/status'){
    res.writeHead(200, {
      'content-type': 'application/json',
    });
    res.end('');
    return;
  }

  const action = 'screenshot';

  let page, pageURL;
  try {
    const queryParams = url.parse(req.url, true).query;
    const pageURL = queryParams.url;
    if (!pageURL) {
      throw new Exception('Missing URL.');
    }

    console.log('Screenshotting:', pageURL)

    let actionDone = false;
    const width = parseInt(queryParams.width, 10) || 1024;
    const height = parseInt(queryParams.height, 10) || 768;

    if (!browser) {
      console.log('🚀 Launch browser!');
      const config = {
        ignoreHTTPSErrors: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox'
        ],
      };
      if (DEBUG) config.dumpio = true;
      if (HEADFUL) {
        config.headless = false;
        config.args.push('--auto-open-devtools-for-tabs');
      }
      if (CHROME_BIN) config.executablePath = CHROME_BIN;
      browser = await puppeteer.launch(config);
    }
    page = await browser.newPage();

    const nowTime = +new Date();
    let reqCount = 0;
    await page.setRequestInterceptionEnabled(true);
    page.on('request', (request) => {
      const { url, method, resourceType } = request;

      // Skip data URIs
      if (/^data:/i.test(url)){
        request.continue();
        return;
      }

      const seconds = (+new Date() - nowTime) / 1000;
      const shortURL = truncate(url, 70);
      const otherResources = /^(manifest|other)$/i.test(resourceType);
      // Abort requests that exceeds 15 seconds
      // Also abort if more than 100 requests
      if (seconds > 15 || reqCount > 100 || actionDone){
        console.log(`❌⏳ ${method} ${shortURL}`);
        request.abort();
      } else if (blockedRegExp.test(url) || otherResources){
        console.log(`❌ ${method} ${shortURL}`);
        request.abort();
      } else {
        console.log(`✅ ${method} ${shortURL}`);
        request.continue();
        reqCount++;
      }
    });

    let responseReject;
    const responsePromise = new Promise((_, reject) => {
      responseReject = reject;
    });
    page.on('response', ({ headers }) => {
      const location = headers['location'];
      if (location && location.includes(host)){
        responseReject(new Error('Possible infinite redirects detected.'));
      }
    });

    console.log('⬇️ Fetching ' + pageURL);
    await Promise.race([
      responsePromise,
      page.goto(pageURL, {
        waitUntil: 'networkidle',
      })
    ]);

    console.log('💥 Perform action: ' + action);

    // Arbitrary wait time till the rendering stabilizes
    await sleep(parseInt(process.env.PRE_SCREENSHOT_RENDER_WAIT_TIME, 10));

    const screenshot = await pTimeout(page.screenshot({
      type: 'png'
    }), 20 * 1000, 'Screenshot timed out');

    res.writeHead(200, {
      'content-type': 'image/png'
    });

    res.end(screenshot, 'binary');

    actionDone = true;
    console.log('💥 Done action: ' + action);
  } catch (e) {
    if (!DEBUG && page) {
      console.error(e);
      console.log('💔 Force close ' + pageURL);
      page.removeAllListeners();
      page.close();
    }
    const { message = '' } = e;
    res.writeHead(400, {
      'content-type': 'text/plain',
    });
    console.log(e);
    res.end('Oops. Something is wrong.\n\n' + message);

    // Handle websocket not opened error
    if (/not opened/i.test(message) && browser){
      console.error('🕸 Web socket failed');
      try {
        browser.close();
        browser = null;
      } catch (err) {
        console.warn(`Chrome could not be killed ${err.message}`);
        browser = null;
      }
    }
  }
}).listen(PORT || 3000);

process.on('SIGINT', () => {
  if (browser) browser.close();
  process.exit();
});

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at:', p, 'reason:', reason);
});
