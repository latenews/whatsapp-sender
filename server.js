const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const mysql = require('mysql2/promise');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SESSION_DIR = './session';
const NUMBERS_FILE = './numbers.json';

const pool = mysql.createPool({
  socketPath: '/var/lib/mysql/mysql.sock',
  user: 'root',
  password: '02010110',
  database: 'my_member_db',
  waitForConnections: true,
  connectionLimit: 10,
});

pool.getConnection()
  .then(conn => { console.log('✓ DB 연결 성공'); conn.release(); })
  .catch(err => console.error('✗ DB 연결 실패:', err.message));

function loadNumbers() {
  try {
    if (fs.existsSync(NUMBERS_FILE)) return JSON.parse(fs.readFileSync(NUMBERS_FILE, 'utf8'));
  } catch(e) {}
  return [];
}

function saveNumbers(nums) {
  fs.writeFileSync(NUMBERS_FILE, JSON.stringify(nums, null, 2));
}

let menuCache = [];
let sock = null;
let clientReady = false;

function parseOrder(text) {
  const results = [];
  const t = text.trim();
  let m;

  // 패턴1: "1번 2개", "1번2개"
  const p1 = /(\d+)\s*번\s*에?\s*(\d+)\s*[개묶음팩]?/g;
  // 패턴2: "1 x 2", "1x2"
  const p2 = /(\d+)\s*[xX×]\s*(\d+)/g;
  // 패턴3: "1-2", "1:2"
  const p3 = /(\d+)\s*[-:]\s*(\d+)/g;
  // 패턴4: "1,2"
  const p4 = /(\d+)\s*,\s*(\d+)/g;

  let matched = false;

  for (const pattern of [p1, p2, p3, p4]) {
    pattern.lastIndex = 0;
    while ((m = pattern.exec(t)) !== null) {
      const no = parseInt(m[1]);
      const qty = parseInt(m[2]);
      if (no >= 1 && no <= menuCache.length && qty >= 1 && qty <= 9999) {
        if (!results.find(r => r.no === no)) {
          results.push({ no, qty, item: menuCache[no-1] });
          matched = true;
        }
      }
    }
    if (matched) break;
  }

  // 패턴5: 숫자 나열 "1 2 3 4"
  if (!matched) {
    const nums = [];
    const p5 = /\b(\d+)\b/g;
    while ((m = p5.exec(t)) !== null) nums.push(parseInt(m[0]));
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const no = nums[i];
      const qty = nums[i+1];
      if (no >= 1 && no <= menuCache.length && qty >= 1 && qty <= 9999) {
        results.push({ no, qty, item: menuCache[no-1] });
      }
    }
  }

  return results;
}

async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['Chrome', 'Desktop', '110.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      const qrDataUrl = await qrcode.toDataURL(qr);
      clientReady = false;
      io.emit('qr', qrDataUrl);
      io.emit('status', { ready: false, message: 'QR 코드를 스캔해주세요' });
    }
    if (connection === 'open') {
      console.log('WhatsApp 연결됨!');
      clientReady = true;
      io.emit('ready', {});
      io.emit('status', { ready: true, message: '연결됨 · 076 311 1528' });
    }
    if (connection === 'close') {
      clientReady = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      io.emit('status', { ready: false, message: '연결 끊김 - 재연결 중...' });
      if (shouldReconnect) setTimeout(connectWhatsApp, 5000);
    }
  });

  // ── 메시지 수신 ──
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      const jid = msg.key.remoteJidAlt || msg.key.remoteJid;
      const senderNumber = jid.replace('@s.whatsapp.net', '').replace('@lid', '');
      const text = msg.message?.conversation ||
                   msg.message?.extendedTextMessage?.text || '';

      if (!text.trim()) continue;

      console.log(`📩 수신 [${senderNumber}]: ${text}`);

      // 등록 번호 확인
      const regNumbers = loadNumbers();
      const found = regNumbers.find(n => n.number === senderNumber);
      const senderLabel = found ? (found.label || senderNumber) : senderNumber;

      console.log(`✅ 매칭: ${found ? found.label : '미등록'}`);

      // menuCache 없으면 DB에서 자동 로드
      if (menuCache.length === 0) {
        try {
          const [rows] = await pool.query(
            'SELECT item_id, item_name, brand, volume, price FROM items ORDER BY item_id ASC'
          );
          menuCache = rows;
          console.log(`✓ menuCache 자동 로드: ${rows.length}개`);
        } catch(e) {
          console.log('menuCache 로드 실패:', e.message);
        }
      }

      // 주문 파싱
      const orders = parseOrder(text);
      if (orders.length > 0) {
        // 수신 번호로 회원 조회 (0으로 시작하는 로컬 번호로 변환해서 검색)
        let userId = null;
        try {
          const localNumber = '0' + senderNumber.slice(2); // 27649... → 0649...
          const [members] = await pool.query(
            'SELECT user_id FROM members WHERE phone = ? OR phone = ? LIMIT 1',
            [senderNumber, localNumber]
          );
          if (members.length > 0) {
            userId = members[0].user_id;
            console.log(`✓ 회원 찾음: user_id=${userId}`);
          } else {
            console.log(`⚠️ 미등록 회원: ${senderNumber}`);
          }
        } catch(e) {
          console.log('회원 조회 실패:', e.message);
        }

        // orders 테이블에 저장
        const savedOrders = [];
        if (userId) {
          for (const order of orders) {
            try {
              const totalPrice = order.item.price * order.qty;
              const [result] = await pool.query(
                'INSERT INTO orders (user_id, item_id, quantity, total_price, status) VALUES (?, ?, ?, ?, 1)',
                [userId, order.item.item_id, order.qty, totalPrice]
              );
              savedOrders.push(result.insertId);
              console.log(`✓ 주문 저장: order_id=${result.insertId}`);
            } catch(e) {
              console.log('주문 저장 실패:', e.message);
            }
          }
        }

        io.emit('order_received', {
          sender: senderLabel,
          senderNumber,
          rawText: text,
          orders,
          savedOrders,
          userId,
          receivedAt: new Date().toLocaleString('ko-KR'),
        });
        console.log(`✓ 주문 파싱 완료:`, orders.length, '개');
      } else {
        io.emit('message_received', {
          sender: senderLabel,
          senderNumber,
          text,
          receivedAt: new Date().toLocaleString('ko-KR'),
        });
        console.log(`💬 일반 메시지 전송`);
      }
    }
  });
}

connectWhatsApp();

// ── API ──
app.get('/api/status', (req, res) => res.json({ ready: clientReady }));

app.get('/api/numbers', (req, res) => res.json(loadNumbers()));

app.post('/api/numbers', (req, res) => {
  const { label, number } = req.body;
  if (!number) return res.status(400).json({ error: '번호를 입력하세요' });
  let clean = number.replace(/\D/g, '');
  if (clean.startsWith('0')) clean = '27' + clean.slice(1);
  const nums = loadNumbers();
  if (nums.find(n => n.number === clean)) return res.status(400).json({ error: '이미 존재하는 번호입니다' });
  nums.push({ label: label || number, number: clean });
  saveNumbers(nums);
  res.json({ success: true, numbers: nums });
});

app.delete('/api/numbers/:number', (req, res) => {
  const nums = loadNumbers().filter(n => n.number !== req.params.number);
  saveNumbers(nums);
  res.json({ success: true, numbers: nums });
});

app.get('/api/menu', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT item_id, item_name, brand, volume, price FROM items ORDER BY item_id ASC'
    );
    menuCache = rows;
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/send-menu', async (req, res) => {
  const { number } = req.body;
  if (!clientReady || !sock) return res.status(503).json({ success: false, error: 'WhatsApp 미연결' });
  try {
    const [rows] = await pool.query(
      'SELECT item_id, item_name, brand, volume, price FROM items ORDER BY item_id ASC'
    );
    menuCache = rows;

    let menuText = '📋 *주문 메뉴*\n';
    menuText += '━━━━━━━━━━━━━━━\n';
    rows.forEach((item, i) => {
      menuText += `${i+1}. ${item.item_name}`;
      if (item.brand) menuText += ` (${item.brand})`;
      if (item.volume) menuText += ` - ${item.volume}`;
      menuText += ` · R${item.price}\n`;
    });
    menuText += '━━━━━━━━━━━━━━━\n';
    menuText += '📌 번호와 수량을 입력해주세요\n';
    menuText += '예) 1 2  →  1번 상품 2개\n';
    menuText += '    1 2 3 4  →  1번 2개, 3번 4개';

    const jid = `${number}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: menuText });
    console.log('✓ 메뉴 발송:', jid);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/send', async (req, res) => {
  const { message, number } = req.body;
  if (!clientReady || !sock) return res.status(503).json({ success: false, error: 'WhatsApp 미연결' });
  if (!message?.trim()) return res.status(400).json({ success: false, error: '메시지 없음' });
  if (!number) return res.status(400).json({ success: false, error: '수신 번호 없음' });
  try {
    const jid = `${number}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    console.log('✓ 전송 완료:', jid);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

io.on('connection', (socket) => {
  if (clientReady) {
    socket.emit('ready', {});
    socket.emit('status', { ready: true, message: '연결됨 · 076 311 1528' });
  } else {
    socket.emit('status', { ready: false, message: '초기화 중...' });
  }
});

const PORT = 3000;
server.listen(PORT, () => console.log(`서버 실행: http://localhost:${PORT}`));
