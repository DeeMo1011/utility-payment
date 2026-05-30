const https = require('https');
const fs = require('fs');
const path = require('path');

const fontsDir = path.join(__dirname, 'fonts');
fs.mkdirSync(fontsDir, { recursive: true });

const fonts = [
  {
    url: 'https://fonts.gstatic.com/s/sarabun/v13/DtVmJx26TKEr37c9YHZJmnYI5gnOpg.ttf',
    file: 'Sarabun-Regular.ttf'
  },
  {
    url: 'https://fonts.gstatic.com/s/sarabun/v13/DtVhJx26TKEr37c9YL5QtmLZ5pyzHg.ttf',
    file: 'Sarabun-Bold.ttf'
  }
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

(async () => {
  for (const font of fonts) {
    const dest = path.join(fontsDir, font.file);
    process.stdout.write(`Downloading ${font.file}... `);
    await download(font.url, dest);
    console.log('✅');
  }
  console.log('\n✅ Font ดาวน์โหลดเสร็จแล้ว! พร้อมใช้งาน');
})();
