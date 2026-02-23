const https = require('https');

const url = 'https://www.propertyfinder.ae/en/search?l=10493&c=2&fu=0&rp=y&ob=mr';

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
      const finish = html => {
        const regex = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;
        const match = regex.exec(html);
        if (!match) {
          console.error('no __NEXT_DATA__ found');
          return;
        }
        const obj = JSON.parse(match[1]);
        const sr = obj.props?.pageProps?.searchResult;
        if (!sr || !Array.isArray(sr.listings) || sr.listings.length === 0) {
          console.error('no listings found');
          return;
        }
        const l = sr.listings[0];
        console.log(
          JSON.stringify(
            {
              listingsCount: sr.listings.length,
              title: l.property.title,
              details_path: l.property.details_path,
              share_url: l.property.share_url,
              listing_id: l.property.listing_id,
              reference: l.property.reference,
              price: l.property.price,
              property_type: l.property.property_type,
              location: l.property.location,
              bedrooms: l.property.bedrooms,
              bathrooms: l.property.bathrooms,
              beds_baths: l.property.beds_baths,
              size: l.property.size,
              listed_date: l.property.listed_date,
              keys: Object.keys(l.property),
            },
            null,
            2,
          ),
        );
      };

      if (encoding === 'gzip') {
        require('zlib').gunzip(buffer, (err, out) => {
          if (err) return console.error('gunzip error', err);
          finish(out.toString());
        });
      } else if (encoding === 'br') {
        require('zlib').brotliDecompress(buffer, (err, out) => {
          if (err) return console.error('brotli error', err);
          finish(out.toString());
        });
      } else if (encoding === 'deflate') {
        require('zlib').inflate(buffer, (err, out) => {
          if (err) return console.error('inflate error', err);
          finish(out.toString());
        });
      } else {
        finish(buffer.toString());
      }
    });
  },
);

