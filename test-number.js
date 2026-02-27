const { Client, LocalAuth } = require('whatsapp-web.js');

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './session' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--proxy-server=direct://', '--proxy-bypass-list=*', '--no-zygote'],
  },
});

client.on('ready', async () => {
  const numbers = ['27649794803', '649794803', '0649794803'];
  for (const num of numbers) {
    const id = `${num}@c.us`;
    const result = await client.isRegisteredUser(id);
    console.log(`${num} → 등록됨: ${result}`);
  }
  process.exit(0);
});

client.initialize();
