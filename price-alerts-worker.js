/**
 * JournUp Price Alerts — Cloudflare Worker
 * Deploy via Cloudflare Dashboard — no CLI needed.
 * Nothing is hardcoded. All config comes from the HTML page via /config POST.
 *
 * Config keys pushed from the page:
 *   telegramToken, telegramChatId   — from the Telegram setup panel
 *   discordWebhook                  — from the Discord setup panel
 *   discordFooter, discordTitlePrefix, discordColorAbove, discordColorBelow — Discord embed options
 *   msgTemplate, msgDirAbove, msgDirBelow, notePrefix, datetimeFmt          — shared message template
 *   avKey, oandaKey, oandaEnv, finnhubKey, coingeckoKey, twelvedataKey      — data provider keys
 *   knownCrypto, commodities, indices, providerChain                        — asset classification
 *   deleteHours                                                             — auto-delete fired Telegram
 *                                                                              alert messages after N hours
 *                                                                              (0/unset = never). Telegram only
 *                                                                              allows deleting messages up to 48h
 *                                                                              old. Runs on the cron schedule, so
 *                                                                              it works even when the app isn't open.
 *
 * Cloudinary hard-delete (used by the page's trade-screenshot and note-image
 * removal, once the unsigned 10-minute delete-token window has passed):
 *   POST /cloudinary-delete   body: { cloudName, publicId }
 *   Requires two Worker secrets, set directly in the Cloudflare dashboard —
 *   never sent from the page: CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.
 *
 * SYNC NOTE (for Claude/agents): this file is duplicated verbatim inside the
 * `cfDownloadWorker()` template string in trading_journal.html. Any change
 * here MUST be mirrored there so the two stay an exact copy.
 */

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Worker-Secret',
    'Access-Control-Max-Age': '86400',
  };
}
function jsonRes(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(origin)),
  });
}

addEventListener('fetch', function(event) {
  event.respondWith(handleRequest(event.request));
});

addEventListener('scheduled', function(event) {
  event.waitUntil(paCheckAll());
});

async function handleRequest(request) {
  var origin = request.headers.get('Origin');
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (typeof WORKER_SECRET !== 'undefined' && WORKER_SECRET) {
    if ((request.headers.get('X-Worker-Secret') || '') !== WORKER_SECRET) {
      return jsonRes({ error: 'Unauthorized' }, 401, origin);
    }
  }
  var url = new URL(request.url);
  var path = url.pathname.replace(/\/+$/, '');
  var method = request.method;

  if (path === '/config' && method === 'POST') {
    var body = await request.json().catch(function() { return null; });
    if (!body) return jsonRes({ error: 'Invalid JSON' }, 400, origin);
    await JOURNUP_KV.put('config', JSON.stringify(body));
    return jsonRes({ ok: true }, 200, origin);
  }
  if (path === '/config' && method === 'GET') {
    var raw = await JOURNUP_KV.get('config');
    if (!raw) return jsonRes({ error: 'Not configured' }, 404, origin);
    return jsonRes(JSON.parse(raw), 200, origin);
  }
  if (path === '/alerts' && method === 'POST') {
    var body = await request.json().catch(function() { return null; });
    if (!Array.isArray(body)) return jsonRes({ error: 'Expected array' }, 400, origin);
    // Guard against a race with paCheckAll(): if the cron fires an alert
    // (sets fired:true in KV) between when a browser tab last pulled the
    // alert list and when it pushes its own copy back, that push would
    // otherwise carry a stale fired:false and silently un-fire the alert —
    // causing it to fire (and message) again on a later cron pass. So here,
    // any alert already fired in KV stays fired, no matter what the
    // incoming payload says. Fired state can only ever be set by
    // paCheckAll(); a client push can never revert it.
    var existingRaw = await JOURNUP_KV.get('alerts');
    var existing = existingRaw ? JSON.parse(existingRaw) : [];
    var firedMap = {};
    existing.forEach(function(a) { if (a.fired) firedMap[a.id] = a; });
    var merged = body.map(function(a) {
      return (!a.fired && firedMap[a.id]) ? Object.assign({}, a, firedMap[a.id]) : a;
    });
    await JOURNUP_KV.put('alerts', JSON.stringify(merged));
    return jsonRes({ ok: true, count: merged.length }, 200, origin);
  }
  if (path === '/alerts' && method === 'GET') {
    var raw = await JOURNUP_KV.get('alerts');
    return jsonRes(raw ? JSON.parse(raw) : [], 200, origin);
  }
  if (path === '/trigger_log' && method === 'GET') {
    var raw = await JOURNUP_KV.get('trigger_log');
    return jsonRes(raw ? JSON.parse(raw) : [], 200, origin);
  }
  if (path === '/poll' && method === 'POST') {
    // Run paCheckAll() directly and await it so the response includes the result.
    // (event.waitUntil is not available inside handleRequest scope)
    try {
      await paCheckAll();
      return jsonRes({ ok: true, message: 'Poll completed' }, 200, origin);
    } catch(e) {
      return jsonRes({ ok: false, error: e.message }, 500, origin);
    }
  }
  if (path === '/status' && method === 'GET') {
    var cfgRaw = await JOURNUP_KV.get('config');
    var alertsRaw = await JOURNUP_KV.get('alerts');
    var alerts = alertsRaw ? JSON.parse(alertsRaw) : [];
    return jsonRes({ ok: true, configured: !!cfgRaw, totalAlerts: alerts.length, activeAlerts: alerts.filter(function(a) { return !a.fired; }).length }, 200, origin);
  }
  if (path === '/debug' && method === 'GET') {
    var sym = url.searchParams.get('sym') || 'BTCUSDT';
    var cfgRaw2 = await JOURNUP_KV.get('config');
    var cfg2 = cfgRaw2 ? JSON.parse(cfgRaw2) : {};
    var provChain = (cfg2.providerChain) || DEFAULT_PROVIDER_CHAIN;
    var results = { sym: sym, assetType: detectAssetType(sym, cfg2), providerChain: provChain[detectAssetType(sym, cfg2)] };
    try { results.binance = await fetchBinance(sym); } catch(e) { results.binance = 'ERR: ' + e.message; }
    try { results.coingecko = await fetchCoinGecko(sym, cfg2.coingeckoKey); } catch(e) { results.coingecko = 'ERR: ' + e.message; }
    try { results.yahoo = await fetchYahoo(sym); } catch(e) { results.yahoo = 'ERR: ' + e.message; }
    if (cfg2.avKey) {
      try { results.av = await fetchAlphaVantage(sym, cfg2.avKey); } catch(e) { results.av = 'ERR: ' + e.message; }
    } else { results.av = 'no key'; }
    if (cfg2.oandaKey) {
      try { results.oanda = await fetchOanda(sym, cfg2.oandaKey, cfg2.oandaEnv || 'practice'); } catch(e) { results.oanda = 'ERR: ' + e.message; }
    } else { results.oanda = 'no key'; }
    if (cfg2.finnhubKey) {
      try { results.finnhub = await fetchFinnhub(sym, cfg2.finnhubKey); } catch(e) { results.finnhub = 'ERR: ' + e.message; }
    } else { results.finnhub = 'no key'; }
    if (cfg2.twelvedataKey) {
      try { results.twelvedata = await fetchTwelveData(sym, cfg2.twelvedataKey); } catch(e) { results.twelvedata = 'ERR: ' + e.message; }
    } else { results.twelvedata = 'no key'; }
    try { results.fetchPriceWithMeta = await fetchPriceWithMeta(sym, cfg2); } catch(e) { results.fetchPriceWithMeta = 'ERR: ' + e.message; }
    return jsonRes(results, 200, origin);
  }
  if (path === '/prices' && method === 'GET') {
    var raw = await JOURNUP_KV.get('prices');
    return jsonRes(raw ? JSON.parse(raw) : {}, 200, origin);
  }
  // Live price fetch — no KV read/write, result returned directly to browser
  if (path === '/price' && method === 'GET') {
    var sym = url.searchParams.get('symbol') || '';
    if (!sym) return jsonRes({ error: 'Missing symbol parameter' }, 400, origin);
    var cfgRaw = await JOURNUP_KV.get('config');
    var cfg = cfgRaw ? JSON.parse(cfgRaw) : {};
    try {
      var result = await fetchPriceWithMeta(sym.toUpperCase(), cfg);
      if (result === null) return jsonRes({ error: 'Price unavailable' }, 502, origin);
      return jsonRes({ symbol: sym.toUpperCase(), price: result.price, provider: result.provider, time: Date.now() }, 200, origin);
    } catch(e) {
      return jsonRes({ error: e.message }, 502, origin);
    }
  }
  if (path === '/cloudinary-delete' && method === 'POST') {
    var body = await request.json().catch(function() { return null; });
    if (!body || !body.publicId) return jsonRes({ error: 'Missing publicId' }, 400, origin);
    var cloudName = body.cloudName || (typeof CLOUDINARY_CLOUD_NAME !== 'undefined' ? CLOUDINARY_CLOUD_NAME : '');
    if (!cloudName) return jsonRes({ error: 'Missing cloudName' }, 400, origin);
    if (typeof CLOUDINARY_API_KEY === 'undefined' || typeof CLOUDINARY_API_SECRET === 'undefined') {
      return jsonRes({ error: 'Worker missing CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET secrets' }, 500, origin);
    }
    try {
      var timestamp = Math.floor(Date.now() / 1000);
      var toSign = 'public_id=' + body.publicId + '&timestamp=' + timestamp + CLOUDINARY_API_SECRET;
      var signature = await sha1Hex(toSign);
      var fd = new FormData();
      fd.append('public_id', body.publicId);
      fd.append('timestamp', String(timestamp));
      fd.append('api_key', CLOUDINARY_API_KEY);
      fd.append('signature', signature);
      var r = await fetch('https://api.cloudinary.com/v1_1/' + cloudName + '/image/destroy', { method: 'POST', body: fd });
      var d = await r.json().catch(function() { return {}; });
      if (d.result === 'ok' || d.result === 'not found') return jsonRes({ ok: true, result: d.result }, 200, origin);
      return jsonRes({ ok: false, error: d.error ? d.error.message : ('Cloudinary result: ' + d.result) }, 502, origin);
    } catch(e) {
      return jsonRes({ ok: false, error: e.message }, 500, origin);
    }
  }
  return jsonRes({ error: 'Not found' }, 404, origin);
}

async function paCheckAll() {
  var cfgRaw = await JOURNUP_KV.get('config');
  if (!cfgRaw) return;
  var cfg = JSON.parse(cfgRaw);
  // Poll interval is controlled entirely by the Cloudflare cron trigger
  // in the dashboard — no throttle guard needed here.
  var alertsRaw = await JOURNUP_KV.get('alerts');
  if (!alertsRaw) return;
  var alerts = JSON.parse(alertsRaw);
  var changed = false;
  var logEntries = [];

  var active = alerts.filter(function(a) { return !a.fired; });
  if (active.length) {
    var bySymbol = {};
    active.forEach(function(a) { if (!bySymbol[a.symbol]) bySymbol[a.symbol] = []; bySymbol[a.symbol].push(a); });

    await Promise.all(Object.keys(bySymbol).map(async function(sym) {
      var result = await fetchPriceWithMeta(sym, cfg);
      if (result === null) return;
      var price = result.price;
      var symAlerts = bySymbol[sym];
      for (var i = 0; i < symAlerts.length; i++) {
        var a = symAlerts[i];
        var hit = (a.dir === 'above' && price >= a.target) || (a.dir === 'below' && price <= a.target);
        if (!hit) continue;
        var idx = alerts.findIndex(function(x) { return x.id === a.id; });
        if (idx !== -1) { alerts[idx].fired = true; alerts[idx].firedAt = Date.now(); alerts[idx].firedPrice = price; }
        changed = true;
        var tgMsgId = await sendTelegram(buildMessage(a, price, cfg, result.provider), cfg);
        if (tgMsgId && idx !== -1) alerts[idx].tgMessageId = tgMsgId;
        if (cfg.discordWebhook) await sendDiscord(buildDiscordEmbed(a, price, cfg, result.provider), cfg.discordWebhook);
        logEntries.push({ id: a.id, symbol: a.symbol, dir: a.dir, target: a.target, price: price, note: a.note || '', firedAt: Date.now() });
      }
    }));
  }

  // Auto-delete fired alert Telegram messages once the configured retention
  // period has passed. Mirrors the page's own (browser-side) cleanup logic,
  // but runs here too so it still happens on schedule even if the app/browser
  // is closed. Runs every paCheckAll() pass — including when there were no
  // active alerts left to price-check above — so nothing pending gets missed.
  // Note: Telegram only allows bots to delete messages up to 48 hours old;
  // deletion attempts past that window fail harmlessly and are not retried.
  // Once the Telegram message is gone, the alert itself is dropped from the
  // list too (rather than just clearing tgMessageId), so the Price Alerts
  // page mirrors Telegram: same single KV write either way, no extra KV usage.
  var deleteHours = parseInt(cfg.deleteHours, 10);
  if (deleteHours > 0 && cfg.telegramToken && cfg.telegramChatId) {
    var cutoff = Date.now() - (deleteHours * 3600000);
    var keptAlerts = [];
    for (var j = 0; j < alerts.length; j++) {
      var al = alerts[j];
      if (al.fired && al.tgMessageId && al.firedAt && al.firedAt < cutoff) {
        try { await sendTelegramDelete(al.tgMessageId, cfg); } catch(e) {}
        changed = true;
        continue; // drop the alert — its Telegram message is gone
      }
      keptAlerts.push(al);
    }
    alerts = keptAlerts;
  }

  if (changed) await JOURNUP_KV.put('alerts', JSON.stringify(alerts));
  if (logEntries.length) {
    var existingRaw = await JOURNUP_KV.get('trigger_log');
    var log = (existingRaw ? JSON.parse(existingRaw) : []).concat(logEntries).slice(-200);
    await JOURNUP_KV.put('trigger_log', JSON.stringify(log));
  }
}

// Default asset-detection lists — kept in sync with the page's paDetectAssetType.
// If the page sends cfg.knownCrypto / cfg.commodities / cfg.indices in the config
// payload, those override these defaults so the page stays the single source of truth.
var DEFAULT_KNOWN_CRYPTO = ['BTC','ETH','BNB','SOL','XRP','ADA','DOGE','AVAX','DOT','MATIC','LTC','LINK','UNI','ATOM','TRX','TON','SHIB'];
var DEFAULT_COMMODITIES  = ['XAUUSD','XAGUSD','GOLD','SILVER','OIL','CRUDE','WTI','BRENT','NATGAS','CORN','WHEAT'];
var DEFAULT_INDICES      = ['US30','US500','SP500','SPX','NAS100','NASDAQ','DAX','UK100','GDAXI','YM=F','ES=F','NQ=F'];

// Default provider chains — overrideable via cfg.providerChain sent from the page.
// Twelve Data's free tier covers US equities, forex, and crypto (not
// commodities or indices — those are paid-only there), so it's inserted
// 2nd only into the crypto/forex/stock chains.
var DEFAULT_PROVIDER_CHAIN = {
  crypto:    ['binance','twelvedata','coingecko','oanda','yahoo'],
  forex:     ['oanda','twelvedata','av','yahoo'],
  commodity: ['oanda','av','yahoo'],
  stock:     ['finnhub','twelvedata','av','yahoo'],
  index:     ['finnhub','av','yahoo']
};

function detectAssetType(sym, cfg) {
  var u = sym.toUpperCase();
  var crypto      = (cfg && cfg.knownCrypto)  || DEFAULT_KNOWN_CRYPTO;
  var commodities = (cfg && cfg.commodities)  || DEFAULT_COMMODITIES;
  var indices     = (cfg && cfg.indices)      || DEFAULT_INDICES;
  if (/^[A-Z]+USDT$/.test(u)) return 'crypto';
  if (crypto.indexOf(u) !== -1) return 'crypto';
  if (/^[A-Z]+USD$/.test(u) && crypto.indexOf(u.slice(0,-3)) !== -1) return 'crypto';
  if (commodities.indexOf(u) !== -1) return 'commodity';
  if (indices.indexOf(u) !== -1) return 'index';
  if (/^[A-Z]{6}$/.test(u)) return 'forex';
  return 'stock';
}

async function fetchPriceWithMeta(sym, cfg) {
  var providerChain = (cfg && cfg.providerChain) || DEFAULT_PROVIDER_CHAIN;
  var chain = providerChain[detectAssetType(sym, cfg)] || ['yahoo'];
  for (var i = 0; i < chain.length; i++) {
    var p = chain[i];
    if (p === 'av' && !cfg.avKey) continue;
    if (p === 'oanda' && !cfg.oandaKey) continue;
    if (p === 'finnhub' && !cfg.finnhubKey) continue;
    if (p === 'twelvedata' && !cfg.twelvedataKey) continue;
    try {
      var price = null;
      if (p === 'binance')    price = await fetchBinance(sym);
      if (p === 'coingecko')  price = await fetchCoinGecko(sym, cfg.coingeckoKey);
      if (p === 'yahoo')      price = await fetchYahoo(sym);
      if (p === 'av')         price = await fetchAlphaVantage(sym, cfg.avKey);
      if (p === 'oanda')      price = await fetchOanda(sym, cfg.oandaKey, cfg.oandaEnv || 'practice');
      if (p === 'finnhub')    price = await fetchFinnhub(sym, cfg.finnhubKey);
      if (p === 'twelvedata') price = await fetchTwelveData(sym, cfg.twelvedataKey);
      if (price !== null && !isNaN(price)) return { price: price, provider: p };
    } catch(e) {}
  }
  return null;
}

async function fetchPrice(sym, cfg) {
  var result = await fetchPriceWithMeta(sym, cfg);
  return result ? result.price : null;
}

// Returns the Binance trading pair for a given symbol.
// Adapts dynamically: BTCUSDT → BTCUSDT, BTCUSD → BTCUSDT, BTC → BTCUSDT
// Does NOT hardcode coin names — works for any xUSD or xUSDT symbol.
function toBinancePair(sym) {
  var u = sym.toUpperCase();
  if (/USDT$/.test(u)) return u;          // already a USDT pair
  if (/USD$/.test(u)) return u.slice(0, -3) + 'USDT'; // xUSD → xUSDT
  return u + 'USDT';                      // bare ticker → xUSDT
}

async function fetchBinance(sym) {
  var pair = toBinancePair(sym);
  var r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=' + pair);
  if (!r.ok) return null;                 // guard before r.json() — non-JSON responses (HTML block pages) would throw
  var d = await r.json();
  if (d.code) return null;               // gracefully handle Binance API error codes
  return d.price ? parseFloat(d.price) : null;
}

// CoinGecko: fast-path map for common coins whose CoinGecko ID differs from their ticker,
// plus fully algorithmic fallback for any coin not in the map.
// Pass 1: check CG_MAP, then try the ticker as the ID directly (works for sol, ada, doge, avax...).
// Pass 2: if pass 1 returns nothing, call /search to resolve the real CG ID dynamically.
//   Any new pair added to the app just works - no map update needed for coins whose ID matches ticker.
var CG_MAP = {
  'BTC':'bitcoin','BTCUSD':'bitcoin','BTCUSDT':'bitcoin',
  'ETH':'ethereum','ETHUSD':'ethereum','ETHUSDT':'ethereum',
  'BNB':'binancecoin','BNBUSD':'binancecoin','BNBUSDT':'binancecoin',
  'XRP':'ripple','XRPUSD':'ripple','XRPUSDT':'ripple',
  'SOL':'solana','SOLUSD':'solana','SOLUSDT':'solana',
  'ADA':'cardano','ADAUSD':'cardano','ADAUSDT':'cardano',
  'DOGE':'dogecoin','DOGEUSD':'dogecoin','DOGEUSDT':'dogecoin',
  'AVAX':'avalanche-2','AVAXUSD':'avalanche-2','AVAXUSDT':'avalanche-2',
  'DOT':'polkadot','DOTUSD':'polkadot','DOTUSDT':'polkadot',
  'MATIC':'matic-network','MATICUSD':'matic-network','MATICUSDT':'matic-network',
  'LTC':'litecoin','LTCUSD':'litecoin','LTCUSDT':'litecoin',
  'LINK':'chainlink','LINKUSD':'chainlink','LINKUSDT':'chainlink',
  'UNI':'uniswap','UNIUSD':'uniswap','UNIUSDT':'uniswap',
  'ATOM':'cosmos','ATOMUSD':'cosmos','ATOMUSDT':'cosmos',
  'TRX':'tron','TRXUSD':'tron','TRXUSDT':'tron',
  'TON':'the-open-network','TONUSD':'the-open-network','TONUSDT':'the-open-network',
  'SHIB':'shiba-inu','SHIBUSD':'shiba-inu','SHIBUSDT':'shiba-inu'
};
async function fetchCoinGecko(sym, apiKey) {
  var u = sym.toUpperCase();
  var base = u.replace(/USDT$/, '').replace(/USD$/, '').toLowerCase();
  var apiSuffix = apiKey ? '&x_cg_demo_api_key=' + encodeURIComponent(apiKey) : '';

  async function priceById(id) {
    var url = 'https://api.coingecko.com/api/v3/simple/price?ids=' + encodeURIComponent(id) + '&vs_currencies=usd' + apiSuffix;
    var r = await fetch(url);
    if (!r.ok) return null;
    var d = await r.json();
    return (d[id] && d[id].usd) ? parseFloat(d[id].usd) : null;
  }

  // Pass 1: fast-path map for coins whose CG ID differs from ticker, then try ticker as ID directly
  var mappedId = CG_MAP[u] || CG_MAP[base.toUpperCase()] || null;
  var price = await priceById(mappedId || base);
  if (price !== null) return price;

  // Pass 2: resolve via /search - picks the first result whose symbol matches exactly.
  // Only reached for unknown coins not in CG_MAP whose ticker is not their CG ID.
  try {
    var searchUrl = 'https://api.coingecko.com/api/v3/search?query=' + encodeURIComponent(base);
    if (apiKey) searchUrl += '&x_cg_demo_api_key=' + encodeURIComponent(apiKey);
    var sd = await (await fetch(searchUrl)).json();
    var coins = sd.coins || [];
    for (var i = 0; i < coins.length; i++) {
      if (coins[i].symbol && coins[i].symbol.toLowerCase() === base && coins[i].id) {
        price = await priceById(coins[i].id);
        if (price !== null) return price;
        break;
      }
    }
  } catch(e) {}

  return null;
}

// Yahoo Finance: fully algorithmic ticker derivation.
// The only exceptions kept are commodity/index futures tickers (e.g. XAUUSD → GC=F)
// because Yahoo uses futures contract codes that can't be derived from the symbol.
// Everything else — crypto, forex, stocks — is derived algorithmically:
//   BTCUSDT / BTCUSD → BTC-USD   (crypto: strip suffix, add -USD)
//   EURUSD           → EURUSD=X  (6-char forex: append =X)
//   AAPL             → AAPL      (stocks: pass through)
var YAHOO_FUTURES_MAP = {
  'XAUUSD':'GC=F','GOLD':'GC=F',
  'XAGUSD':'SI=F','SILVER':'SI=F',
  'OIL':'CL=F','WTI':'CL=F','CRUDE':'CL=F','BRENT':'BZ=F','USOIL':'CL=F',
  'NATGAS':'NG=F','CORN':'ZC=F','WHEAT':'ZW=F',
  'US30':'YM=F','US500':'ES=F','SP500':'ES=F','SPX':'ES=F',
  'NAS100':'NQ=F','NASDAQ':'NQ=F','DAX':'GDAXI','UK100':'^FTSE'
};
function toYahooTicker(sym) {
  var u = sym.toUpperCase();
  // Commodity/index futures — irreducible, keep a small exception map
  if (YAHOO_FUTURES_MAP[u]) return YAHOO_FUTURES_MAP[u];
  // Crypto with USDT suffix: BTCUSDT → BTC-USD
  if (/USDT$/.test(u)) return u.slice(0, -4) + '-USD';
  // Crypto with USD suffix: BTCUSD → BTC-USD
  // Check base against known crypto list first so 6-char pairs like BTCUSD are caught,
  // while real forex pairs like EURUSD (whose base EUR is not in the list) fall through.
  if (/USD$/.test(u) && DEFAULT_KNOWN_CRYPTO.indexOf(u.slice(0, -3)) !== -1) return u.slice(0, -3) + '-USD';
  // Longer crypto USD pairs not in the default list (e.g. MATICUSD, length > 6)
  if (/USD$/.test(u) && u.length > 6) return u.slice(0, -3) + '-USD';
  // Forex: exactly 6 alpha chars → EURUSD=X
  if (/^[A-Z]{6}$/.test(u)) return u + '=X';
  // Stocks, indices, ETFs — pass through as-is
  return u;
}
async function fetchYahoo(sym) {
  var ticker = toYahooTicker(sym);
  // Call Yahoo directly — no CORS proxy needed from a Worker (server-side)
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) + '?interval=1m&range=1d';
  var r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; JournUp/1.0)',
      'Accept': 'application/json'
    }
  });
  if (!r.ok) {
    // Try query2 as fallback if query1 rate-limits
    var r2 = await fetch(url.replace('query1', 'query2'), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JournUp/1.0)', 'Accept': 'application/json' }
    });
    if (!r2.ok) return null;
    r = r2;
  }
  var d = await r.json();
  var meta = d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
  return (meta && meta.regularMarketPrice) ? parseFloat(meta.regularMarketPrice) : null;
}

// Alpha Vantage: fully algorithmic.
// Forex/commodity pairs (6 chars or XAU/XAG style): split at 3 chars → CURRENCY_EXCHANGE_RATE
// Crypto with USDT/USD suffix: strip suffix → DIGITAL_CURRENCY_DAILY vs USD
// Stocks/ETFs: pass symbol through → GLOBAL_QUOTE
async function fetchAlphaVantage(sym, apiKey) {
  var u = sym.toUpperCase();
  var base = u.replace(/USDT$/, '').replace(/USD$/, '');

  // Forex: exactly 6 alpha chars (EURUSD, GBPJPY, XAUUSD, etc.)
  if (/^[A-Z]{6}$/.test(u)) {
    var from = u.slice(0, 3), to = u.slice(3, 6);
    var d = await (await fetch('https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=' + from + '&to_currency=' + to + '&apikey=' + encodeURIComponent(apiKey))).json();
    var rate = d['Realtime Currency Exchange Rate'] && d['Realtime Currency Exchange Rate']['5. Exchange Rate'];
    return rate ? parseFloat(rate) : null;
  }

  // Crypto: had USDT or USD suffix, or is a known short ticker that's not 6 chars
  // Use CURRENCY_EXCHANGE_RATE: from=BTC to=USD (works for any crypto AV supports)
  if (u !== base) {
    // Had a suffix stripped — it's crypto
    var d = await (await fetch('https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=' + encodeURIComponent(base) + '&to_currency=USD&apikey=' + encodeURIComponent(apiKey))).json();
    var rate = d['Realtime Currency Exchange Rate'] && d['Realtime Currency Exchange Rate']['5. Exchange Rate'];
    return rate ? parseFloat(rate) : null;
  }

  // Stock / ETF / index
  var d = await (await fetch('https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=' + encodeURIComponent(u) + '&apikey=' + encodeURIComponent(apiKey))).json();
  var price = d['Global Quote'] && d['Global Quote']['05. price'];
  return price ? parseFloat(price) : null;
}

// Oanda: fully algorithmic instrument derivation.
// Oanda format is always BASE_QUOTE with underscore (EUR_USD, XAU_USD, BTC_USD).
// Rules:
//   EURUSD (6-char forex)  → EUR_USD  (split at 3)
//   BTCUSDT / BTCUSD       → BTC_USD  (strip T from USDT, insert _)
//   XAU_USD (already oanda format) → pass through
// A small exceptions map covers non-derivable Oanda instrument names for indices/commodities.
var OANDA_EXCEPTIONS = {
  'US30':'US30_USD','US500':'SPX500_USD','SP500':'SPX500_USD','SPX':'SPX500_USD',
  'NAS100':'NAS100_USD','NASDAQ':'NAS100_USD',
  'OIL':'WTICO_USD','WTI':'WTICO_USD','CRUDE':'WTICO_USD','USOIL':'WTICO_USD',
  'BRENT':'BCO_USD','UK100':'UK100_GBP','DAX':'DE30_EUR'
};
function toOandaInstrument(sym) {
  var u = sym.toUpperCase();
  if (OANDA_EXCEPTIONS[u]) return OANDA_EXCEPTIONS[u];
  if (/^[A-Z]+_[A-Z]+$/.test(u)) return u;           // already BASE_QUOTE
  if (/^[A-Z]{6}$/.test(u)) return u.slice(0,3) + '_' + u.slice(3,6); // EURUSD → EUR_USD
  if (/USDT$/.test(u)) return u.slice(0,-4) + '_USD'; // BTCUSDT → BTC_USD
  if (/USD$/.test(u)) return u.slice(0,-3) + '_USD';  // BTCUSD → BTC_USD
  return null; // can't derive — skip
}
async function fetchOanda(sym, apiKey, env) {
  var inst = toOandaInstrument(sym);
  if (!inst) return null;
  var host = env === 'live' ? 'https://api-fxtrade.oanda.com' : 'https://api-fxpractice.oanda.com';
  var r = await fetch(host + '/v3/instruments/' + inst + '/candles?count=1&price=M&granularity=S5', { headers: { 'Authorization': 'Bearer ' + apiKey } });
  if (!r.ok) return null;
  var d = await r.json();
  var price = d.candles && d.candles.length && parseFloat(d.candles[d.candles.length-1].mid.c);
  return (price && !isNaN(price)) ? price : null;
}

// Finnhub: mostly pass-through for stocks.
// For forex, Finnhub uses "OANDA:EUR_USD" format — derive it the same way as Oanda.
// Small exceptions map only for index shorthands (US30, NAS100 etc.) that Finnhub
// doesn't recognise by those names.
var FINNHUB_INDEX_MAP = {
  'US30':'DJI','SP500':'^GSPC','SPX':'^GSPC','US500':'^GSPC',
  'NAS100':'^NDX','NASDAQ':'^NDX','DAX':'^GDAXI','UK100':'^FTSE'
};
async function fetchFinnhub(sym, apiKey) {
  var u = sym.toUpperCase();
  var ticker;
  if (FINNHUB_INDEX_MAP[u]) {
    ticker = FINNHUB_INDEX_MAP[u];
  } else if (/USDT$/.test(u)) {
    // Crypto USDT pair: BTCUSDT → BINANCE:BTCUSDT
    ticker = 'BINANCE:' + u;
  } else if (/USD$/.test(u) && DEFAULT_KNOWN_CRYPTO.indexOf(u.slice(0, -3)) !== -1) {
    // Known crypto USD pair: BTCUSD → COINBASE:BTC-USD
    // Must come before the 6-char forex check so BTCUSD isn't misrouted to OANDA
    ticker = 'COINBASE:' + u.slice(0,-3) + '-USD';
  } else if (/USD$/.test(u) && u.length > 6) {
    // Longer crypto USD pair not in default list (e.g. MATICUSD)
    ticker = 'COINBASE:' + u.slice(0,-3) + '-USD';
  } else if (/^[A-Z]{6}$/.test(u)) {
    // Forex: EURUSD → OANDA:EUR_USD
    ticker = 'OANDA:' + u.slice(0,3) + '_' + u.slice(3,6);
  } else {
    ticker = u; // stocks pass through
  }
  var d = await (await fetch('https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(ticker) + '&token=' + encodeURIComponent(apiKey))).json();
  return (d.c && d.c !== 0) ? parseFloat(d.c) : null;
}

// Twelve Data: fully algorithmic. Free tier covers US equities, forex, and
// crypto (NOT commodities or indices — those require a paid plan there),
// so this is only ever reached via chains that include it (crypto/forex/stock).
// Forex/crypto need BASE/QUOTE slash format; stocks pass straight through.
async function fetchTwelveData(sym, apiKey) {
  var u = sym.toUpperCase();
  var ticker;
  if (/^[A-Z]+_[A-Z]+$/.test(u)) {
    ticker = u.replace('_', '/');                                       // already BASE_QUOTE (Oanda-style) → BASE/QUOTE
  } else if (/USDT$/.test(u)) {
    ticker = u.slice(0, -4) + '/USD';                                   // BTCUSDT → BTC/USD
  } else if (/USD$/.test(u) && DEFAULT_KNOWN_CRYPTO.indexOf(u.slice(0, -3)) !== -1) {
    ticker = u.slice(0, -3) + '/USD';                                   // known crypto USD pair → BASE/USD
  } else if (/USD$/.test(u) && u.length > 6) {
    ticker = u.slice(0, -3) + '/USD';                                   // longer crypto USD pair not in default list
  } else if (/^[A-Z]{6}$/.test(u)) {
    ticker = u.slice(0, 3) + '/' + u.slice(3, 6);                       // EURUSD → EUR/USD
  } else {
    ticker = u;                                                         // stocks pass through
  }
  var d = await (await fetch('https://api.twelvedata.com/price?symbol=' + encodeURIComponent(ticker) + '&apikey=' + encodeURIComponent(apiKey))).json();
  if (d.status === 'error' || d.code) return null;
  return d.price ? parseFloat(d.price) : null;
}

function fmtPrice(p) {
  if (p === null || p === undefined) return '—';
  var s = parseFloat(p).toString(), parts = s.split('.');
  return (parts.length > 1 ? parseInt(parts[0],10).toLocaleString() + '.' + parts[1] : parseInt(parts[0],10).toLocaleString());
}

function fmtDatetime(fmt) {
  var now = new Date();
  if (fmt === 'iso')       return now.toISOString();
  if (fmt === 'date-only') return now.toISOString().slice(0, 10);
  if (fmt === 'time-only') return now.toISOString().slice(11, 16) + ' UTC';
  // 'locale' or unset — use a readable UTC string (Workers have no locale context)
  return now.toUTCString().replace(' GMT', ' UTC');
}

// Human-readable labels for provider codes — kept in sync with the page's PA_PROVIDER_LABELS.
var PROVIDER_LABELS = { binance:'Binance', coingecko:'CoinGecko', yahoo:'Yahoo Finance', av:'Alpha Vantage', oanda:'Oanda', finnhub:'Finnhub', twelvedata:'Twelve Data' };
function providerLabel(p) { return PROVIDER_LABELS[p] || p || '—'; }

function buildMessage(a, price, cfg, provider) {
  var dir        = a.dir === 'above' ? (cfg.msgDirAbove || '📈 rose above') : (cfg.msgDirBelow || '📉 dropped below');
  var notePrefix = cfg.notePrefix !== undefined ? cfg.notePrefix : '📝 ';
  var note       = a.note ? '\n' + notePrefix + a.note : '';
  var tpl = cfg.msgTemplate || '🔔 <b>Price Alert Triggered!</b>\n\n<b>{symbol}</b> {direction} <b>{target}</b>\nCurrent price: <b>{price}</b> (via {provider}){note}\n<i>🕐 {datetime}</i>\n<i>— JournUp Price Alerts (cloud)</i>';
  var datetime   = fmtDatetime(cfg.datetimeFmt);
  return tpl.replace(/\{symbol\}/g, a.symbol).replace(/\{direction\}/g, dir).replace(/\{target\}/g, fmtPrice(a.target)).replace(/\{price\}/g, fmtPrice(price)).replace(/\{note\}/g, note).replace(/\{datetime\}/g, datetime).replace(/\{provider\}/g, providerLabel(provider));
}

function buildDiscordEmbed(a, price, cfg, provider) {
  var notePrefix  = cfg && cfg.notePrefix !== undefined ? cfg.notePrefix : '📝 ';
  var colorAbove  = cfg && cfg.discordColorAbove ? parseInt(cfg.discordColorAbove.replace('#',''), 16) : 0x34c97a;
  var colorBelow  = cfg && cfg.discordColorBelow ? parseInt(cfg.discordColorBelow.replace('#',''), 16) : 0xe85555;
  var footerText  = (cfg && cfg.discordFooter) || 'JournUp Price Alerts (cloud)';
  var titlePrefix = (cfg && cfg.discordTitlePrefix) || '🔔 Price Alert: ';
  var fields = [{ name:'Direction', value: a.dir==='above'?'↑ Above':'↓ Below', inline:true },{ name:'Target', value:fmtPrice(a.target), inline:true },{ name:'Current', value:fmtPrice(price), inline:true },{ name:'Provider', value: providerLabel(provider), inline:true }];
  if (a.note) fields.push({ name: notePrefix ? notePrefix.trim() || 'Note' : 'Note', value: a.note });
  return { embeds:[{ title: titlePrefix + a.symbol, color: a.dir==='above' ? colorAbove : colorBelow, fields:fields, footer:{text: footerText}, timestamp:new Date().toISOString() }] };
}

// SHA-1 hex digest via Web Crypto — used to sign the Cloudinary destroy call below.
// Cloudinary's signing scheme requires SHA-1 specifically; it's fine for this purpose
// even though SHA-1 is deprecated for general cryptographic use.
async function sha1Hex(str) {
  var enc = new TextEncoder().encode(str);
  var hash = await crypto.subtle.digest('SHA-1', enc);
  var bytes = new Uint8Array(hash);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

async function sendTelegram(text, cfg) {
  if (!cfg.telegramToken || !cfg.telegramChatId) return null;
  var r = await fetch('https://api.telegram.org/bot' + cfg.telegramToken + '/sendMessage', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ chat_id:cfg.telegramChatId, text:text, parse_mode:'HTML' }) });
  var d = await r.json().catch(function(){ return {}; });
  return (d.ok && d.result) ? d.result.message_id : null;
}
async function sendDiscord(payload, webhookUrl) {
  if (!webhookUrl) return;
  await fetch(webhookUrl, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
}
async function sendTelegramDelete(messageId, cfg) {
  if (!cfg.telegramToken || !cfg.telegramChatId || !messageId) return null;
  var r = await fetch('https://api.telegram.org/bot' + cfg.telegramToken + '/deleteMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.telegramChatId, message_id: messageId })
  });
  var d = await r.json().catch(function(){ return {}; });
  return !!d.ok;
}
