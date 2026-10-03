'use strict';

/**
 * update-checker.js —— 桌面端静默检查更新模块
 *
 * 职责：
 * 1. 静默检测 GitHub Releases 最新版本；
 * 2. 带有 24 小时本地缓存锁，避免无认证 API 触发 GitHub IP 限流（60次/小时）；
 * 3. 支持版本语义对比（Semver），在托盘与设置面板展示更新提示。
 */

const fs = require('node:fs');
const path = require('node:path');

const REPOS = [
  'wangxudong970713-cmd/dsh-pet',
  'PC2005-cloud/dsh-pet',
];

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时缓存

/** 简易语义化版本比对：remote > current 返回 1，小于返回 -1，等于返回 0 */
function compareSemver(v1, v2) {
  const p1 = String(v1 || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const p2 = String(v2 || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(p1.length, p2.length, 3);
  for (let i = 0; i < len; i++) {
    const a = p1[i] || 0;
    const b = p2[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

class UpdateChecker {
  constructor(opts = {}) {
    this.userDataDir = opts.userDataDir || '';
    this.cacheFile = this.userDataDir ? path.join(this.userDataDir, 'update-cache.json') : '';
  }

  readCache() {
    if (!this.cacheFile) return null;
    try {
      if (fs.existsSync(this.cacheFile)) {
        return JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  writeCache(data) {
    if (!this.cacheFile) return;
    try {
      fs.writeFileSync(this.cacheFile, JSON.stringify(data, null, 2), 'utf8');
    } catch {
      /* ignore */
    }
  }

  async fetchLatestRelease(repo) {
    const url = `https://api.github.com/repos/${repo}/releases/latest`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const resp = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'dsh-pet-desktop-helper',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (resp.ok) {
        return await resp.json();
      }
    } catch {
      clearTimeout(timer);
    }
    return null;
  }

  async check(currentVersion, { force = false } = {}) {
    const now = Date.now();
    const cached = this.readCache();

    if (!force && cached && cached.checkedAt && now - cached.checkedAt < CACHE_TTL_MS && cached.release) {
      const rel = cached.release;
      const latestVer = String(rel.tag_name || '').replace(/^v/i, '');
      const hasUpdate = compareSemver(latestVer, currentVersion) > 0;
      return {
        ok: true,
        hasUpdate,
        currentVersion,
        latestVersion: latestVer,
        tagName: rel.tag_name,
        releaseUrl: rel.html_url || `https://github.com/${REPOS[0]}/releases`,
        releaseNotes: rel.body || '',
        publishedAt: rel.published_at || '',
        fromCache: true,
      };
    }

    let release = null;
    for (const repo of REPOS) {
      release = await this.fetchLatestRelease(repo);
      if (release && release.tag_name) break;
    }

    if (!release || !release.tag_name) {
      return {
        ok: false,
        message: '未能连接到 GitHub Releases 或未找到发布版本',
        currentVersion,
      };
    }

    this.writeCache({
      checkedAt: now,
      release,
    });

    const latestVer = String(release.tag_name || '').replace(/^v/i, '');
    const hasUpdate = compareSemver(latestVer, currentVersion) > 0;

    return {
      ok: true,
      hasUpdate,
      currentVersion,
      latestVersion: latestVer,
      tagName: release.tag_name,
      releaseUrl: release.html_url || `https://github.com/${REPOS[0]}/releases`,
      releaseNotes: release.body || '',
      publishedAt: release.published_at || '',
      fromCache: false,
    };
  }
}

module.exports = {
  UpdateChecker,
  compareSemver,
};
