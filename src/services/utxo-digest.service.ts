import { createHash } from 'crypto';

export interface DigestUtxo {
    txid: string;
    vout: number;
    amount: number;
}

/**
 * Digest of one address's UTXO set, used to compare the local snapshot with the external
 * explorer view. Only the outpoint and the value take part: confirmations move with every
 * block, and ids and scripts differ between the RPC and explorer views. Values are hashed as
 * integer satoshis, so the result does not depend on list order or on float summation.
 */
export const utxoSetDigest = (utxos: DigestUtxo[]): { digest: string; count: number; totalSats: number } => {
    const rows = utxos
        .map((utxo) => ({ txid: utxo.txid, vout: utxo.vout, sats: Math.round(Number(utxo.amount || 0) * 1e8) }))
        .sort((a, b) => {
            if (a.txid !== b.txid) return a.txid < b.txid ? -1 : 1;
            return a.vout - b.vout;
        });
    const totalSats = rows.reduce((sum, row) => sum + row.sats, 0);
    return {
        digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
        count: rows.length,
        totalSats,
    };
};
