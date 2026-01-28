# What are Apify Actors?

- Actors are serverless programs packaged as Docker images. They accept well-defined JSON input, perform tasks such as crawling and scraping, and produce structured output.

## Twitter/X "Viral Thread" Archivist Scraper — Overview

What this Actor does
- Uses Playwright to render Twitter/X pages and reliably extract thread tweets, metrics, and media links.
- Exports a Markdown representation of the thread and saves metadata to the Dataset.
- Optionally saves full thread JSON to the default Key-Value store (KV) and stores the KV key in Dataset.

Important warnings & compliance
- Twitter/X frequently changes markup and access rules and may block automated clients. For production/large-scale use prefer official APIs and ensure compliance with X's Terms of Service and developer policies.
- This starter does not attempt to bypass authentication or access private content. If you plan to supply authenticated cookies or credentials, you must ensure you have the right to use them and store secrets securely (do not commit keys).
- Use proxy rotation and rate limiting for higher-volume runs to reduce the chance of blocking.

Inputs
- startUrls: thread/tweet URLs or listing/search pages
- maxThreads: cap number of archived threads
- includeReplies: attempt to include replies (extra work)
- saveMode: 'dataset' (store Markdown in dataset) or 'kv' (save JSON full thread to KV)

Outputs
- Dataset items with thread metadata and a Markdown export of the thread and optional KV key pointing to full thread JSON.

How to run locally
1. Create the directory and add files (do NOT create storage/)
   - mkdir twitterx-viral-thread-archivist-scraper
   - cd twitterx-viral-thread-archivist-scraper
   - (create the files above in that folder)

2. Install dependencies:
   - npm install

3. Run the Actor locally:
   - apify run

4. Login & push:
   - apify login
   - apify push

Recommended enhancements
- (A) Add authenticated mode (cookies / OAuth) for richer access (must respect TOS and secure keys).
- (B) Add deduplication in KV and daily archival rotation and retention policy.
- (C) Use network interception to capture X's JSON payloads (more robust than DOM scraping) — requires Playwright and careful mapping.
- (D) Add LLM-based summarization of threads (requires external LLM API keys and opt-in).
