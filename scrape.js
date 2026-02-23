// Property Finder の検索結果を __NEXT_DATA__ から取得し、CSV出力する簡易スクリプト
// 使い方: node scrape.js [検索URL] [取得ページ数] [出力ファイル名]
// 例: node scrape.js "https://www.propertyfinder.ae/en/search?l=10493&c=2&fu=0&rp=y&ob=mr" 2 result.csv

const https = require('https');
const zlib = require('zlib');
const fs = require('fs');

const searchUrl =
  process.argv[2] ||
  'https://www.propertyfinder.ae/en/search?l=10493&c=2&fu=0&rp=y&ob=mr';
const pages = Number(process.argv[3] || '1');
const output = process.argv[4] || 'output.csv';

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

async function run() {
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
    const url = buildPageUrl(searchUrl, p);
    // 規約に配慮し、必要最小限のリクエストだけ送る。
    // 実務で大量取得する場合はスリープを入れるなどマナーを守ること。
    const html = await fetchHtml(url);
    const listings = extractListings(html);
    for (const item of listings) {
      const prop = item.property || {};
      const price = prop.price || {};
      const size = prop.size || {};
      const loc = prop.location || {};
      const shareUrl = prop.share_url || (prop.details_path ? `https://www.propertyfinder.ae${prop.details_path}` : '');

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

  fs.writeFileSync(output, toCsv(rows, header), 'utf8');
  console.log(`done. rows=${rows.length}, file=${output}`);
}

run().catch(err => {
  console.error('error', err);
  process.exit(1);
});

