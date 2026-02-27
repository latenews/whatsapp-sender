const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const qrcode = require('qrcode');
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

const RECEIVER_NUMBER = '27649794803';
const SESSION_DIR = './session';

let sock = null;
let clientReady = false;

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
      console.log('QR 코드 생성됨');
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
      console.log('연결 끊김, 재연결:', shouldReconnect);
      io.emit('status', { ready: false, message: '연결 끊김 - 재연결 중...' });
      if (shouldReconnect) setTimeout(connectWhatsApp, 5000);
    }
  });
}

connectWhatsApp();

app.get('/api/status', (req, res) => {
  res.json({ ready: clientReady });
});

app.post('/api/send', async (req, res) => {
  const { message } = req.body;
  if (!clientReady || !sock) return res.status(503).json({ success: false, error: 'WhatsApp 미연결' });
  if (!message || !message.trim()) return res.status(400).json({ success: false, error: '메시지 없음' });

  try {
    const jid = `${RECEIVER_NUMBER}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    console.log('✓ 전송 완료:', jid);
    res.json({ success: true });
  } catch (err) {
    console.error('✗ 전송 실패:', err.message);
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
