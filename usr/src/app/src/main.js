// Twitter/X "Viral Thread" Archivist Scraper (Playwright-based starter)
// - Uses PlaywrightCrawler to render X (twitter.com) thread pages reliably.
// - Extracts thread tweets, basic metrics, media links, and exports a Markdown representation.
// - Optionally saves full thread JSON to KV store and metadata to Dataset.
//
// IMPORTANT:
// - Respect X (Twitter) Terms of Service and robots.txt. This Actor is a starter — prefer official APIs when possible.
// - This code does NOT attempt to bypass login or access protected content. If you provide authenticated cookies via environment variables
//   you are responsible for credentials and compliance with TOS.

import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
  startUrls = ['https://x.com/search?q=from%3A%40elonmusk%20min_faves%3A10000'],
  maxRequestsPerCrawl = 200,
  maxThreads = 50,
  includeReplies = false,
  saveMode = 'dataset',
  kvKeyPrefix = 'x_thread_',
  headless = true,
  userAgent = 'twitterx-viral-thread-archivist (+https://example.com)',
  pageTimeoutSecs = 30
} = input;

if (!Array.isArray(startUrls) || startUrls.length === 0) {
  Actor.log.fatal('startUrls must be a non-empty array of URLs');
  await Actor.exit({ exitCode: 1 });
}

const proxyConfiguration = await Actor.createProxyConfiguration();
const kvStore = saveMode === 'kv' ? await Actor.openKeyValueStore() : null;

// Utility: extract tweet id from URL like https://x.com/{user}/status/{id}
function extractTweetId(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex((p) => p === 'status' || p === 'statuses');
    if (idx >= 0 && parts.length > idx + 1) return parts[idx + 1];
    // fallback: last numeric segment
    const m = u.pathname.match(/\/(\d+)(?:\/|$)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Build Markdown from thread tweets
function buildThreadMarkdown(tweets) {
  // tweets: [{author, text, id, createdAt, metrics, media}]
  const lines = [];
  for (const t of tweets) {
    const header = `**@${t.author}** • ${t.createdAt || ''}\n\n`;
    lines.push(header);
    lines.push((t.text || '').trim() + '\n');
    if (t.media && t.media.length) {
      for (const m of t.media) {
        lines.push(`![media](${m})\n`);
      }
    }
    lines.push('---\n');
  }
  return lines.join('\n');
}

let archived = 0;

const crawler = new PlaywrightCrawler({
  proxyConfiguration,
  maxRequestsPerCrawl,
  launchContext: {
    launchOptions: {
      headless: !!headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  },
  preNavigationHooks: [
    async ({ request, page, session, log }) => {
      // set a polite UA per input
      try {
        await page.setExtraHTTPHeaders({ 'User-Agent': userAgent });
      } catch (err) {
        log.debug('Failed to set extra HTTP headers', { error: err.message });
      }
    }
  ],
  requestHandlerTimeoutSecs: Math.max(30, pageTimeoutSecs),
  async requestHandler({ request, page, log, enqueueLinks }) {
    log.info('Visiting', { url: request.url });

    // stop if archived enough threads
    if (archived >= maxThreads) {
      log.info('Reached maxThreads limit, skipping', { maxThreads });
      return;
    }

    // If search/listing page: try to discover thread URLs and enqueue them (simple heuristics)
    if (/\/search/.test(request.url) || /\/explore/.test(request.url) || /\/hashtag\//.test(request.url)) {
      try {
        // wait a bit for results to load
        await page.waitForTimeout(1500);
        // find anchors to individual tweets
        const anchors = await page.$$eval('a[href*="/status/"], a[href*="/statuses/"]', (els) =>
          els.map((a) => a.href).filter(Boolean)
        );
        const unique = Array.from(new Set(anchors));
        const toEnqueue = unique.slice(0, Math.max(0, 50)); // limit per listing page to avoid explosion
        if (toEnqueue.length) {
          await enqueueLinks({ urls: toEnqueue.map((u) => ({ url: u })) });
          log.info('Enqueued thread links from listing', { count: toEnqueue.length });
        }
      } catch (err) {
        log.debug('Listing discovery failed', { error: err.message });
      }
      return;
    }

    // Otherwise treat as a thread/tweet page and try to archive the thread
    try {
      // Wait for tweet article to appear
      await page.waitForSelector('article', { timeout: pageTimeoutSecs * 1000 });

      // Scroll a bit to load more thread tweets if present
      await page.evaluate(() => window.scrollBy(0, 800));
      await page.waitForTimeout(1000);

      // Extract articles representing tweets on the page (root + replies shown)
      const tweets = await page.$$eval('article', (nodes) =>
        nodes.map((article) => {
          // text content often in div[lang] elements
          const textEl = article.querySelector('div[lang]');
          const text = textEl ? textEl.innerText : null;
          // author handle: anchor with href /{handle}
          let author = null;
          const authorAnchor = article.querySelector('a[href*="/"]');
          if (authorAnchor) {
            const parts = authorAnchor.getAttribute('href').split('/');
            author = parts.filter(Boolean)[0] || null;
          }
          // created time in time tag
          const timeEl = article.querySelector('time');
          const createdAt = timeEl ? timeEl.getAttribute('datetime') : (timeEl ? timeEl.innerText : null);
          // tweet id via href to status
          let id = null;
          const statusLink = article.querySelector('a[href*="/status/"], a[href*="/statuses/"]');
          if (statusLink) {
            const href = statusLink.href || statusLink.getAttribute('href');
            const m = (href || '').match(/\/status(?:es)?\/(\d+)/);
            if (m) id = m[1];
          }
          // metrics: likes/retweets/replies commonly stored in aria-labels of buttons
          const metrics = {};
          article.querySelectorAll('div[data-testid]').forEach((el) => {
            // fallback: check aria-label text like "5,123 Likes"
            const al = el.getAttribute('aria-label') || '';
            if (/like/i.test(al)) {
              const m = al.match(/([\d,\.]+)/);
              metrics.likes = m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
            } else if (/retweet|repost/i.test(al)) {
              const m = al.match(/([\d,\.]+)/);
              metrics.retweets = m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
            } else if (/reply/i.test(al)) {
              const m = al.match(/([\d,\.]+)/);
              metrics.replies = m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
            }
          });
          // media URLs: images and video sources inside the article
          const media = [];
          article.querySelectorAll('img, video source').forEach((el) => {
            const src = el.src || el.getAttribute('src') || el.getAttribute('data-src') || el.getAttribute('srcset');
            if (src) media.push(src);
          });
          return { id, author, text, createdAt, metrics, media };
        })
      );

      // Heuristic: root tweet is the first article or the one matching the URL tweet id
      const rootIdFromUrl = extractTweetId(request.url);
      let rootTweet = null;
      if (rootIdFromUrl) rootTweet = tweets.find((t) => t.id === rootIdFromUrl) || tweets[0];
      else rootTweet = tweets[0];

      const mediaUrls = [];
      for (const t of tweets) {
        if (Array.isArray(t.media)) mediaUrls.push(...t.media);
      }

      // If includeReplies is false, attempt to trim tweets to the thread sequence starting from root until a non-thread indicator
      // (best-effort: we keep all article nodes captured)
      const tweetCount = tweets.length;

      // Build Markdown representation
      const md = buildThreadMarkdown(tweets);

      // Prepare item to store
      const item = {
        threadId: rootTweet ? rootTweet.id : null,
        rootTweetId: rootTweet ? rootTweet.id : null,
        author: rootTweet ? rootTweet.author : null,
        authorName: null,
        threadUrl: request.url,
        tweetCount,
        likes: rootTweet && rootTweet.metrics ? rootTweet.metrics.likes || null : null,
        retweets: rootTweet && rootTweet.metrics ? rootTweet.metrics.retweets || null : null,
        replies: rootTweet && rootTweet.metrics ? rootTweet.metrics.replies || null : null,
        mediaUrls: mediaUrls.length ? Array.from(new Set(mediaUrls)) : null,
        threadMarkdown: md,
        kvKey: null,
        scrapedAt: new Date().toISOString()
      };

      // Save full thread JSON to KV if requested
      if (saveMode === 'kv' && kvStore) {
        const kvKey = `${kvKeyPrefix}${item.threadId || ('' + Date.now())}.json`;
        try {
          await kvStore.setValue(kvKey, { tweets, metadata: item }, { contentType: 'application/json' });
          item.kvKey = kvKey;
        } catch (err) {
          log.warning('Failed to save thread to KV', { error: err.message });
        }
      } else {
        // If saveMode=dataset, include tweets in a trimmed form in dataset item maybe too large; we keep Markdown and metadata
      }

      // Push metadata to Dataset
      await Dataset.pushData(item);
      archived += 1;
      log.info('Archived thread', { threadId: item.threadId, tweetCount });

      // optional: enqueue links to referenced tweets / retweeted threads for discovery
      // find anchors in page to other status URLs
      await enqueueLinks({ selector: 'a[href*="/status/"], a[href*="/statuses/"]' });
    } catch (err) {
      log.error('Failed to archive thread', { url: request.url, error: err.message });
    }
  },

  handleFailedRequestFunction: async ({ request, error, log }) => {
    log.error('Request failed', { url: request.url, error: error?.message ?? error });
  }
});

// Convert provided startUrls to startRequests and run
const startRequests = startUrls.map((u) => ({ url: u }));
await crawler.run(startRequests);

await Actor.exit();
