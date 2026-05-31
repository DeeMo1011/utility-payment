const express = require('express');
const multer  = require('multer');
const PDFDocument = require('pdfkit');
const axios  = require('axios');
const { v4: uuidv4 } = require('uuid');
const cors   = require('cors');
const fs     = require('fs');
const path   = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ─── PostgreSQL ───────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id SERIAL PRIMARY KEY,
      water_rate NUMERIC DEFAULT 18,
      electric_rate NUMERIC DEFAULT 8,
      owner_name TEXT DEFAULT 'ชื่อเจ้าของ',
      bank_account TEXT DEFAULT 'ธนาคาร xxx เลขบัญชี xxx',
      line_token TEXT DEFAULT '',
      line_user_id TEXT DEFAULT ''
    )
  `);
  await pool.query(`INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      number TEXT,
      tenant_name TEXT,
      rent NUMERIC DEFAULT 0,
      line_token TEXT DEFAULT '',
      line_user_id TEXT DEFAULT '',
      created_at TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      invoice_no TEXT,
      room_id TEXT,
      month TEXT,
      water_old NUMERIC,
      water_new NUMERIC,
      water_cost NUMERIC,
      electric_old NUMERIC,
      electric_new NUMERIC,
      electric_cost NUMERIC,
      rent NUMERIC DEFAULT 0,
      total NUMERIC,
      pay_token TEXT,
      status TEXT DEFAULT 'pending',
      issued_at TEXT,
      paid_at TEXT,
      slip_file TEXT,
      receipt_no TEXT,
      receipt_file TEXT,
      invoice_file TEXT
    )
  `);
  console.log('[DB] Tables ready');
}

// ─── Paths ───────────────────────────────────────
const UPLOADS_DIR  = path.join(__dirname, 'uploads');
const RECEIPTS_DIR = path.join(__dirname, 'receipts');
[UPLOADS_DIR, RECEIPTS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ─── Middleware ───────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads',  express.static(UPLOADS_DIR));
app.use('/receipts', express.static(RECEIPTS_DIR));

// ─── Multer ───────────────────────────────────────
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

// ─── LINE Messaging API ───────────────────────────
async function sendLine(token, to, message) {
  if (!token || !to) { console.log('[LINE] ไม่ได้ตั้งค่า — ข้าม'); return; }
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

// ─── Font ─────────────────────────────────────────
const FONT_CANDIDATES = [
  { r: path.join(__dirname,'fonts','Sarabun-Regular.ttf'), b: path.join(__dirname,'fonts','Sarabun-Bold.ttf') },
  { r: 'C:\\Windows\\Fonts\\leelawad.ttf', b: 'C:\\Windows\\Fonts\\leelawdb.ttf' },
  { r: 'C:\\Windows\\Fonts\\tahoma.ttf',   b: 'C:\\Windows\\Fonts\\tahomabd.ttf' },
  { r: 'C:\\Windows\\Fonts\\THSarabunNew.ttf', b: 'C:\\Windows\\Fonts\\THSarabunNew Bold.ttf' },
];
let FONT_REGULAR = null, FONT_BOLD = null;
for (const f of FONT_CANDIDATES) {
  if (fs.existsSync(f.r) && fs.existsSync(f.b)) { FONT_REGULAR = f.r; FONT_BOLD = f.b; break; }
}
const hasThaiFonts = !!FONT_REGULAR;
console.log(hasThaiFonts ? `[PDF] Thai font: ${FONT_REGULAR}` : '[PDF] ไม่พบ font ไทย');

// ─── PDF ──────────────────────────────────────────
function generatePDF(invoice, room, settings, type = 'receipt') {
  return new Promise((resolve, reject) => {
    const filename = `${type}_${invoice.id}.pdf`;
    const filepath = path.join(RECEIPTS_DIR, filename);
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);

    if (hasThaiFonts) {
      doc.registerFont('Regular', FONT_REGULAR);
      doc.registerFont('Bold',    FONT_BOLD);
    }
    const fontRegular = hasThaiFonts ? 'Regular' : 'Helvetica';
    const fontBold    = hasThaiFonts ? 'Bold'    : 'Helvetica-Bold';
    const isReceipt   = type === 'receipt';
    const title       = isReceipt ? 'ใบเสร็จรับเงิน' : 'ใบแจ้งหนี้';
    const docNo       = isReceipt ? invoice.receiptNo : invoice.invoiceNo;

    doc.fontSize(22).font(fontBold).text(settings.ownerName, { align: 'center' });
    doc.fontSize(16).font(fontBold).text(title, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(11).font(fontRegular);
    doc.text(`เลขที่: ${docNo}`, { align: 'right' });
    doc.text(`วันที่: ${isReceipt ? invoice.paidAt : invoice.issuedAt}`, { align: 'right' });
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);

    doc.font(fontBold).text('ข้อมูลผู้เช่า');
    doc.font(fontRegular);
    doc.text(`ห้อง: ${room.number}  |  ผู้เช่า: ${room.tenantName}`);
    doc.moveDown(0.5);

    doc.font(fontBold).text('ข้อมูลมิเตอร์');
    doc.font(fontRegular);
    const waterUsed = invoice.waterNew - invoice.waterOld;
    const elecUsed  = invoice.electricNew - invoice.electricOld;
    doc.text(`มิเตอร์น้ำ:  ${invoice.waterOld} ถึง ${invoice.waterNew}  (ใช้ ${waterUsed} หน่วย x ${settings.waterRate} บาท)`);
    doc.text(`มิเตอร์ไฟ:  ${invoice.electricOld} ถึง ${invoice.electricNew}  (ใช้ ${elecUsed} หน่วย x ${settings.electricRate} บาท)`);
    doc.moveDown(0.5);
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
    doc.font(fontBold).fontSize(14);
    doc.text('รวมทั้งสิ้น', 50, doc.y, { width: 380 });
    doc.text(`${invoice.total.toLocaleString()} บาท`, 430, doc.y - doc.currentLineHeight(), { width: 115, align: 'right' });
    doc.moveDown(1);

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

// ─── Helpers ─────────────────────────────────────
function rowToSettings(row) {
  return { waterRate: Number(row.water_rate), electricRate: Number(row.electric_rate),
    ownerName: row.owner_name, bankAccount: row.bank_account,
    lineToken: row.line_token, lineUserId: row.line_user_id };
}
function rowToRoom(row) {
  return { id: row.id, number: row.number, tenantName: row.tenant_name,
    rent: Number(row.rent), lineToken: row.line_token,
    lineUserId: row.line_user_id, createdAt: row.created_at };
}
function rowToInvoice(row) {
  return { id: row.id, invoiceNo: row.invoice_no, roomId: row.room_id, month: row.month,
    waterOld: Number(row.water_old), waterNew: Number(row.water_new), waterCost: Number(row.water_cost),
    electricOld: Number(row.electric_old), electricNew: Number(row.electric_new), electricCost: Number(row.electric_cost),
    rent: Number(row.rent), total: Number(row.total), payToken: row.pay_token, status: row.status,
    issuedAt: row.issued_at, paidAt: row.paid_at, slipFile: row.slip_file,
    receiptNo: row.receipt_no, receiptFile: row.receipt_file, invoiceFile: row.invoice_file };
}

// ═══════════════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════════════
app.get('/api/settings', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM settings WHERE id = 1');
  res.json(rowToSettings(rows[0]));
});

app.put('/api/settings', async (req, res) => {
  const { waterRate, electricRate, ownerName, bankAccount, lineToken, lineUserId } = req.body;
  await pool.query(`UPDATE settings SET
    water_rate = COALESCE($1, water_rate), electric_rate = COALESCE($2, electric_rate),
    owner_name = COALESCE($3, owner_name), bank_account = COALESCE($4, bank_account),
    line_token = COALESCE($5, line_token), line_user_id = COALESCE($6, line_user_id)
    WHERE id = 1`,
    [waterRate, electricRate, ownerName, bankAccount, lineToken, lineUserId]);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════
//  ROOMS
// ═══════════════════════════════════════════════════
app.get('/api/rooms', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM rooms ORDER BY number');
  res.json(rows.map(rowToRoom));
});

app.post('/api/rooms', async (req, res) => {
  const { number, tenantName, rent, lineToken, lineUserId } = req.body;
  const id = uuidv4();
  const createdAt = new Date().toLocaleDateString('th-TH');
  const { rows } = await pool.query(
    `INSERT INTO rooms (id, number, tenant_name, rent, line_token, line_user_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [id, number, tenantName, rent || 0, lineToken || '', lineUserId || '', createdAt]);
  res.json(rowToRoom(rows[0]));
});

app.put('/api/rooms/:id', async (req, res) => {
  const { number, tenantName, rent, lineToken, lineUserId } = req.body;
  const { rows } = await pool.query(
    `UPDATE rooms SET number=COALESCE($1,number), tenant_name=COALESCE($2,tenant_name),
     rent=COALESCE($3,rent), line_token=COALESCE($4,line_token), line_user_id=COALESCE($5,line_user_id)
     WHERE id=$6 RETURNING *`,
    [number, tenantName, rent, lineToken, lineUserId, req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rowToRoom(rows[0]));
});

app.delete('/api/rooms/:id', async (req, res) => {
  await pool.query('DELETE FROM rooms WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════
//  INVOICES
// ═══════════════════════════════════════════════════
app.get('/api/invoices', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM invoices ORDER BY issued_at DESC');
  res.json(rows.map(rowToInvoice));
});

app.post('/api/invoices', async (req, res) => {
  const { roomId, waterOld, waterNew, electricOld, electricNew, month } = req.body;

  const { rows: sRows } = await pool.query('SELECT * FROM settings WHERE id=1');
  const settings = rowToSettings(sRows[0]);

  const { rows: rRows } = await pool.query('SELECT * FROM rooms WHERE id=$1', [roomId]);
  if (!rRows.length) return res.status(404).json({ error: 'Room not found' });
  const room = rowToRoom(rRows[0]);

  const waterCost    = (waterNew - waterOld) * settings.waterRate;
  const electricCost = (electricNew - electricOld) * settings.electricRate;
  const rent         = room.rent || 0;
  const total        = waterCost + electricCost + rent;
  const payToken     = uuidv4().replace(/-/g, '').slice(0, 16);
  const id           = uuidv4();

  const { rows: cRows } = await pool.query('SELECT COUNT(*) FROM invoices');
  const invoiceNo = `INV-${new Date().getFullYear()}-${String(Number(cRows[0].count) + 1).padStart(4, '0')}`;
  const issuedAt  = new Date().toLocaleDateString('th-TH');

  const invoice = {
    id, invoiceNo, roomId, month,
    waterOld: Number(waterOld), waterNew: Number(waterNew), waterCost,
    electricOld: Number(electricOld), electricNew: Number(electricNew), electricCost,
    rent, total, payToken, status: 'pending', issuedAt, paidAt: null,
    slipFile: null, receiptNo: null, receiptFile: null, invoiceFile: null
  };

  invoice.invoiceFile = await generatePDF(invoice, room, settings, 'invoice');

  await pool.query(`INSERT INTO invoices
    (id,invoice_no,room_id,month,water_old,water_new,water_cost,electric_old,electric_new,electric_cost,rent,total,pay_token,status,issued_at,invoice_file)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [id, invoiceNo, roomId, month, waterOld, waterNew, waterCost,
     electricOld, electricNew, electricCost, rent, total, payToken, 'pending', issuedAt, invoice.invoiceFile]);

  const payUrl = `${BASE_URL}/pay/${payToken}`;
  const msg = `📋 แจ้งค่าใช้จ่ายประจำเดือน ${month}\n` +
    `ห้อง: ${room.number} (${room.tenantName})\n━━━━━━━━━━━━━━\n` +
    `💧 ค่าน้ำ: ${waterCost.toLocaleString()} บาท\n⚡ ค่าไฟ: ${electricCost.toLocaleString()} บาท\n` +
    (rent > 0 ? `🏠 ค่าเช่า: ${rent.toLocaleString()} บาท\n` : '') +
    `━━━━━━━━━━━━━━\n💰 รวม: ${total.toLocaleString()} บาท\n` +
    `🏦 โอนเงินที่: ${settings.bankAccount}\n\n✅ กดยืนยันการชำระที่:\n${payUrl}`;

  await sendLine(room.lineToken || settings.lineToken, room.lineUserId || settings.lineUserId, msg);
  res.json(invoice);
});

// ═══════════════════════════════════════════════════
//  PAYMENT CONFIRMATION
// ═══════════════════════════════════════════════════
app.get('/api/pay/:token', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM invoices WHERE pay_token=$1', [req.params.token]);
  if (!rows.length) return res.status(404).json({ error: 'ไม่พบใบแจ้งหนี้' });
  const invoice = rowToInvoice(rows[0]);
  const { rows: rRows } = await pool.query('SELECT * FROM rooms WHERE id=$1', [invoice.roomId]);
  const room = rowToRoom(rRows[0]);
  const { rows: sRows } = await pool.query('SELECT * FROM settings WHERE id=1');
  const settings = rowToSettings(sRows[0]);
  res.json({ invoice, room, settings: { ownerName: settings.ownerName, bankAccount: settings.bankAccount } });
});

app.post('/api/pay/:token', upload.single('slip'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'กรุณาแนบสลิปการโอนเงิน' });

  const { rows } = await pool.query('SELECT * FROM invoices WHERE pay_token=$1', [req.params.token]);
  if (!rows.length) return res.status(404).json({ error: 'ไม่พบใบแจ้งหนี้' });
  const invoice = rowToInvoice(rows[0]);
  if (invoice.status === 'paid') return res.status(400).json({ error: 'ชำระเงินแล้ว' });

  const { rows: rRows } = await pool.query('SELECT * FROM rooms WHERE id=$1', [invoice.roomId]);
  const room = rowToRoom(rRows[0]);
  const { rows: sRows } = await pool.query('SELECT * FROM settings WHERE id=1');
  const settings = rowToSettings(sRows[0]);

  const { rows: pRows } = await pool.query(`SELECT COUNT(*) FROM invoices WHERE status='paid'`);
  const receiptNo  = `RCP-${new Date().getFullYear()}-${String(Number(pRows[0].count) + 1).padStart(4, '0')}`;
  const paidAt     = new Date().toLocaleDateString('th-TH');

  invoice.status      = 'paid';
  invoice.paidAt      = paidAt;
  invoice.slipFile    = req.file.filename;
  invoice.receiptNo   = receiptNo;
  invoice.receiptFile = await generatePDF(invoice, room, settings, 'receipt');

  await pool.query(`UPDATE invoices SET status='paid',paid_at=$1,slip_file=$2,receipt_no=$3,receipt_file=$4 WHERE pay_token=$5`,
    [paidAt, invoice.slipFile, receiptNo, invoice.receiptFile, req.params.token]);

  const receiptUrl = `${BASE_URL}/receipts/${invoice.receiptFile}`;
  const msg = `✅ ยืนยันการชำระเงิน\nห้อง: ${room.number} (${room.tenantName})\n` +
    `ใบเสร็จเลขที่: ${receiptNo}\nจำนวน: ${invoice.total.toLocaleString()} บาท\n` +
    `วันที่: ${paidAt}\n📄 ดาวน์โหลดใบเสร็จ: ${receiptUrl}`;

  await sendLine(room.lineToken || settings.lineToken, room.lineUserId || settings.lineUserId, msg);
  res.json({ ok: true, receiptNo, receiptFile: invoice.receiptFile });
});

// ─── Serve pay page ──────────────────────────────
app.get('/pay/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pay.html'));
});

// ═══════════════════════════════════════════════════
//  LINE WEBHOOK — ผู้เช่าพิมพ์เลขห้องเพื่อลงทะเบียน
// ═══════════════════════════════════════════════════
app.post('/webhook/line', async (req, res) => {
  res.sendStatus(200); // ตอบ LINE ก่อนเสมอ
  try {
    const events = req.body.events || [];
    for (const event of events) {
      if (event.type !== 'message' || event.message.type !== 'text') continue;

      const userId  = event.source.userId;
      const text    = event.message.text.trim();
      const { rows: sRows } = await pool.query('SELECT * FROM settings WHERE id=1');
      const token   = sRows[0]?.line_token;
      if (!token) continue;

      // ผู้เช่าพิมพ์เลขห้อง เช่น "101" หรือ "ห้อง 101"
      const roomNum = text.replace(/ห้อง\s*/i, '').trim();
      const { rows } = await pool.query(
        'SELECT * FROM rooms WHERE LOWER(number) = LOWER($1)', [roomNum]
      );

      if (!rows.length) {
        // ห้องไม่พบ
        await axios.post('https://api.line.me/v2/bot/message/reply',
          { replyToken: event.replyToken, messages: [{ type: 'text',
            text: `❌ ไม่พบห้อง "${roomNum}"\nกรุณาพิมพ์เลขห้องให้ถูกต้อง เช่น 101` }] },
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );
        continue;
      }

      const room = rows[0];
      // บันทึก User ID ลงห้องนั้น
      await pool.query('UPDATE rooms SET line_user_id=$1 WHERE id=$2', [userId, room.id]);

      await axios.post('https://api.line.me/v2/bot/message/reply',
        { replyToken: event.replyToken, messages: [{ type: 'text',
          text: `✅ ลงทะเบียนสำเร็จ!\nห้อง ${room.number} (${room.tenant_name})\n\nตั้งแต่นี้ระบบจะแจ้งค่าน้ำ-ค่าไฟ และส่งลิงก์ชำระเงินมาที่นี่โดยตรงครับ 🏠` }] },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
    }
  } catch (e) {
    console.error('[WEBHOOK]', e.message);
  }
});

// ─── Start ───────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Utility Payment System running at ${BASE_URL}`);
    console.log(`📊 Admin Dashboard: ${BASE_URL}\n`);
  });
}).catch(err => {
  console.error('[DB] Init failed:', err);
  process.exit(1);
});
