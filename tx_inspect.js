const https = require('https');
const zlib = require('zlib');

const url =
  'https://www.propertyfinder.ae/en/transactions/buy/dubai/jumeirah-lake-towers-uptown-dubai-uptown-tower?period=1y&fu=0&ob=mr&sort=sqa';

function fetchHtml(u) {
  return new Promise((resolve, reject) => {
    https.get(
      u,
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
            zlib.gunzip(buffer, (err, out) => (err ? reject(err) : finish(out)));
          } else if (encoding === 'br') {
            zlib.brotliDecompress(buffer, (err, out) =>
              err ? reject(err) : finish(out),
            );
          } else if (encoding === 'deflate') {
            zlib.inflate(buffer, (err, out) => (err ? reject(err) : finish(out)));
          } else {
            finish(buffer);
          }
        });
        res.on('error', reject);
      },
    );
  });
}

function extractTx(html) {
  const m =
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(
      html,
    );
  if (!m) return [];
  const obj = JSON.parse(m[1]);
  return (
    obj?.props?.pageProps?.transactions?.transactions_list?.transactions?.items ||
    []
  );
}

async function run() {
  const html = await fetchHtml(url);
  const tx = extractTx(html);
  console.log('items:', tx.length);
  if (tx[0]) {
    console.log('keys:', Object.keys(tx[0]));
    console.log('first:', tx[0]);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

