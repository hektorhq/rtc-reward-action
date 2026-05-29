#!/usr/bin/env node
/**
 * RTC Reward on Merge — GitHub Action
 * Awards RTC tokens to a PR author when their PR is merged.
 *
 * Runs on Node.js 20 using only built-in modules (no npm install needed).
 * Entry point for `runs: using: node20 / main: dist/index.js`.
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── Helpers ────────────────────────────────────────────────────────────────

function getInput(name, required = false) {
  const key = `INPUT_${name.toUpperCase().replace(/-/g, '_')}`;
  const val = (process.env[key] || '').trim();
  if (required && !val) {
    setFailed(`Input '${name}' is required but was not provided.`);
    process.exit(1);
  }
  return val;
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) {
    fs.appendFileSync(file, `${name}=${value}\n`);
  } else {
    console.log(`::set-output name=${name}::${value}`);
  }
}

function info(msg) { console.log(msg); }
function warning(msg) { console.log(`::warning::${msg}`); }
function setFailed(msg) { console.log(`::error::${msg}`); process.exitCode = 1; }

/**
 * Minimal HTTPS POST/GET helper using Node built-ins.
 * Returns { status, body } where body is parsed JSON (or raw string).
 */
function httpRequest(urlStr, options = {}, payload = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const reqOpts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method || (payload ? 'POST' : 'GET'),
      headers: options.headers || {},
      rejectUnauthorized: false, // RustChain nodes may use self-signed certs
      timeout: 20000,
    };

    if (payload) {
      const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
      reqOpts.headers['Content-Type'] = 'application/json';
      reqOpts.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const proto = url.protocol === 'https:' ? https : require('http');
    const req = proto.request(reqOpts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });

    req.on('timeout', () => { req.destroy(new Error('Request timed out after 20 s')); });
    req.on('error', reject);

    if (payload) {
      const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
      req.write(body);
    }
    req.end();
  });
}

// ─── Wallet resolution ───────────────────────────────────────────────────────

/**
 * Try to extract a wallet name / address from the PR body.
 * Matches lines like:
 *   RTC Wallet: my_wallet
 *   RTC Wallet: RTC4f799b…
 */
function extractWalletFromBody(body, fieldLabel) {
  if (!body) return null;
  const escaped = fieldLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`${escaped}\\s*([\\w.-]+)`, 'i');
  const match = body.match(regex);
  return match ? match[1].trim() : null;
}

/**
 * Try to read a `.rtc-wallet` file from the workspace root.
 */
function extractWalletFromFile() {
  const workspace = process.env.GITHUB_WORKSPACE || '.';
  const filePath = path.join(workspace, '.rtc-wallet');
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (content) return content;
    }
  } catch { /* ignore */ }
  return null;
}

// ─── RustChain transfer ──────────────────────────────────────────────────────

/**
 * Send RTC via the RustChain node.
 * Tries multiple endpoint paths to handle different node versions.
 */
async function sendRTC({ nodeUrl, walletFrom, walletTo, amount, adminKey }) {
  const endpoints = [
    '/api/transfer',
    '/wallet/send',
    '/api/wallet/send',
    '/transfer',
  ];

  const payload = {
    from: walletFrom,
    to: walletTo,
    amount: parseFloat(amount),
    admin_key: adminKey,
    // Some nodes use alternative field names:
    wallet_from: walletFrom,
    wallet_to: walletTo,
    api_key: adminKey,
  };

  let lastError = null;
  for (const ep of endpoints) {
    try {
      const url = nodeUrl.replace(/\/$/, '') + ep;
      info(`Trying endpoint: ${url}`);
      const res = await httpRequest(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminKey}` },
      }, payload);

      info(`Response ${res.status}: ${JSON.stringify(res.body)}`);

      if (res.status >= 200 && res.status < 300) {
        const body = res.body;
        const txId =
          body?.tx_id || body?.txid || body?.transaction_id ||
          body?.id || body?.hash || `simulated-${Date.now()}`;
        return { success: true, txId: String(txId) };
      }

      if (res.status === 404) continue; // try next endpoint
      lastError = `Node returned HTTP ${res.status}: ${JSON.stringify(res.body)}`;
    } catch (err) {
      lastError = err.message;
      info(`Endpoint ${ep} failed: ${err.message}`);
    }
  }

  return { success: false, error: lastError || 'All endpoints failed' };
}

// ─── GitHub comment ──────────────────────────────────────────────────────────

async function postComment({ githubToken, owner, repo, prNumber, body }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`;
  const res = await httpRequest(url, {
    method: 'POST',
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'rtc-reward-action/1.0',
    },
  }, { body });

  if (res.status !== 201) {
    warning(`Could not post PR comment (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  // Read inputs
  const nodeUrl     = getInput('node-url', true);
  const amount      = getInput('amount') || '5';
  const walletFrom  = getInput('wallet-from', true);
  const adminKey    = getInput('admin-key', true);
  const walletToOverride = getInput('wallet-to');
  const walletField = getInput('wallet-field') || 'RTC Wallet:';
  const dryRun      = getInput('dry-run') === 'true';
  const githubToken = getInput('github-token');

  // Parse GitHub context
  let context;
  try {
    const ctxPath = process.env.GITHUB_EVENT_PATH;
    context = ctxPath ? JSON.parse(fs.readFileSync(ctxPath, 'utf8')) : {};
  } catch {
    context = {};
  }

  const pr        = context.pull_request || {};
  const prNumber  = pr.number;
  const prBody    = pr.body || '';
  const prAuthor  = pr.user?.login || 'unknown';
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '/').split('/');

  info(`PR #${prNumber} by @${prAuthor} merged into ${owner}/${repo}`);

  // Resolve recipient wallet
  let walletTo = walletToOverride;

  if (!walletTo) {
    walletTo = extractWalletFromBody(prBody, walletField);
    if (walletTo) {
      info(`Wallet found in PR body: ${walletTo}`);
    }
  }

  if (!walletTo) {
    walletTo = extractWalletFromFile();
    if (walletTo) {
      info(`Wallet found in .rtc-wallet file: ${walletTo}`);
    }
  }

  if (!walletTo) {
    walletTo = prAuthor;
    warning(`No wallet found — falling back to GitHub username: ${prAuthor}`);
  }

  info(`Rewarding ${amount} RTC from '${walletFrom}' to '${walletTo}'${dryRun ? ' [DRY RUN]' : ''}`);

  // Set outputs early (dry-run path)
  setOutput('wallet-to', walletTo);
  setOutput('amount', amount);

  if (dryRun) {
    info(`[DRY RUN] Would send ${amount} RTC to ${walletTo}. No tokens transferred.`);
    setOutput('tx-id', 'dry-run');

    if (githubToken && prNumber) {
      await postComment({
        githubToken, owner, repo, prNumber,
        body: [
          `> [DRY RUN] RTC Reward Simulation`,
          ``,
          `This is a dry run. No tokens were actually transferred.`,
          ``,
          `| Field | Value |`,
          `|---|---|`,
          `| Recipient | \`${walletTo}\` |`,
          `| Amount | \`${amount} RTC\` |`,
          `| From | \`${walletFrom}\` |`,
          `| Mode | Dry Run |`,
        ].join('\n'),
      });
    }
    return;
  }

  // Execute transfer
  const result = await sendRTC({ nodeUrl, walletFrom, walletTo, amount, adminKey });

  if (!result.success) {
    setFailed(`RTC transfer failed: ${result.error}`);
    return;
  }

  setOutput('tx-id', result.txId);
  info(`Transfer successful! TX ID: ${result.txId}`);

  // Post PR comment
  if (githubToken && prNumber) {
    await postComment({
      githubToken, owner, repo, prNumber,
      body: [
        `## You earned ${amount} RTC for this contribution!`,
        ``,
        `| Field | Value |`,
        `|---|---|`,
        `| Recipient wallet | \`${walletTo}\` |`,
        `| Amount | \`${amount} RTC\` |`,
        `| Transaction ID | \`${result.txId}\` |`,
        ``,
        `_Powered by [rtc-reward-action](https://github.com/hektorhq/rtc-reward-action)_`,
      ].join('\n'),
    });
  }
}

run().catch((err) => {
  setFailed(`Unhandled error: ${err.message}`);
  process.exit(1);
});
