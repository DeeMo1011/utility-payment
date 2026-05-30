const express = require('express');
const multer  = require('multer');
const PDFDocument = require('pdfkit');
const axios  = require('axios');
const { v4: uuidv4 } = require('uuid');
const cors   = require('cors');
const fs     = require('fs');
const path   = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ─── Paths ───────────────────────────────────────
const DB_PATH      = path.join(__dirname, 'db.json');
const UPLOADS_DIR  = path.join(__dirname, 'uploads');
const RECEIPTS_DIR = path.join(__dirname, 'receipts');

[UPLOADS_DIR, RECEIPTS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ─── Middleware ───────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads',  express.static(UPLOADS_DIR));
app.use('/receipts', express.static(RECEIPTS_DIR));

// ─── Multer (slip upload) ─────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => cb(null, `slip_${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    cb(null, allowed.test(file.mimetype));
  }
});

// ─── DB helpers ──────────────────────────────────
function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    const init = {
      settings: { waterRate: 18, electricRate: 8, ownerName: 'ชื่อเจ้าของ', bankAccount: 'ธนาคาร xxx เลขบัญชี xxx', lineToken: '', lineUserId: '' },
      rooms: [],
      invoices: []
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(init, null, 2));
    return init;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ─── LINE Messaging API ───────────────────────────
// token = Channel Access Token, to = User ID หรือ Group ID
async function sendLine(token, to, message) {
  if (!token || !to) {
    console.log('[LINE] ยังไม่ได้ตั้งค่า Channel Token หรือ User/Group ID — ข้าม');
    return;
  }
  try {
    await axios.post('https://api.line.me/v2/bot/message/push',
      { to, messages: [{ type: 'text', text: message }] },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    console.log('[LINE] ส่งสำเร็จ →', to);
  } catch (e) {
    console.error('[LINE] Error:', e.response?.data || e.message);
  }
}

// ─── Font paths (Windows system Thai fonts) ───────
const FONT_CANDIDATES = [
  { r: path.join(__dirname,'fonts','Sarabun-Regular.ttf'), b: path.join(__dirname,'fonts','Sarabun-Bold.ttf') },
  { r: 'C:\\Windows\\Fonts\\leelawad.ttf',            b: 'C:\\Windows\\Fonts\\leelawdb.ttf' },
  { r: 'C:\\Windows\\Fonts\\tahoma.ttf',              b: 'C:\\Windows\\Fonts\\tahomabd.ttf' },
  { r: 'C:\\Windows\\Fonts\\THSarabunNew.ttf',        b: 'C:\\Windows\\Fonts\\THSarabunNew Bold.ttf' },
];
let FONT_REGULAR = null, FONT_BOLD = null;
for (const f of FONT_CANDIDATES) {
  if (fs.existsSync(f.r) && fs.existsSync(f.b)) { FONT_REGULAR = f.r; FONT_BOLD = f.b; break; }
}
const hasThaiFonts = !!FONT_REGULAR;
console.log(hasThaiFonts ? `[PDF] Thai font: ${FONT_REGULAR}` : '[PDF] ไม่พบ font ไทย');

// ─── PDF Receipt / Invoice ────────────────────────
function generatePDF(invoice, room, settings, type = 'receipt') {
  return new Promise((resolve, reject) => {
    const filename = `${type}_${invoice.id}.pdf`;
    const filepath = path.join(RECEIPTS_DIR, filename);
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);

    // Register Thai fonts if available
    if (hasThaiFonts) {
      doc.registerFont('Regular', FONT_REGULAR);
      doc.registerFont('Bold',    FONT_BOLD);
    }
    const fontRegular = hasThaiFonts ? 'Regular' : 'Helvetica';
    const fontBold    = hasThaiFonts ? 'Bold'    : 'Helvetica-Bold';

    const isReceipt = type === 'receipt';
    const title     = isReceipt ? 'ใบเสร็จรับเงิน' : 'ใบแจ้งหนี้';
    const docNo     = isReceipt ? invoice.receiptNo : invoice.invoiceNo;

    // Header
    doc.fontSize(22).font(fontBold).text(settings.ownerName, { align: 'center' });
    doc.fontSize(16).font(fontBold).text(title, { align: 'center' });
    doc.moveDown(0.5);

    // Meta
    doc.fontSize(11).font(fontRegular);
    doc.text(`เลขที่: ${docNo}`, { align: 'right' });
    doc.text(`วันที่: ${isReceipt ? invoice.paidAt : invoice.issuedAt}`, { align: 'right' });
    doc.moveDown(0.5);

    // Divider
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);

    // Room info
    doc.font(fontBold).text('ข้อมูลผู้เช่า');
    doc.font(fontRegular);
    doc.text(`ห้อง: ${room.number}  |  ผู้เช่า: ${room.tenantName}`);
    doc.moveDown(0.5);

    // Meter
    doc.font(fontBold).text('ข้อมูลมิเตอร์');
    doc.font(fontRegular);
    const waterUsed = invoice.waterNew - invoice.waterOld;
    const elecUsed  = invoice.electricNew - invoice.electricOld;
    doc.text(`มิเตอร์น้ำ:  ${invoice.waterOld} ถึง ${invoice.waterNew}  (ใช้ ${waterUsed} หน่วย x ${settings.waterRate} บาท)`);
    doc.text(`มิเตอร์ไฟ:  ${invoice.electricOld} ถึง ${invoice.electricNew}  (ใช้ ${elecUsed} หน่วย x ${settings.electricRate} บาท)`);
    doc.moveDown(0.5);

    // Items table
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.3);
    doc.font(fontBold);
    doc.text('รายการ', 50, doc.y, { width: 300 });
    doc.text('จำนวน', 350, doc.y - doc.currentLineHeight(), { width: 80, align: 'right' });
    doc.text('ราคา (บาท)', 430, doc.y - doc.currentLineHeight(), { width: 115, align: 'right' });
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.3);

    const items = [
      { name: 'ค่าน้ำ', qty: `${waterUsed} unit`, amount: invoice.waterCost },
      { name: 'ค่าไฟ', qty: `${elecUsed} unit`, amount: invoice.electricCost },
    ];
    if (invoice.rent > 0) items.push({ name: 'ค่าเช่าห้อง', qty: '1 เดือน', amount: invoice.rent });

    doc.font(fontRegular);
    items.forEach(item => {
      const y = doc.y;
      doc.text(item.name, 50, y, { width: 300 });
      doc.text(item.qty, 350, y, { width: 80, align: 'right' });
      doc.text(item.amount.toLocaleString(), 430, y, { width: 115, align: 'right' });
      doc.moveDown(0.4);
    });

    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.3);

    // Total
    doc.font(fontBold).fontSize(14);
    doc.text('รวมทั้งสิ้น', 50, doc.y, { width: 380 });
    doc.text(`${invoice.total.toLocaleString()} บาท`, 430, doc.y - doc.currentLineHeight(), { width: 115, align: 'right' });
    doc.moveDown(1);

    // Payment info
    if (!isReceipt) {
      doc.fontSize(11).font(fontRegular);
      doc.text(`กำหนดชำระ: ภายในสิ้นเดือน`);
      doc.text(`ชำระผ่าน: ${settings.bankAccount}`);
      doc.moveDown(0.5);
      doc.fontSize(10).fillColor('gray').text('หลังโอนกรุณาแนบสลิปและยืนยันการชำระที่ลิงก์ด้านล่าง');
    } else {
      doc.fontSize(11).font(fontBold).fillColor('green');
      doc.text('ชำระเงินเรียบร้อยแล้ว', { align: 'center' });
    }

    doc.end();
    stream.on('finish', () => resolve(filename));
    stream.on('error', reject);
  });
}

// ═══════════════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════════════
app.get('/api/settings', (req, res) => {
  const db = readDB();
  res.json(db.settings);
});

app.put('/api/settings', (req, res) => {
  const db = readDB();
  db.settings = { ...db.settings, ...req.body };
  writeDB(db);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════
//  ROOMS
// ═══════════════════════════════════════════════════
app.get('/api/rooms', (req, res) => {
  res.json(readDB().rooms);
});

app.post('/api/rooms', (req, res) => {
  const db = readDB();
  const room = { id: uuidv4(), ...req.body, createdAt: new Date().toLocaleDateString('th-TH') };
  db.rooms.push(room);
  writeDB(db);
  res.json(room);
});

app.put('/api/rooms/:id', (req, res) => {
  const db = readDB();
  const idx = db.rooms.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.rooms[idx] = { ...db.rooms[idx], ...req.body };
  writeDB(db);
  res.json(db.rooms[idx]);
});

app.delete('/api/rooms/:id', (req, res) => {
  const db = readDB();
  db.rooms = db.rooms.filter(r => r.id !== req.params.id);
  writeDB(db);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════
//  INVOICES
// ═══════════════════════════════════════════════════
app.get('/api/invoices', (req, res) => {
  res.json(readDB().invoices);
});

// Create invoice from meter reading
app.post('/api/invoices', async (req, res) => {
  const db = readDB();
  const { roomId, waterOld, waterNew, electricOld, electricNew, month } = req.body;

  const room = db.rooms.find(r => r.id === roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const { waterRate, electricRate, bankAccount, lineToken, lineUserId, ownerName } = db.settings;
  const waterCost    = (waterNew - waterOld) * waterRate;
  const electricCost = (electricNew - electricOld) * electricRate;
  const rent         = Number(room.rent) || 0;
  const total        = waterCost + electricCost + rent;
  const payToken     = uuidv4().replace(/-/g, '').slice(0, 16);

  const invoiceCount = db.invoices.length + 1;
  const invoiceNo    = `INV-${new Date().getFullYear()}-${String(invoiceCount).padStart(4, '0')}`;

  const invoice = {
    id: uuidv4(), invoiceNo, roomId, month,
    waterOld: Number(waterOld), waterNew: Number(waterNew), waterCost,
    electricOld: Number(electricOld), electricNew: Number(electricNew), electricCost,
    rent, total, payToken,
    status: 'pending', // pending | paid
    issuedAt: new Date().toLocaleDateString('th-TH'),
    paidAt: null, slipFile: null, receiptNo: null, receiptFile: null,
  };

  // Generate invoice PDF
  invoice.invoiceFile = await generatePDF(invoice, room, db.settings, 'invoice');

  db.invoices.push(invoice);
  writeDB(db);

  // LINE Messaging API
  const payUrl = `${BASE_URL}/pay/${payToken}`;
  const msg = `📋 แจ้งค่าใช้จ่ายประจำเดือน ${month}\n` +
    `ห้อง: ${room.number} (${room.tenantName})\n` +
    `━━━━━━━━━━━━━━\n` +
    `💧 ค่าน้ำ: ${waterCost.toLocaleString()} บาท\n` +
    `⚡ ค่าไฟ: ${electricCost.toLocaleString()} บาท\n` +
    (rent > 0 ? `🏠 ค่าเช่า: ${rent.toLocaleString()} บาท\n` : '') +
    `━━━━━━━━━━━━━━\n` +
    `💰 รวม: ${total.toLocaleString()} บาท\n` +
    `🏦 โอนเงินที่: ${bankAccount}\n\n` +
    `✅ กดยืนยันการชำระที่:\n${payUrl}`;

  const chanToken = room.lineToken || lineToken;
  const lineToId  = room.lineUserId || lineUserId;
  await sendLine(chanToken, lineToId, msg);

  res.json(invoice);
});

// ═══════════════════════════════════════════════════
//  PAYMENT CONFIRMATION (Tenant)
// ═══════════════════════════════════════════════════
app.get('/api/pay/:token', (req, res) => {
  const db = readDB();
  const invoice = db.invoices.find(i => i.payToken === req.params.token);
  if (!invoice) return res.status(404).json({ error: 'ไม่พบใบแจ้งหนี้' });
  const room = db.rooms.find(r => r.id === invoice.roomId);
  res.json({ invoice, room, settings: { ownerName: db.settings.ownerName, bankAccount: db.settings.bankAccount } });
});

app.post('/api/pay/:token', upload.single('slip'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'กรุณาแนบสลิปการโอนเงิน' });

  const db = readDB();
  const idx = db.invoices.findIndex(i => i.payToken === req.params.token);
  if (idx === -1) return res.status(404).json({ error: 'ไม่พบใบแจ้งหนี้' });

  const invoice = db.invoices[idx];
  if (invoice.status === 'paid') return res.status(400).json({ error: 'ชำระเงินแล้ว' });

  const room = db.rooms.find(r => r.id === invoice.roomId);
  const { lineToken, lineUserId, ownerName } = db.settings;

  // Update invoice
  const receiptCount = db.invoices.filter(i => i.status === 'paid').length + 1;
  invoice.status    = 'paid';
  invoice.paidAt    = new Date().toLocaleDateString('th-TH');
  invoice.slipFile  = req.file.filename;
  invoice.receiptNo = `RCP-${new Date().getFullYear()}-${String(receiptCount).padStart(4, '0')}`;

  // Generate receipt PDF
  invoice.receiptFile = await generatePDF(invoice, room, db.settings, 'receipt');
  db.invoices[idx] = invoice;
  writeDB(db);

  // LINE Messaging API
  const receiptUrl = `${BASE_URL}/receipts/${invoice.receiptFile}`;
  const msg = `✅ ยืนยันการชำระเงิน\n` +
    `ห้อง: ${room.number} (${room.tenantName})\n` +
    `ใบเสร็จเลขที่: ${invoice.receiptNo}\n` +
    `จำนวน: ${invoice.total.toLocaleString()} บาท\n` +
    `วันที่: ${invoice.paidAt}\n` +
    `📄 ดาวน์โหลดใบเสร็จ: ${receiptUrl}`;

  const chanToken = room.lineToken || lineToken;
  const lineToId  = room.lineUserId || lineUserId;
  await sendLine(chanToken, lineToId, msg);

  res.json({ ok: true, receiptNo: invoice.receiptNo, receiptFile: invoice.receiptFile });
});

// ─── Serve pay page ──────────────────────────────
app.get('/pay/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pay.html'));
});

// ─── Start ───────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Utility Payment System running at ${BASE_URL}`);
  console.log(`📊 Admin Dashboard: ${BASE_URL}`);
  console.log(`📁 DB: ${DB_PATH}\n`);
});
