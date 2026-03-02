const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

async function test() {
  const { state, saveCreds } = await useMultiFileAuthState('./session');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection }) => {
    console.log('연결 상태:', connection);
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    console.log('📩 수신 타입:', type);
    for (const msg of messages) {
      console.log('메시지:', JSON.stringify(msg, null, 2));
    }
  });
}

test();
