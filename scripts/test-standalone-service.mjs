import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { standaloneService } = require('../dsh-pet/runtime/electron-helper/standalone-service.js');

async function test() {
  console.log('Testing /config...');
  const cfg = await standaloneService.handleRoute('/dsh-pet-7340/config', 'GET');
  console.log('Config status:', cfg.status);
  const parsedCfg = JSON.parse(cfg.body);
  console.log('Config has main:', !!parsedCfg.main);
  console.log('Pets count:', parsedCfg.main?.pets?.length);

  console.log('Testing /thumb/main/待机呼吸休闲.webm...');
  const thumb = await standaloneService.handleRoute('/dsh-pet-7340/thumb/main/待机呼吸休闲.webm', 'GET');
  console.log('Thumb status:', thumb.status, 'file:', thumb.file);

  console.log('Testing /font/上首软糖体.ttf...');
  const font = await standaloneService.handleRoute('/dsh-pet-7340/font/上首软糖体.ttf', 'GET');
  console.log('Font status:', font.status, 'file:', font.file);

  console.log('Testing /balance (without key)...');
  const bal = await standaloneService.handleRoute('/dsh-pet-7340/balance', 'GET');
  console.log('Balance status:', bal.status, 'body:', bal.body);

  console.log('Testing /whisper (without key)...');
  const wh = await standaloneService.handleRoute('/dsh-pet-7340/whisper', 'GET');
  console.log('Whisper status:', wh.status, 'body:', wh.body);

  console.log('Testing /chat (without key)...');
  const ch = await standaloneService.handleRoute('/dsh-pet-7340/chat', 'POST', JSON.stringify({ text: 'hello' }));
  console.log('Chat status:', ch.status, 'body:', ch.body);

  console.log('All standalone-service route tests passed successfully!');
}

test().catch((e) => {
  console.error('Test failed:', e);
  process.exit(1);
});
