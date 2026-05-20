import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { envConfig } from '../config/env.config';

export type WatchOnlyRegistrySnapshotUtxo = {
  txid: string;
  vout: number;
  amount: number;
  confirmations: number;
  scriptPubKey?: string;
};

export type WatchOnlyRegistryEntry = {
  network: string;
  address: string;
  pubkey: string;
  createdAt: number;
  lastSeenAt: number;
  lastImportedAt: number | null;
  lastImportAttemptAt: number | null;
  lastImportError: string | null;
  importCount: number;
  lastUtxoSnapshot: {
    hash: string;
    count: number;
    totalAmount: number;
    updatedAt: number;
    utxos: WatchOnlyRegistrySnapshotUtxo[];
  } | null;
};

type WatchOnlyRegistryFile = {
  version: number;
  updatedAt: number;
  entries: WatchOnlyRegistryEntry[];
};

const REGISTRY_VERSION = 1;

function normalize(value: string): string {
  return String(value || '').trim();
}

function normalizeNetwork(network?: string): string {
  return normalize(network || envConfig.NETWORK || 'unknown').toLowerCase();
}

function getStateDir(): string {
  return normalize(process.env.TL_RELAYER_STATE_DIR || process.env.RELAYER_STATE_DIR || join(process.cwd(), 'state'));
}

function getRegistryPath(): string {
  return normalize(process.env.TL_WATCHONLY_REGISTRY_PATH || join(getStateDir(), 'watchonly-registry.json'));
}

function ensureRegistryDir() {
  const registryPath = getRegistryPath();
  const registryDir = dirname(registryPath);
  if (!existsSync(registryDir)) {
    mkdirSync(registryDir, { recursive: true });
  }
}

function emptyRegistry(): WatchOnlyRegistryFile {
  return {
    version: REGISTRY_VERSION,
    updatedAt: Date.now(),
    entries: [],
  };
}

function readRegistry(): WatchOnlyRegistryFile {
  try {
    const registryPath = getRegistryPath();
    if (!existsSync(registryPath)) {
      return emptyRegistry();
    }
    const raw = JSON.parse(readFileSync(registryPath, 'utf8'));
    const entries = Array.isArray(raw?.entries) ? raw.entries : [];
    return {
      version: Number(raw?.version || REGISTRY_VERSION),
      updatedAt: Number(raw?.updatedAt || Date.now()),
      entries: entries
        .map((entry: any) => normalizeEntry(entry))
        .filter(Boolean) as WatchOnlyRegistryEntry[],
    };
  } catch {
    return emptyRegistry();
  }
}

function writeRegistry(registry: WatchOnlyRegistryFile) {
  ensureRegistryDir();
  writeFileSync(getRegistryPath(), `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

function normalizeEntry(entry: any): WatchOnlyRegistryEntry | null {
  const network = normalizeNetwork(entry?.network);
  const address = normalize(entry?.address);
  const pubkey = normalize(entry?.pubkey);
  if (!address || !pubkey) {
    return null;
  }

  const snapshot = entry?.lastUtxoSnapshot;
  const lastUtxoSnapshot = snapshot && typeof snapshot === 'object'
    ? {
        hash: normalize(snapshot.hash),
        count: Number(snapshot.count || 0),
        totalAmount: Number(snapshot.totalAmount || 0),
        updatedAt: Number(snapshot.updatedAt || Date.now()),
        utxos: Array.isArray(snapshot.utxos)
          ? snapshot.utxos.map(normalizeUtxo).filter(Boolean) as WatchOnlyRegistrySnapshotUtxo[]
          : [],
      }
    : null;

  return {
    network,
    address,
    pubkey,
    createdAt: Number(entry?.createdAt || Date.now()),
    lastSeenAt: Number(entry?.lastSeenAt || Date.now()),
    lastImportedAt: entry?.lastImportedAt == null ? null : Number(entry.lastImportedAt),
    lastImportAttemptAt: entry?.lastImportAttemptAt == null ? null : Number(entry.lastImportAttemptAt),
    lastImportError: entry?.lastImportError == null ? null : String(entry.lastImportError),
    importCount: Number(entry?.importCount || 0),
    lastUtxoSnapshot,
  };
}

function normalizeUtxo(utxo: any): WatchOnlyRegistrySnapshotUtxo | null {
  if (!utxo || typeof utxo !== 'object') {
    return null;
  }
  const txid = normalize(utxo.txid);
  const vout = Number(utxo.vout);
  if (!txid || !Number.isInteger(vout)) {
    return null;
  }
  return {
    txid,
    vout,
    amount: Number(utxo.amount || 0),
    confirmations: Number(utxo.confirmations || 0),
    scriptPubKey: utxo.scriptPubKey == null ? undefined : String(utxo.scriptPubKey),
  };
}

function entryKey(network: string, address: string): string {
  return `${normalizeNetwork(network)}::${normalize(address).toLowerCase()}`;
}

function findEntryIndex(registry: WatchOnlyRegistryFile, network: string, address: string): number {
  const key = entryKey(network, address);
  return registry.entries.findIndex((entry) => entryKey(entry.network, entry.address) === key);
}

function computeSnapshotHash(utxos: WatchOnlyRegistrySnapshotUtxo[]): string {
  const canonical = utxos
    .slice()
    .sort((left, right) => {
      if (left.txid === right.txid) {
        return left.vout - right.vout;
      }
      return left.txid.localeCompare(right.txid);
    });

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function upsertWatchOnlyEntry(input: {
  network?: string;
  address: string;
  pubkey: string;
  imported?: boolean;
  importError?: string | null;
}) {
  const registry = readRegistry();
  const network = normalizeNetwork(input.network);
  const address = normalize(input.address);
  const pubkey = normalize(input.pubkey);
  if (!address || !pubkey) {
    return null;
  }

  const now = Date.now();
  const idx = findEntryIndex(registry, network, address);
  const existing = idx >= 0 ? registry.entries[idx] : null;
  const nextEntry: WatchOnlyRegistryEntry = {
    network,
    address,
    pubkey,
    createdAt: existing?.createdAt || now,
    lastSeenAt: now,
    lastImportedAt: input.imported ? now : (existing?.lastImportedAt ?? null),
    lastImportAttemptAt: now,
    lastImportError: input.importError == null ? (existing?.lastImportError ?? null) : String(input.importError),
    importCount: (existing?.importCount || 0) + (input.imported ? 1 : 0),
    lastUtxoSnapshot: existing?.lastUtxoSnapshot || null,
  };

  if (idx >= 0) {
    registry.entries[idx] = nextEntry;
  } else {
    registry.entries.push(nextEntry);
  }

  registry.updatedAt = now;
  writeRegistry(registry);
  return nextEntry;
}

export function markWatchOnlyImportOutcome(input: {
  network?: string;
  address: string;
  pubkey: string;
  success: boolean;
  error?: string | null;
}) {
  return upsertWatchOnlyEntry({
    network: input.network,
    address: input.address,
    pubkey: input.pubkey,
    imported: input.success,
    importError: input.success ? null : (input.error || 'Import failed'),
  });
}

export function recordWatchOnlySnapshot(input: {
  network?: string;
  address: string;
  pubkey?: string;
  utxos: any[];
}) {
  const registry = readRegistry();
  const network = normalizeNetwork(input.network);
  const address = normalize(input.address);
  const utxos = (Array.isArray(input.utxos) ? input.utxos : [])
    .map(normalizeUtxo)
    .filter(Boolean) as WatchOnlyRegistrySnapshotUtxo[];
  const snapshotHash = computeSnapshotHash(utxos);
  const totalAmount = utxos.reduce((sum, utxo) => sum + Number(utxo.amount || 0), 0);
  const now = Date.now();
  const idx = findEntryIndex(registry, network, address);
  const existing = idx >= 0 ? registry.entries[idx] : null;
  const pubkey = normalize(input.pubkey || existing?.pubkey || '');

  if (!address || !pubkey) {
    return null;
  }

  const nextEntry: WatchOnlyRegistryEntry = {
    network,
    address,
    pubkey,
    createdAt: existing?.createdAt || now,
    lastSeenAt: now,
    lastImportedAt: existing?.lastImportedAt ?? null,
    lastImportAttemptAt: existing?.lastImportAttemptAt ?? null,
    lastImportError: existing?.lastImportError ?? null,
    importCount: existing?.importCount || 0,
    lastUtxoSnapshot: {
      hash: snapshotHash,
      count: utxos.length,
      totalAmount,
      updatedAt: now,
      utxos,
    },
  };

  if (idx >= 0) {
    registry.entries[idx] = nextEntry;
  } else {
    registry.entries.push(nextEntry);
  }

  registry.updatedAt = now;
  writeRegistry(registry);
  return nextEntry;
}

export function resolveWatchOnlyPubkey(input: { network?: string; address: string }): string | null {
  const registry = readRegistry();
  const network = normalizeNetwork(input.network);
  const address = normalize(input.address);
  if (!address) {
    return null;
  }

  const match = registry.entries.find((entry) => entryKey(entry.network, entry.address) === entryKey(network, address));
  return match?.pubkey || null;
}

export function listWatchOnlyEntries(input?: { network?: string; address?: string }) {
  const registry = readRegistry();
  const network = input?.network ? normalizeNetwork(input.network) : null;
  const address = input?.address ? normalize(input.address) : null;

  return registry.entries
    .filter((entry) => {
      if (network && entry.network !== network) {
        return false;
      }
      if (address && entry.address !== address) {
        return false;
      }
      return true;
    })
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt);
}

export function getWatchOnlyRegistrySummary() {
  const registry = readRegistry();
  return {
    version: REGISTRY_VERSION,
    updatedAt: registry.updatedAt,
    entryCount: registry.entries.length,
    entries: registry.entries.slice().sort((left, right) => right.lastSeenAt - left.lastSeenAt),
  };
}
