const express = require('express');
const https = require('https');
const zlib = require('zlib');
const path = require('path');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DEFAULT_URL =
  'https://www.propertyfinder.ae/en/search?l=10493&c=2&fu=0&rp=y&ob=mr';
const DEFAULT_TX_URL =
  'https://www.propertyfinder.ae/en/transactions/buy/dubai/jumeirah-lake-towers-uptown-dubai-uptown-tower?period=1y&fu=0&ob=mr&sort=sqa';

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(
      url,
      {
        headers: {
          'Accept-Encoding': 'gzip, deflate, br',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
      },
      res => {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const encoding = res.headers['content-encoding'];
          const finish = html => resolve(html.toString());

          if (encoding === 'gzip') {
            zlib.gunzip(buffer, (err, out) => {
              if (err) return reject(err);
              finish(out);
            });
          } else if (encoding === 'br') {
            zlib.brotliDecompress(buffer, (err, out) => {
              if (err) return reject(err);
              finish(out);
            });
          } else if (encoding === 'deflate') {
            zlib.inflate(buffer, (err, out) => {
              if (err) return reject(err);
              finish(out);
            });
          } else {
            finish(buffer);
          }
        });
        res.on('error', reject);
      },
    );
  });
}

function extractListings(html) {
  const regex =
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;
  const match = regex.exec(html);
  if (!match) return [];
  try {
    const obj = JSON.parse(match[1]);
    return obj?.props?.pageProps?.searchResult?.listings || [];
  } catch {
    return [];
  }
}

function extractTransactions(html) {
  const regex =
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;
  const match = regex.exec(html);
  if (!match) return { items: [], totalPages: 1 };
  try {
    const obj = JSON.parse(match[1]);
    const list = obj?.props?.pageProps?.list;
    return {
      items: list?.transactionList || [],
      totalPages: Number(list?.totalPageCount || 1),
    };
  } catch {
    return { items: [], totalPages: 1 };
  }
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function toCsv(rows, header) {
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(header.map(h => csvEscape(row[h])).join(','));
  }
  return lines.join('\n');
}

function buildPageUrl(base, pageNumber) {
  if (base.includes('page=')) {
    return base.replace(/page=\d+/g, `page=${pageNumber}`);
  }
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}page=${pageNumber}`;
}

function toNumber(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number') return value;
  const cleaned = String(value).replace(/,/g, '').trim();
  if (!cleaned) return NaN;
  return Number(cleaned);
}

function normalizeBeds(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'string' && value.toLowerCase() === 'studio') return 0;
  return toNumber(value);
}

function getTxBeds(tx) {
  return tx.bedrooms ?? tx.bedroom ?? tx.beds ?? tx.numberOfBedrooms ?? tx.bed;
}

function getTxSize(tx) {
  return tx.propertySize ?? tx.size ?? tx.area ?? tx.property_size ?? tx.size_value;
}

function applyBedSizeFilters(items, filters, getBeds, getSize) {
  const bedMin = Number(filters.bedMin);
  const bedMax = Number(filters.bedMax);
  const sizeMin = Number(filters.sizeMin);
  const sizeMax = Number(filters.sizeMax);

  const useBedMin = Number.isFinite(bedMin);
  const useBedMax = Number.isFinite(bedMax);
  const useSizeMin = Number.isFinite(sizeMin);
  const useSizeMax = Number.isFinite(sizeMax);

  if (!useBedMin && !useBedMax && !useSizeMin && !useSizeMax) return items;

  return items.filter(item => {
    const beds = normalizeBeds(getBeds(item));
    const size = toNumber(getSize(item));

    if (useBedMin) {
      if (!Number.isFinite(beds) || beds < bedMin) return false;
    }
    if (useBedMax) {
      if (!Number.isFinite(beds) || beds > bedMax) return false;
    }
    if (useSizeMin) {
      if (!Number.isFinite(size) || size < sizeMin) return false;
    }
    if (useSizeMax) {
      if (!Number.isFinite(size) || size > sizeMax) return false;
    }
    return true;
  });
}

function calcTxPpsf(tx) {
  const direct = toNumber(tx.pricePerSqft);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const price = toNumber(tx.price);
  const size = toNumber(getTxSize(tx));
  if (Number.isFinite(price) && Number.isFinite(size) && size > 0) {
    return price / size;
  }
  return null;
}

function median(values) {
  const arr = values.filter(v => typeof v === 'number' && !Number.isNaN(v)).sort((a, b) => a - b);
  if (arr.length === 0) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

async function fetchTransactions(url, pages) {
  const all = [];
  // まず1ページ取得してページ数を確認
  const firstHtml = await fetchHtml(buildPageUrl(url, 1));
  const first = extractTransactions(firstHtml);
  all.push(...first.items);
  const totalPages = Math.max(1, first.totalPages);
  const limit = Math.min(pages || totalPages, totalPages);

  for (let p = 2; p <= limit; p++) {
    const html = await fetchHtml(buildPageUrl(url, p));
    const res = extractTransactions(html);
    all.push(...res.items);
  }
  return all;
}

async function scrape(url, pages) {
  const header = [
    'url',
    'property_type',
    'price_value',
    'price_currency',
    'price_period',
    'title',
    'location_full_name',
    'bedrooms',
    'bathrooms',
    'size_value',
    'size_unit',
    'listed_date',
    'reference',
    'listing_id',
  ];
  const rows = [];

  for (let p = 1; p <= pages; p++) {
    const pageUrl = buildPageUrl(url, p);
    const html = await fetchHtml(pageUrl);
    const listings = extractListings(html);
    for (const item of listings) {
      const prop = item.property || {};
      const price = prop.price || {};
      const size = prop.size || {};
      const loc = prop.location || {};
      const shareUrl =
        prop.share_url ||
        (prop.details_path ? `https://www.propertyfinder.ae${prop.details_path}` : '');

      rows.push({
        url: shareUrl,
        property_type: prop.property_type || '',
        price_value: price.value ?? '',
        price_currency: price.currency || '',
        price_period: price.period || '',
        title: prop.title || '',
        location_full_name: loc.full_name || '',
        bedrooms: prop.bedrooms || '',
        bathrooms: prop.bathrooms || '',
        size_value: size.value ?? '',
        size_unit: size.unit || '',
        listed_date: prop.listed_date || '',
        reference: prop.reference || '',
        listing_id: prop.listing_id || '',
      });
    }
  }

  return { header, rows, csv: toCsv(rows, header) };
}

async function analyze(
  listingUrl,
  listingPages,
  txUrl,
  txPages,
  thresholdPct = 10,
  filters = {},
) {
  const { rows: listingsRaw } = await scrape(listingUrl, listingPages);
  // 価格が取得できないもの（広告など）は除外
  let listings = listingsRaw.filter(l => {
    const price = Number(l.price_value);
    return Number.isFinite(price) && price > 0;
  });
  listings = applyBedSizeFilters(listings, filters, l => l.bedrooms, l => l.size_value);

  const transactionsRaw = await fetchTransactions(txUrl, txPages);
  const transactions = applyBedSizeFilters(
    transactionsRaw,
    filters,
    getTxBeds,
    getTxSize,
  );

  const txPpsf = transactions
    .map(calcTxPpsf)
    .filter(v => Number.isFinite(v) && v > 0);
  const txMedian = median(txPpsf);
  const txAvg =
    txPpsf.length > 0 ? txPpsf.reduce((a, b) => a + b, 0) / txPpsf.length : null;
  const txItems = transactions.map(t => ({
    ...t,
    pricePerSqft: calcTxPpsf(t),
  }));

  const evaluatedListings = listings.map(l => {
    const price = Number(l.price_value);
    const size = Number(l.size_value);
    const ppsf =
      Number.isFinite(price) && Number.isFinite(size) && size > 0
        ? price / size
        : null;
    let rating = 'N/A';
    if (ppsf && txMedian) {
      const diff = (ppsf - txMedian) / txMedian;
      if (diff <= -thresholdPct / 100) rating = '安い';
      else if (diff >= thresholdPct / 100) rating = '高い';
      else rating = '妥当';
    }
    const diffPctMedian =
      ppsf && txMedian ? ((ppsf - txMedian) / txMedian) * 100 : null;
    const diffPctAvg = ppsf && txAvg ? ((ppsf - txAvg) / txAvg) * 100 : null;
    return {
      ...l,
      listing_price_per_sqft: ppsf,
      rating,
      diff_pct_median: diffPctMedian,
      diff_pct_avg: diffPctAvg,
    };
  });

  return {
    tx: {
      count: transactions.length,
      median_price_per_sqft: txMedian,
      avg_price_per_sqft: txAvg,
      items: txItems,
    },
    listings: evaluatedListings,
  };
}

app.post('/api/scrape', async (req, res) => {
  try {
    const url = (req.body.url || DEFAULT_URL).trim();
    const pages = Math.max(1, Math.min(10, Number(req.body.pages || 1)));
    const { csv, rows } = await scrape(url, pages);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="propertyfinder.csv"');
    res.set('x-rows', String(rows.length));
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).send('エラーが発生しました。もう一度お試しください。');
  }
});

app.post('/api/analyze', async (req, res) => {
  try {
    const listingUrl = (req.body.listingUrl || DEFAULT_URL).trim();
    const listingPages = Math.max(1, Math.min(10, Number(req.body.listingPages || 1)));
    const txUrl = (req.body.txUrl || DEFAULT_TX_URL).trim();
    const txPagesRaw = req.body.txPages;
    const txPages = txPagesRaw ? Math.max(1, Math.min(20, Number(txPagesRaw))) : undefined;
    const threshold = Math.max(1, Math.min(50, Number(req.body.thresholdPct || 10)));
    const filters = {
      bedMin: req.body.bedMin,
      bedMax: req.body.bedMax,
      sizeMin: req.body.sizeMin,
      sizeMax: req.body.sizeMax,
    };

    const result = await analyze(
      listingUrl,
      listingPages,
      txUrl,
      txPages,
      threshold,
      filters,
    );
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).send('エラーが発生しました。もう一度お試しください。');
  }
});

app.post('/api/export', async (req, res) => {
  try {
    const listingUrl = (req.body.listingUrl || DEFAULT_URL).trim();
    const listingPages = Math.max(1, Math.min(10, Number(req.body.listingPages || 1)));
    const txUrl = (req.body.txUrl || DEFAULT_TX_URL).trim();
    const txPagesRaw = req.body.txPages;
    const txPages = txPagesRaw ? Math.max(1, Math.min(20, Number(txPagesRaw))) : undefined;
    const threshold = Math.max(1, Math.min(50, Number(req.body.thresholdPct || 10)));
    const filters = {
      bedMin: req.body.bedMin,
      bedMax: req.body.bedMax,
      sizeMin: req.body.sizeMin,
      sizeMax: req.body.sizeMax,
    };

    const result = await analyze(listingUrl, listingPages, txUrl, txPages, threshold, filters);
    const wb = XLSX.utils.book_new();

    // シート1: 条件
    const condRows = [
      ['パラメータ', '値'],
      ['検索結果URL', listingUrl],
      ['取得ページ数', listingPages],
      ['トランザクションURL', txUrl],
      ['TX取得ページ数', txPages || '全件'],
      ['しきい値 (%)', threshold],
      ['Beds 最小', filters.bedMin || '(なし)'],
      ['Beds 最大', filters.bedMax || '(なし)'],
      ['Size 最小', filters.sizeMin || '(なし)'],
      ['Size 最大', filters.sizeMax || '(なし)'],
      [],
      ['サマリ', ''],
      ['トランザクション件数', result.tx.count],
      ['Price/sqft 中央値', result.tx.median_price_per_sqft],
      ['Price/sqft 平均', result.tx.avg_price_per_sqft],
      ['リスティング件数', result.listings.length],
    ];
    const wsCond = XLSX.utils.aoa_to_sheet(condRows);
    wsCond['!cols'] = [{ wch: 22 }, { wch: 80 }];
    XLSX.utils.book_append_sheet(wb, wsCond, '条件・サマリ');

    // シート2: トランザクション
    const txHeader = ['Price', 'Price/sqft', 'Date', 'Beds', 'Size', 'Type'];
    const txData = [txHeader, ...result.tx.items.map(t => [
      t.price ?? '',
      t.pricePerSqft ? Math.round(t.pricePerSqft * 100) / 100 : '',
      t.transactionDate || '',
      t.bedrooms ?? '',
      t.propertySize ?? '',
      t.propertyType || '',
    ])];
    const wsTx = XLSX.utils.aoa_to_sheet(txData);
    wsTx['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 6 }, { wch: 10 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, wsTx, 'トランザクション');

    // シート3: リスティング
    const lHeader = ['タイトル', '価格', '通貨', 'Price/sqft', 'Median差(%)', 'Avg差(%)', 'Beds', 'Baths', 'Size', '単位', '評価', 'URL'];
    const lData = [lHeader, ...result.listings.map(l => [
      l.title || '',
      l.price_value ?? '',
      l.price_currency || '',
      l.listing_price_per_sqft ? Math.round(l.listing_price_per_sqft * 100) / 100 : '',
      l.diff_pct_median != null ? Math.round(l.diff_pct_median * 10) / 10 : '',
      l.diff_pct_avg != null ? Math.round(l.diff_pct_avg * 10) / 10 : '',
      l.bedrooms || '',
      l.bathrooms || '',
      l.size_value || '',
      l.size_unit || '',
      l.rating || '',
      l.url || '',
    ])];
    const wsL = XLSX.utils.aoa_to_sheet(lData);
    wsL['!cols'] = [
      { wch: 40 }, { wch: 14 }, { wch: 6 }, { wch: 12 },
      { wch: 12 }, { wch: 12 }, { wch: 6 }, { wch: 6 },
      { wch: 10 }, { wch: 6 }, { wch: 8 }, { wch: 60 },
    ];
    XLSX.utils.book_append_sheet(wb, wsL, 'リスティング');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', 'attachment; filename="propertyfinder_analysis.xlsx"');
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error(err);
    res.status(500).send('エラーが発生しました。もう一度お試しください。');
  }
});

app.get('/health', (_req, res) => res.send('ok'));

// ローカル実行時のみlisten（Vercelではモジュールとしてインポートされる）
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

module.exports = app;

