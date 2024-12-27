import * as bitcoin from 'bitcoinjs-lib';
import axios from 'axios';
import { rpcClient } from "../config/rpc.config";  // Your configured RPC client

/********************************************************************
 * Type Definitions (adjust as needed in your environment)
 ********************************************************************/
export interface IInput {
  txid: string;
  amount: number;
  confirmations: number;
  scriptPubKey: string;
  vout: number;
  redeemScript?: string;
  pubkey?: string;
};

import { Network } from 'bitcoinjs-lib';

export const networks: Record<string, Network> = {
  LTC: {
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bip32: {
      public: 0x019da462,
      private: 0x019d9cfe,
    },
    pubKeyHash: 0x30,
    scriptHash: 0x32,
    wif: 0xb0,
    bech32: 'ltc', // Add this
  },
  LTCTEST: {
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bip32: {
      public: 0x043587cf,
      private: 0x04358394,
    },
    pubKeyHash: 0x6f,
    scriptHash: 0x3a,
    wif: 0xef,
    bech32: 'tltc', // Add this
  },
};

export interface IBuildTxConfig {
  fromKeyPair: {
    address: string;
    pubkey?: string;
  };
  toKeyPair: {
    address: string;
    pubkey?: string;
  };
  amount?: number;
  payload?: string;
  inputs?: IInput[];
  addPsbt?: boolean;
  network?: string;
};

export interface IBuildLTCITTxConfig {
  buyerKeyPair: {
    address: string;
    pubkey?: string;
  };
  sellerKeyPair: {
    address: string;
    pubkey?: string;
  };
  amount: number;
  payload: string;
  commitUTXOs: IInput[],
  network: string;
}

export interface ApiRes {
  data?: any;
  error?: string;
}

export type TClient = (method: string, ...args: any[]) => Promise<ApiRes>;

/********************************************************************
 * Example: Smart RPC calls and local "TL" calls
 ********************************************************************/

const networkMap: Record<string, bitcoin.Network> = {
  LTC: networks.LTC,
  LTCTEST: networks.LTCTEST,
};

// Note: If you have a global fastifyServer instance, you can adapt this.
const relayerApiUrl = process.env.RELAYER_API_URL || null;

/**
 * Generic function for making RPC calls. 
 * If `relayerApiUrl` is set, we can optionally route through an API.
 */
export const smartRpc: TClient = async (
  method: string,
  params: any[] = [],
  api = false
) => {
  if (rpcClient && !api) {
    return await rpcClient.call(method, ...params);
  } else {
    if (relayerApiUrl) {
      const url = `${relayerApiUrl}/rpc/${method}`;
      return axios.post(url, { params }).then((res) => res.data);
    } else {
      return { error: `Relayer API url not found` };
    }
  }
};

/**
 * Example: local Express/Node service for Omni/LTC/BTC calls, if any
 */
export const jsTlApi: TClient = async (method: string, params: any[] = []) => {
  const url = `http://localhost:3000/${method}`;
  return axios.post(url, { params }).then((res) => res.data);
};

/********************************************************************
 * Helpers
 ********************************************************************/
const minFeeLtcPerKb = 0.0001;

/** Safe number helper, to avoid float issues. Customize as needed. */
export const safeNumber = (value: number, decimals = 8): number => {
  return parseFloat(value.toFixed(decimals));
};

/**
 * Gathers enough UTXOs for a target amount. A simplistic approach:
 */
const getEnoughInputs2 = (_inputs: IInput[], amount: number) => {
  const finalInputs: IInput[] = [];
  _inputs.forEach((u) => {
    const currentSum = finalInputs.reduce((a, b) => a + b.amount, 0);
    const needed = safeNumber(amount + ((0.2 * minFeeLtcPerKb) * (finalInputs.length + 1)));
    if (currentSum < needed) {
      finalInputs.push(u);
    }
  });
  const fee = safeNumber((0.2 * minFeeLtcPerKb) * finalInputs.length);
  return { finalInputs, fee };
};

/********************************************************************
 * BUILD PSBT
 *
 * Basic "buildPsbt" functionality: 
 * - Takes rawTx hex
 * - Takes array of inputs (IInput[]), 
 * - Returns a PSBT hex (not signed).
 ********************************************************************/
import { Psbt, Transaction } from 'bitcoinjs-lib';

export const buildPsbt = (buildPsbtOptions: {
  rawtx: string,
  inputs: IInput[],
  network: string
}) => {
  try {
    const { rawtx, inputs, network } = buildPsbtOptions;
    const _network = networks[network];  // e.g. LTC, BTC, etc.

    const tx = Transaction.fromHex(rawtx);

    const psbt = new Psbt({ network: _network });

    inputs.forEach((input: IInput) => {
      const hash = input.txid;
      const index = input.vout;
      const value = safeNumber(input.amount * 1e8, 0);
      const script = Buffer.from(input.scriptPubKey, 'hex');
      const witnessUtxo = { script, value };

      const inputObj: any = { hash, index, witnessUtxo };

      if (input.redeemScript) {
        inputObj.witnessScript = Buffer.from(input.redeemScript, 'hex');
      }

      psbt.addInput(inputObj);
    });

    psbt.addOutputs(tx.outs);

    const psbtHex = psbt.toHex();
    return { data: psbtHex };
  } catch (error: any) {
    return { error: error.message };
  }
};

/********************************************************************
 * BUILD TX
 ********************************************************************/
export const buildTx = async (txConfig: IBuildTxConfig, isApiMode: boolean) => {
  try {
    const { fromKeyPair, toKeyPair, amount, payload, inputs, addPsbt, network } = txConfig;
    const fromAddress = fromKeyPair.address;
    const toAddress = toKeyPair.address;
    console.log('from and to address '+fromKeyPair.address+' '+toKeyPair.address)
    const vaRes1 = await smartRpc('validateaddress', [fromAddress], isApiMode);
    if (vaRes1.error || !vaRes1.data?.isvalid) {
      throw new Error(`validateaddress(from): ${vaRes1.error}`);
    }
    const vaRes2 = await smartRpc('validateaddress', [toAddress], isApiMode);
    if (vaRes2.error || !vaRes2.data?.isvalid) {
      throw new Error(`validateaddress(to): ${vaRes2.error}`);
    }

    const luRes = await smartRpc('listunspent', [0, 999999999, [fromAddress]], isApiMode);
    if (luRes.error || !luRes.data) {
      throw new Error(`listunspent(from): ${luRes.error}`);
    }

    const _utxos = (luRes.data as IInput[]).sort((a, b) => b.amount - a.amount);

    const inputsRes = getEnoughInputs2(_utxos, amount!);
    const { finalInputs, fee } = inputsRes;

    const _insForRawTx = finalInputs.map(({ txid, vout }) => ({ txid, vout }));
    const _outsForRawTx: any = { [toAddress]: safeNumber(amount! - fee) };

    if (finalInputs.length === 0) throw new Error('Not enough inputs');

    const crtRes = await smartRpc('createrawtransaction', [_insForRawTx, _outsForRawTx], isApiMode);
    if (crtRes.error || !crtRes.data) {
      throw new Error(`createrawtransaction: ${crtRes.error}`);
    }

    let rawTx = crtRes.data;

    if (payload) {
      const tx = bitcoin.Transaction.fromHex(rawTx);
      const data = Buffer.from(payload, 'utf8');
      const embed = bitcoin.payments.embed({ data: [data] });

      const psbt = new Psbt({ network: networkMap[network!] });
      tx.ins.forEach((input, index) => {
        psbt.addInput({
          hash: tx.ins[index].hash.reverse().toString('hex'),
          index: input.index,
          nonWitnessUtxo: Buffer.from(rawTx, 'hex'),
        });
      });
      tx.outs.forEach((output) => {
        psbt.addOutput(output);
      });
      psbt.addOutput({
        script: embed.output!,
        value: 0,
      });
      rawTx = psbt.finalizeAllInputs().extractTransaction().toHex();
    }

    const data: any = { rawtx: rawTx, inputs: finalInputs };

    if (addPsbt) {
      const psbtRes = buildPsbt({ rawtx: rawTx, inputs: finalInputs, network: network! });
      data.psbt = psbtRes.data;
    }

    return { data };
  } catch (error: any) {
    return { error: error.message || 'Failed to build transaction' };
  }
};
/********************************************************************
 * BUILD LTC TRADE TX
 ********************************************************************/
/********************************************************************
 * BUILD LTC TRADE TX
 ********************************************************************/
export const buildLTCTradeTx = async (txConfig: IBuildLTCITTxConfig, isApiMode: boolean) => {
  try {
    const { buyerKeyPair, sellerKeyPair, amount, payload, commitUTXOs, network } = txConfig;

    const buyerAddress = buyerKeyPair.address;
    const sellerAddress = sellerKeyPair.address;

    const luRes = await smartRpc('listunspent', [0, 999999999, [buyerAddress]], isApiMode);
    if (luRes.error || !luRes.data) {
      throw new Error(`listunspent(buyer): ${luRes.error}`);
    }

    const utxos = [...commitUTXOs, ...luRes.data];
    const inputsRes = getEnoughInputs2(utxos, amount);
    const { finalInputs, fee } = inputsRes;

    const _insForRawTx = finalInputs.map(({ txid, vout }) => ({ txid, vout }));
    const _outsForRawTx: any = {
      [sellerAddress]: safeNumber(amount - fee),
      [buyerAddress]: safeNumber(finalInputs.reduce((a, b) => a + b.amount, 0) - amount - fee),
    };

    const crtRes = await smartRpc('createrawtransaction', [_insForRawTx, _outsForRawTx], isApiMode);
    if (crtRes.error || !crtRes.data) {
      throw new Error(`createrawtransaction: ${crtRes.error}`);
    }

    let rawTx = crtRes.data;

    if (payload) {
      const tx = bitcoin.Transaction.fromHex(rawTx);
      const data = Buffer.from(payload, 'utf8');
      const embed = bitcoin.payments.embed({ data: [data] });

      const psbt = new Psbt({ network: networkMap[network] });
      tx.ins.forEach((input, index) => {
        psbt.addInput({
          hash: tx.ins[index].hash.reverse().toString('hex'),
          index: input.index,
          nonWitnessUtxo: Buffer.from(rawTx, 'hex'),
        });
      });
      tx.outs.forEach((output) => {
        psbt.addOutput(output);
      });
      psbt.addOutput({
        script: embed.output!,
        value: 0,
      });
      rawTx = psbt.finalizeAllInputs().extractTransaction().toHex();
    }

    const psbtRes = buildPsbt({ rawtx: rawTx, inputs: finalInputs, network });

    return {
      data: {
        rawtx: rawTx,
        psbt: psbtRes.data,
        inputs: finalInputs,
        fee,
      },
    };
  } catch (error: any) {
    return { error: error.message || 'Failed to build LTC trade transaction' };
  }
};

export const buildTradeTx = async (tradeConfig: any) => {
    try {
        const { inputs, outputs, payload, network, isApiMode } = tradeConfig;

        // Prepare inputs and outputs for RPC raw transaction creation
        const rpcInputs = inputs.map((input: any) => ({
            txid: input.txid,
            vout: input.vout,
        }));

        const rpcOutputs: any = {};
        outputs.forEach((output: any) => {
            rpcOutputs[output.address] = output.amount; // Use amount in LTC/BTC
        });

        // Create the raw transaction using the RPC
        const crtRes = await smartRpc('createrawtransaction', [rpcInputs, rpcOutputs], isApiMode);
        if (crtRes.error || !crtRes.data) {
            throw new Error(`createrawtransaction: ${crtRes.error}`);
        }

        let rawTx = crtRes.data;

        // Add OP_RETURN payload using bitcoinjs-lib
        if (payload) {
            const tx = bitcoin.Transaction.fromHex(rawTx);
            const data = Buffer.from(payload, 'utf8');
            const embed = bitcoin.payments.embed({ data: [data] });

            const psbt = new bitcoin.Psbt({ network: networkMap[network] });

            // Add all inputs to the PSBT
            inputs.forEach((input: any, index: number) => {
                psbt.addInput({
                    hash: tx.ins[index].hash.reverse().toString('hex'),
                    index: tx.ins[index].index,
                    nonWitnessUtxo: Buffer.from(rawTx, 'hex'),
                });
            });

            // Add outputs to the PSBT
            tx.outs.forEach((out) => {
                psbt.addOutput(out);
            });

            psbt.addOutput({
                script: embed.output!,
                value: 0, // OP_RETURN outputs have no value
            });

            rawTx = psbt.finalizeAllInputs().extractTransaction().toHex();
        }

        // Convert the raw transaction into a PSBT
        const psbt = new bitcoin.Psbt({ network: networkMap[network] });

        // Add inputs to PSBT
        inputs.forEach((input: any) => {
            psbt.addInput({
                hash: input.txid,
                index: input.vout,
                witnessUtxo: {
                    script: Buffer.from(input.scriptPubKey, 'hex'),
                    value: input.amount * 1e8, // Convert to satoshis
                },
            });
        });

        // Add outputs to PSBT
        const tx = bitcoin.Transaction.fromHex(rawTx);
        tx.outs.forEach((out: any) => {
            psbt.addOutput(out);
        });

        // Return the raw transaction and PSBT
        return { rawtx: rawTx, psbt: psbt.toHex() };
    } catch (error: any) {
        return { error: error.message || 'Failed to build trade transaction' };
    }
};


/********************************************************************
 * Additional Relayer Functions
 ********************************************************************/

export const getTx = async (txid: string) => {
  try {
    const res = await axios.post('http://localhost:3000/tl_getTransaction', { txid });
    return res.data;
  } catch (error) {
    console.error('Error in getTx:', error);
    throw error;
  }
};

export const broadcastTx = async (rawTx: string) => {
  try {
    const result = await rpcClient.call("sendrawtransaction", [rawTx]);
    return { txid: result };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error 
      ? error.message 
      : "An unexpected error occurred";
    console.error("Error broadcasting transaction:", errorMessage);
    throw new Error(errorMessage);
  }
};
