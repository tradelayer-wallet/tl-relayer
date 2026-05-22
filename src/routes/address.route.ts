import { FastifyInstance, FastifyRequest } from "fastify";
import { fundAddress, getAddressBalance, importWatchOnlyAccounts, validateAddress } from "../services/address.service";
import { listunspent, rescanWatchOnlyAccounts } from "../services/sochain.service"; // Import the new function
import {
    bootstrapWatchOnlyRegistryFromSeed,
    getWatchOnlyCoverage,
    getWatchOnlyRegistrySummary,
    listWatchOnlyEntries,
    markWatchOnlyScanCoverage,
    recordWatchOnlySnapshot,
} from "../services/watchonly-registry.service";

export const addressRoute = (fastify: FastifyInstance, opts: any, done: any) => {
    fastify.get('/validate/:address', async (request: FastifyRequest<{ Params: { address: string } }>, reply) => {
        try {
            const { address } = request.params;
            const res = await validateAddress(address);
            reply.send(res);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
            reply.status(500).send({ error: errorMessage });
        }
    });

    fastify.get('/balance/:address', async (request: FastifyRequest<{ Params: { address: string } }>, reply) => {
        try {
            const { address } = request.params;
            const res = await getAddressBalance(address);
            reply.send(res);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
            reply.status(500).send({ error: errorMessage });
        }
    });

    fastify.get('/faucet/:address', async (request: FastifyRequest<{ Params: { address: string } }>, reply) => {
        try {
            const { address } = request.params;
            const res = await fundAddress(address);
            reply.send(res);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
            reply.status(500).send({ error: errorMessage });
        }
    });

    fastify.post(
        '/sync-watchonly',
        async (
            request: FastifyRequest<{
                Body: { accounts?: Array<{ address?: string; pubkey?: string }> };
            }>,
            reply
        ) => {
            try {
                const accounts = Array.isArray(request.body?.accounts)
                    ? request.body.accounts
                    : [];
                const res = await importWatchOnlyAccounts(
                    fastify,
                    accounts.map((account) => ({
                        address: String(account?.address || '').trim(),
                        pubkey: String(account?.pubkey || '').trim(),
                    }))
                );

                if (res.error) {
                    reply.status(400).send({ error: res.error });
                } else {
                    reply.send(res.data);
                }
            } catch (error: unknown) {
                const errorMessage =
                    error instanceof Error ? error.message : "An unexpected error occurred";
                reply.status(500).send({ error: errorMessage });
            }
        }
    );

    fastify.get(
        '/watchonly',
        async (
            request: FastifyRequest<{
                Querystring: { network?: string; address?: string };
            }>,
            reply
        ) => {
            try {
                const { network, address } = request.query || {};
                const entries = await listWatchOnlyEntries({ network, address });
                reply.send({
                    ok: true,
                    summary: getWatchOnlyRegistrySummary(),
                    entries,
                });
            } catch (error: unknown) {
                const errorMessage =
                    error instanceof Error ? error.message : "An unexpected error occurred";
                reply.status(500).send({ error: errorMessage });
            }
        }
    );

    fastify.get(
        '/watchonly/:address',
        async (
            request: FastifyRequest<{
                Params: { address: string };
                Querystring: { network?: string };
            }>,
            reply
        ) => {
            try {
                const { address } = request.params;
                const { network } = request.query || {};
                const entries = await listWatchOnlyEntries({ network, address });
                reply.send({
                    ok: true,
                    entries,
                    entry: entries[0] || null,
                });
            } catch (error: unknown) {
                const errorMessage =
                    error instanceof Error ? error.message : "An unexpected error occurred";
                reply.status(500).send({ error: errorMessage });
            }
        }
    );

    fastify.get(
        '/watchonly/:address/scan',
        async (
            request: FastifyRequest<{
                Params: { address: string };
            }>,
            reply
        ) => {
            try {
                const { address } = request.params;
                const coverage = await getWatchOnlyCoverage(address);
                reply.send({
                    ok: true,
                    coverage,
                });
            } catch (error: unknown) {
                const errorMessage =
                    error instanceof Error ? error.message : "An unexpected error occurred";
                reply.status(500).send({ error: errorMessage });
            }
        }
    );

    fastify.post(
        '/watchonly/bootstrap',
        async (
            request: FastifyRequest<{
                Body: {
                    sourceUrl?: string;
                    network?: string;
                    force?: boolean;
                };
            }>,
            reply
        ) => {
            try {
                const body = request.body || {};
                const res = await bootstrapWatchOnlyRegistryFromSeed({
                    sourceUrl: body.sourceUrl,
                    network: body.network,
                    force: !!body.force,
                });

                reply.send({ ok: true, ...res });
            } catch (error: unknown) {
                const errorMessage =
                    error instanceof Error ? error.message : "An unexpected error occurred";
                reply.status(500).send({ error: errorMessage });
            }
        }
    );

    fastify.post(
        '/watchonly/scan/run',
        async (
            request: FastifyRequest<{
                Body: {
                    network?: string;
                    address?: string;
                    fromHeight?: number | null;
                    toHeight?: number | null;
                    scanSourceNodeId?: string | null;
                    force?: boolean;
                };
            }>,
            reply
        ) => {
            try {
                const body = request.body || {};
                const res = await rescanWatchOnlyAccounts(fastify, {
                    network: body.network,
                    address: body.address,
                    fromHeight: body.fromHeight ?? null,
                    toHeight: body.toHeight ?? null,
                    scanSourceNodeId: body.scanSourceNodeId ?? null,
                    force: !!body.force,
                });

                if (res.error) {
                    reply.status(400).send({ error: res.error });
                } else {
                    reply.send(res.data);
                }
            } catch (error: unknown) {
                const errorMessage =
                    error instanceof Error ? error.message : "An unexpected error occurred";
                reply.status(500).send({ error: errorMessage });
            }
        }
    );

    fastify.post(
        '/watchonly/snapshot',
        async (
            request: FastifyRequest<{
                Body: {
                    network?: string;
                    address?: string;
                    pubkey?: string;
                    utxos?: any[];
                };
            }>,
            reply
        ) => {
            try {
                const body = request.body || {};
                if (!body.address) {
                    reply.status(400).send({ error: 'Missing address' });
                    return;
                }
                const snapshot = recordWatchOnlySnapshot({
                    network: body.network,
                    address: body.address,
                    pubkey: body.pubkey,
                    utxos: Array.isArray(body.utxos) ? body.utxos : [],
                });

                if (!snapshot) {
                    reply.status(400).send({ error: 'Missing pubkey or no snapshot data' });
                    return;
                }

                reply.send({ ok: true, entry: snapshot });
            } catch (error: unknown) {
                const errorMessage =
                    error instanceof Error ? error.message : "An unexpected error occurred";
                reply.status(500).send({ error: errorMessage });
            }
        }
    );

    fastify.post(
        '/watchonly/scan',
        async (
            request: FastifyRequest<{
                Body: {
                    network?: string;
                    address?: string;
                    pubkey?: string;
                    scannedHeight?: number | null;
                    scanSourceNodeId?: string | null;
                    scanState?: 'new' | 'imported' | 'backfilled' | 'live' | 'stale';
                };
            }>,
            reply
        ) => {
            try {
                const body = request.body || {};
                if (!body.address) {
                    reply.status(400).send({ error: 'Missing address' });
                    return;
                }
                const res = await markWatchOnlyScanCoverage({
                    network: body.network,
                    address: body.address,
                    pubkey: body.pubkey,
                    scannedHeight: body.scannedHeight ?? null,
                    scanSourceNodeId: body.scanSourceNodeId ?? null,
                    scanState: body.scanState,
                });
                reply.send({ ok: true, entry: res });
            } catch (error: unknown) {
                const errorMessage =
                    error instanceof Error ? error.message : "An unexpected error occurred";
                reply.status(500).send({ error: errorMessage });
            }
        }
    );

    fastify.post(
        '/utxo/:address',
        async (
            request: FastifyRequest<{
                Params: { address: string };
                Body: { pubkey?: string };
            }>,
            reply
        ) => {
            try {
                const { address } = request.params;
                const body = request.body || {};
                const pubkey = body.pubkey;
                const minBlock = 1;
                const maxBlock = 99999999;

                const res = await listunspent(fastify, [
                    minBlock,
                    maxBlock,
                    { address, pubkey },
                ]);

                if (res.error) {
                    reply.status(400).send({ error: res.error });
                } else {
                    reply.send(res.data);
                }
            } catch (error: unknown) {
                const errorMessage =
                    error instanceof Error ? error.message : "An unexpected error occurred";
                reply.status(500).send({ error: errorMessage });
            }
        }
    );

    done();
};
