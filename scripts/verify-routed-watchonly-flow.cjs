#!/usr/bin/env node

const http = require('http');
const https = require('https');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) continue;
    const key = current.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function requestJson(urlValue, method, body) {
  const url = new URL(urlValue);
  const payload = body === undefined ? null : JSON.stringify(body);
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const request = client.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      timeout: 20000,
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      } : undefined,
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (error) {
          const parseError = new Error(`Invalid JSON response from ${method} ${url.pathname}: ${error.message}`);
          parseError.statusCode = response.statusCode;
          parseError.body = text;
          reject(parseError);
          return;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          const requestError = new Error(
            typeof data?.error === 'string'
              ? data.error
              : `HTTP ${response.statusCode} from ${method} ${url.pathname}`,
          );
          requestError.statusCode = response.statusCode;
          requestError.body = data;
          reject(requestError);
          return;
        }
        resolve(data);
      });
    });

    request.on('timeout', () => request.destroy(new Error(`Timed out after 20000ms: ${method} ${url.pathname}`)));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function matchingServices(registry, service, network) {
  const providers = Array.isArray(registry?.providers) ? registry.providers : [];
  const matches = [];
  for (const provider of providers) {
    const services = Array.isArray(provider?.services)
      ? provider.services
      : provider?.service ? [provider] : [];
    for (const entry of services) {
      if (entry?.service === service && entry?.network === network) {
        matches.push({
          nodeId: provider?.nodeId || null,
          methods: Array.isArray(entry?.methods) ? entry.methods : [],
        });
      }
    }
  }
  return matches;
}

function errorSummary(error) {
  return {
    message: String(error?.message || error),
    statusCode: Number.isFinite(Number(error?.statusCode)) ? Number(error.statusCode) : null,
    body: error?.body || null,
  };
}

function fail(report, code, error) {
  report.errors.push({ code, ...errorSummary(error) });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const address = String(args.address || process.env.WATCHONLY_TEST_ADDRESS || '').trim();
  const pubkey = String(args.pubkey || process.env.WATCHONLY_TEST_PUBKEY || '').trim().toLowerCase();
  const collatorUrl = trimSlash(args['collator-url'] || process.env.TL_COLLATOR_URL || '');
  const relayerUrl = trimSlash(args['relayer-url'] || process.env.TL_RELAYER_URL || process.env.RELAYER_URL || '');
  const service = String(args.service || process.env.TL_COLLATOR_RPC_SERVICE || 'tradelayer.rpc').trim();
  const network = String(args.network || process.env.TL_COLLATOR_RPC_NETWORK || 'litecoin.testnet').trim();
  const expectedMinUtxos = Math.max(0, Number(args['expect-min-utxos'] || 0) || 0);

  if (!address || !pubkey || !collatorUrl || !relayerUrl) {
    throw new Error(
      'Usage: node scripts/verify-routed-watchonly-flow.cjs --collator-url <url> --relayer-url <url> --address <address> --pubkey <compressed-hex> [--network litecoin.testnet] [--expect-min-utxos 1]',
    );
  }
  if (!/^(02|03)[0-9a-f]{64}$/.test(pubkey)) {
    throw new Error('pubkey must be a compressed public key encoded as 66 lowercase hexadecimal characters');
  }

  const report = {
    checkedAt: new Date().toISOString(),
    collatorUrl,
    relayerUrl,
    service,
    network,
    address,
    provider: null,
    sync: null,
    balance: null,
    utxos: null,
    registry: null,
    errors: [],
  };

  let providers = [];
  try {
    const health = await requestJson(`${collatorUrl}/health`, 'GET');
    report.collatorHealth = health;
    if (!health?.ok) fail(report, 'COLLATOR_HEALTH_FAILED', new Error('collator health response was not ok'));
  } catch (error) {
    fail(report, 'COLLATOR_HEALTH_FAILED', error);
  }

  try {
    const registry = await requestJson(`${collatorUrl}/rpc/providers`, 'GET');
    providers = matchingServices(registry, service, network);
    const requiredMethods = ['tl_watchonly_register', 'tl_watchonly_utxos', 'tl_getAllBalancesForAddress'];
    const methods = new Set(providers.flatMap((provider) => provider.methods));
    const missingMethods = requiredMethods.filter((method) => !methods.has(method));
    report.provider = {
      count: providers.length,
      nodeIds: providers.map((provider) => provider.nodeId).filter(Boolean),
      missingMethods,
    };
    if (!providers.length) fail(report, 'NO_SCOPED_PROVIDER', new Error(`No ${service} provider for ${network}`));
    if (missingMethods.length) fail(report, 'PROVIDER_CAPABILITY_GAP', new Error(`Missing advertised methods: ${missingMethods.join(', ')}`));
  } catch (error) {
    fail(report, 'PROVIDER_REGISTRY_FAILED', error);
  }

  try {
    report.sync = await requestJson(`${relayerUrl}/address/sync-watchonly`, 'POST', {
      network,
      accounts: [{ address, pubkey }],
    });
  } catch (error) {
    fail(report, error?.statusCode === 404 ? 'SCOPED_SYNC_ROUTE_MISSING' : 'WATCHONLY_SYNC_FAILED', error);
  }

  try {
    report.balance = await requestJson(`${relayerUrl}/address/balance/${encodeURIComponent(address)}`, 'GET');
  } catch (error) {
    fail(report, 'TOKEN_BALANCE_FAILED', error);
  }

  try {
    const utxos = await requestJson(`${relayerUrl}/address/utxo/${encodeURIComponent(address)}`, 'POST', { pubkey, network });
    const normalized = Array.isArray(utxos) ? utxos : [];
    const invalid = normalized.filter((utxo) => !utxo || !utxo.txid || !Number.isFinite(Number(utxo.vout)) || !Number.isFinite(Number(utxo.amount)));
    report.utxos = { count: normalized.length, items: normalized };
    if (invalid.length) fail(report, 'INVALID_UTXO_SHAPE', new Error(`${invalid.length} UTXO entries are missing txid, vout, or amount`));
    if (normalized.length < expectedMinUtxos) fail(report, 'UTXO_COUNT_BELOW_EXPECTATION', new Error(`Expected at least ${expectedMinUtxos} UTXO(s), received ${normalized.length}`));
  } catch (error) {
    fail(report, 'WATCHONLY_UTXO_FAILED', error);
  }

  try {
    const registry = await requestJson(`${relayerUrl}/address/watchonly/${encodeURIComponent(address)}?network=${encodeURIComponent(network)}`, 'GET');
    const entry = registry?.entry || null;
    const snapshot = entry?.lastUtxoSnapshot || null;
    report.registry = {
      entryFound: !!entry,
      scanSourceNodeId: snapshot?.scanSourceNodeId || entry?.scanSourceNodeId || null,
      scannedHeight: snapshot?.scannedHeight ?? entry?.lastSnapshotHeight ?? null,
      snapshotCount: snapshot?.count ?? null,
    };
    if (!entry || !snapshot?.scanSourceNodeId || !Number.isFinite(Number(snapshot?.scannedHeight))) {
      fail(report, 'WATCHONLY_PROVENANCE_MISSING', new Error('Registry did not retain a provider node ID and scanned height'));
    }
  } catch (error) {
    fail(report, error?.statusCode === 404 ? 'WATCHONLY_REGISTRY_ROUTE_MISSING' : 'WATCHONLY_REGISTRY_FAILED', error);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.errors.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  process.exitCode = 1;
});
