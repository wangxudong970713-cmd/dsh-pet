/**
 * settings.js —— 桌宠独立设置面板前端交互
 */

'use strict';

let currentConfig = {};

const apiKeyInput = document.getElementById('apiKey');
const toggleApiKeyBtn = document.getElementById('toggleApiKey');
const baseUrlInput = document.getElementById('baseUrl');
const modelInput = document.getElementById('model');
const btnTest = document.getElementById('btnTest');
const testStatus = document.getElementById('testStatus');

const petSizeInput = document.getElementById('petSize');
const sizeVal = document.getElementById('sizeVal');
const whisperEnabledInput = document.getElementById('whisperEnabled');
const whisperIntervalInput = document.getElementById('whisperInterval');
const whisperIntervalGroup = document.getElementById('whisperIntervalGroup');
const whisperImageEnabledInput = document.getElementById('whisperImageEnabled');
const chatImageEnabledInput = document.getElementById('chatImageEnabled');
const whisperPromptInput = document.getElementById('whisperPrompt');
const autoStartEnabledInput = document.getElementById('autoStartEnabled');

const btnSave = document.getElementById('btnSave');
const btnReset = document.getElementById('btnReset');
const saveStatus = document.getElementById('saveStatus');

// 1. 初始化加载配置
async function loadSettings() {
  if (!window.settingsBridge) {
    console.error('settingsBridge not found');
    return;
  }
  try {
    currentConfig = await window.settingsBridge.getSettings();
    applyFormValues(currentConfig);
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

function applyFormValues(cfg) {
  apiKeyInput.value = cfg.apiKey || '';
  baseUrlInput.value = cfg.baseUrl || 'https://api.deepseek.com';
  modelInput.value = cfg.model || 'deepseek-chat';

  const firstPet = (cfg.pets && cfg.pets[0]) || {};
  const size = Number(firstPet.size) || 462;
  petSizeInput.value = size;
  sizeVal.textContent = size + ' px';

  const whisperOn = Boolean(firstPet.whisperEnabled);
  whisperEnabledInput.checked = whisperOn;
  whisperIntervalGroup.style.display = whisperOn ? 'block' : 'none';

  const interval = (firstPet.eventsRefreshSec && firstPet.eventsRefreshSec.whisper) || 300;
  whisperIntervalInput.value = interval;

  whisperImageEnabledInput.checked = Boolean(cfg.whisperImageEnabled);
  chatImageEnabledInput.checked = Boolean(cfg.chatImageEnabled);

  whisperPromptInput.value =
    cfg.whisperPrompt ||
    '你是主人桌面上的Q版小女仆，用简短可爱温柔的口吻说话。20字以内。';

  autoStartEnabledInput.checked = Boolean(cfg.autoStart);
}

// 2. 交互事件监听
// 显示/隐藏 API Key
toggleApiKeyBtn.addEventListener('click', () => {
  if (apiKeyInput.type === 'password') {
    apiKeyInput.type = 'text';
    toggleApiKeyBtn.textContent = '🔒';
  } else {
    apiKeyInput.type = 'password';
    toggleApiKeyBtn.textContent = '👁️';
  }
});

// 快速填入模型
document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    modelInput.value = chip.getAttribute('data-model');
  });
});

// 滑块数值反馈
petSizeInput.addEventListener('input', (e) => {
  sizeVal.textContent = e.target.value + ' px';
});

// 碎碎念开关控制间隔选项
whisperEnabledInput.addEventListener('change', (e) => {
  whisperIntervalGroup.style.display = e.target.checked ? 'block' : 'none';
});

// 测试连接
btnTest.addEventListener('click', async () => {
  const apiKey = apiKeyInput.value.trim();
  const baseUrl = baseUrlInput.value.trim();
  const model = modelInput.value.trim();

  if (!apiKey) {
    testStatus.textContent = '❌ 请先输入 API Key';
    testStatus.className = 'test-status error';
    return;
  }

  testStatus.textContent = '⏳ 测试连接中...';
  testStatus.className = 'test-status loading';
  btnTest.disabled = true;

  try {
    const res = await window.settingsBridge.testConnection({ apiKey, baseUrl, model });
    if (res.ok) {
      testStatus.textContent = '✅ ' + res.message;
      testStatus.className = 'test-status success';
    } else {
      testStatus.textContent = '❌ ' + res.message;
      testStatus.className = 'test-status error';
    }
  } catch (e) {
    testStatus.textContent = '❌ 发生异常: ' + (e.message || String(e));
    testStatus.className = 'test-status error';
  } finally {
    btnTest.disabled = false;
  }
});

// 保存设置
btnSave.addEventListener('click', async () => {
  const apiKey = apiKeyInput.value.trim();
  const baseUrl = baseUrlInput.value.trim() || 'https://api.deepseek.com';
  const model = modelInput.value.trim() || 'deepseek-chat';
  const size = Number(petSizeInput.value) || 462;
  const whisperEnabled = whisperEnabledInput.checked;
  const whisperInterval = Math.max(10, Number(whisperIntervalInput.value) || 300);
  const whisperImageEnabled = whisperImageEnabledInput.checked;
  const chatImageEnabled = chatImageEnabledInput.checked;
  const whisperPrompt = whisperPromptInput.value.trim();
  const autoStart = autoStartEnabledInput.checked;

  const pets = (currentConfig.pets && currentConfig.pets.length > 0)
    ? currentConfig.pets.map((p, idx) => ({
        ...p,
        size: idx === 0 ? size : p.size,
        whisperEnabled: idx === 0 ? whisperEnabled : p.whisperEnabled,
        eventsRefreshSec: {
          ...(p.eventsRefreshSec || {}),
          whisper: idx === 0 ? whisperInterval : ((p.eventsRefreshSec && p.eventsRefreshSec.whisper) || 300),
        },
      }))
    : [
        {
          id: 'main',
          size,
          whisperEnabled,
          display: 'desktop',
          eventsRefreshSec: { whisper: whisperInterval },
        },
      ];

  const payload = {
    apiKey,
    baseUrl,
    model,
    whisperPrompt,
    whisperImageEnabled,
    chatImageEnabled,
    autoStart,
    pets,
  };

  btnSave.disabled = true;
  saveStatus.textContent = '正在保存...';

  try {
    await window.settingsBridge.saveSettings(payload);
    currentConfig = { ...currentConfig, ...payload };
    saveStatus.textContent = '✅ 保存成功！已同步至桌宠';
    setTimeout(() => {
      saveStatus.textContent = '';
    }, 3000);
  } catch (e) {
    saveStatus.textContent = '❌ 保存失败: ' + (e.message || String(e));
  } finally {
    btnSave.disabled = false;
  }
});

// 重置默认
btnReset.addEventListener('click', () => {
  if (confirm('确定要恢复默认配置吗？（已填写的 API 密钥不会丢失）')) {
    const keepApiKey = apiKeyInput.value;
    applyFormValues({
      apiKey: keepApiKey,
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      whisperImageEnabled: false,
      chatImageEnabled: false,
      autoStart: false,
      whisperPrompt: '你是主人桌面上的Q版小女仆，用简短可爱温柔的口吻说话。20字以内。',
      pets: [{ id: 'main', size: 462, whisperEnabled: false, eventsRefreshSec: { whisper: 300 } }],
    });
  }
});

// 启动执行
loadSettings();
