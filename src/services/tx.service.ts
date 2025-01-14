import * as bitcoin from 'bitcoinjs-lib';
import axios from 'axios';
import { rpcClient } from "../config/rpc.config";  // Your configured RPC client

/********************************************************************
 * Type Definitions (adjust as needed in your environment)
 ********************************************************************/
export interface IUTXO {
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
  inputs?: IUTXO[];
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
  commitUTXOs: IUTXO[],
  inputs: IUTXO[]
  network: string;
}

export interface ApiRes {
  data?: any;
  error?: string;
}

export type TClient = (method: string, ...args: any[]) => Promise<any>;


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
  const url = `http://localhost:3001/${method}`;
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
const getEnoughInputs2 = (_inputs: IUTXO[], amount: number) => {
  const finalInputs: IUTXO[] = [];
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
 * - Takes array of inputs (IUTXO[]), 
 * - Returns a PSBT hex (not signed).
 ********************************************************************/
import { Psbt, Transaction } from 'bitcoinjs-lib';

export const buildPsbt = (buildPsbtOptions: {
  rawtx: string,
  inputs: IUTXO[],
  network: string
}) => {
  try {
    const { rawtx, inputs, network } = buildPsbtOptions;
    const _network = networks[network];  // e.g. LTC, BTC, etc.

    const tx = Transaction.fromHex(rawtx);

    const psbt = new Psbt({ network: _network });

    inputs.forEach((input: IUTXO) => {
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

export const decodeTx = async (rawTx: string) => {
  try {
    // 1) Get UTXOs from node
    const luRes = await smartRpc('decoderawtransaction', rawTx);
    if (luRes.error || !luRes.data) {
      throw new Error(`listunspent(from): ${luRes.error}`);
    }
    return luRes
  }catch(error:any){
   console.error('Error in decodeTx:', error.message || error);
    throw error; // Re-throw to be handled by the caller
  }
}

/********************************************************************
 * BUILD TX
 ********************************************************************/// Rewritten buildTx
export const buildTx = async (txConfig: IBuildTxConfig, isApiMode: boolean) => {
  try {
    const { fromKeyPair, toKeyPair, amount, payload, addPsbt, network } = txConfig;

    const fromAddress = fromKeyPair.address;
    const toAddress   = toKeyPair.address;

    // 1) Get UTXOs from node
    const luRes = await smartRpc('listunspent', [0, 999999999, [fromAddress]], isApiMode);
    if (luRes.error || !luRes.data) {
      throw new Error(`listunspent(from): ${luRes.error}`);
    }

    // 2) Sort and pick enough inputs
    const _utxos = (luRes.data as IUTXO[]).sort((a, b) => b.amount - a.amount);
    console.log('UTXOs:', JSON.stringify(_utxos));

    const inputsRes = getEnoughInputs2(_utxos, amount!);
    const { finalInputs, fee } = inputsRes;
    if (finalInputs.length === 0) {
      throw new Error('Not enough inputs to cover the amount + fee');
    }

    // 3) Build "inputs" and "outputs" for walletcreatefundedpsbt
    //    Even though we have finalInputs, we pass them to the node to ensure it only uses those.
    //    The node can still add a change output automatically if needed.
    //    We'll specify outputs as well.

    // Final outputs (address => amountInBTC) 
    // Must be in BTC if your node is set up that way. Or if your node expects satoshis, adjust accordingly.
    const sendAmountBtc = safeNumber(amount! - fee);
    const outputs: Record<string, number| string> = {
      [toAddress]: sendAmountBtc, 
    };

    // 4) If you have a payload (OP_RETURN), we can add a "data" output in the same outputs array.
    //    The node interprets { data: <hexstring> } as an OP_RETURN output.
    //    We have to supply the data in hex. Let's do that:
   if (payload) {
  const dataHex = Buffer.from(payload, 'utf8').toString('hex');
  outputs.data = dataHex;  // now valid, because 'data' can be a string
}

    // 5) Convert finalInputs into the format "walletcreatefundedpsbt" expects:
    //    An array of { "txid": string, "vout": number, "sequence"?: number }
    const psbtInputs = finalInputs.map(inp => ({
      txid: inp.txid,
      vout: inp.vout,
    }));

    // 6) Call walletcreatefundedpsbt
    //    The 3rd param is locktime (0 = none). 
    //    The 4th param is options. 
    //    The 5th param is bip32derivs (usually true if you want BIP32 derivation info).
    const wcfpRes = await smartRpc(
      'walletcreatefundedpsbt', 
      [ psbtInputs, outputs, 0, { 
          // If you want to specify a custom change address:
          // "changeAddress": fromAddress,
          // "includeWatching": true,
          // "feeRate": 0.00001000,  // example fee rate in BTC/kvB
        }, 
        true 
      ], 
      isApiMode
    );

    if (wcfpRes.error || !wcfpRes.data) {
      throw new Error(`walletcreatefundedpsbt: ${wcfpRes.error || 'no data'}`);
    }

    // The result typically includes { psbt: "base64string", fee: X, changePos: Y }
    const { psbt: psbtBase64, fee: actualFee, changePos } = wcfpRes.data;

    // 7) Optionally finalize with buildPsbt? Or just return the base64 from the node.
    //    If you want to modify the PSBT further in Node.js, you can do:
    // const psbtObj = Psbt.fromBase64(psbtBase64, { network: networkMap[network!] });
    // psbtObj.addSomething()...   // But usually it's fully formed for signing.

    // 8) Prepare the response
    const data: any = {
      // rawtx is not needed if you're doing PSBT flow, but let's keep consistency:
      rawtx: psbtBase64,  // This is actually a PSBT base64
      inputs: finalInputs,
    };

    // If the user wants a separate PSBT output (maybe in hex?), we can do:
    if (addPsbt) {
      // They might want it as hex. Convert from base64 to hex:
      const psbtBuf = Buffer.from(psbtBase64, 'base64');
      const psbtHex = psbtBuf.toString('hex');
      data.psbt = psbtHex;
    }

    return { data };
  } catch (error: any) {
    console.error('Error in buildTx:', error.message || error);
    return { error: error.message || 'Failed to build transaction' };
  }
};

/********************************************************************
 * BUILD LTC TRADE TX
 ********************************************************************/
/********************************************************************
 * BUILD LTC TRADE TX
 ********************************************************************/export const buildLTCTradeTx = async (txConfig: IBuildLTCITTxConfig, isApiMode: boolean) => {
  try {
    console.log('tx config in built ltc trade ' + JSON.stringify(txConfig));
    const { buyerKeyPair, sellerKeyPair, amount, payload, commitUTXOs, network } = txConfig;

    const buyerAddress = buyerKeyPair.address;
    const sellerAddress = sellerKeyPair.address;

    console.log(`Buyer: ${buyerAddress}, Seller: ${sellerAddress}, Amount: ${amount}`);

    // Fetch UTXOs for the buyer address
    const luRes = await smartRpc('listunspent', [0, 999999999, [buyerAddress]], isApiMode);
    if (luRes.error || !luRes.data) {
      throw new Error(`listunspent(buyer): ${luRes.error}`);
    }

    const utxos = [...commitUTXOs, ...luRes.data];
    console.log('UTXOs:', JSON.stringify(utxos));

    // Select inputs
    const inputsRes = getEnoughInputs2(utxos, amount);
    const { finalInputs, fee } = inputsRes;

    if (finalInputs.length === 0) {
      throw new Error('Not enough inputs to cover the transaction.');
    }

    const _insForRawTx = finalInputs.map(({ txid, vout }) => ({ txid, vout }));
    const totalInputAmount = safeNumber(finalInputs.reduce((a, b) => a + b.amount, 0));
    const _outsForRawTx: any = {
      [sellerAddress]: safeNumber(amount - fee),
      [buyerAddress]: safeNumber(totalInputAmount - amount - fee),
    };

    console.log('Inputs:', JSON.stringify(_insForRawTx));
    console.log('Outputs:', JSON.stringify(_outsForRawTx));

    // Create raw transaction
    const crtRes = await smartRpc('createrawtransaction', [_insForRawTx, _outsForRawTx], isApiMode);
    if (crtRes.error || !crtRes.data) {
      throw new Error(`createrawtransaction: ${crtRes.error}`);
    }

    let rawTx = crtRes.data;
    let psbtHex = '';

    if (payload) {
      const tx = bitcoin.Transaction.fromHex(rawTx);
      const data = Buffer.from(payload, 'utf8');
      const embed = bitcoin.payments.embed({ data: [data] });

      const psbt = new Psbt({ network: networkMap[network] });

      finalInputs.forEach((input) => {
        const psbtInput: any = {
          hash: input.txid,
          index: input.vout,
        };

        if (input.scriptPubKey && input.amount) {
          psbtInput.witnessUtxo = {
            script: Buffer.from(input.scriptPubKey, 'hex'),
            value: Math.round(input.amount * 1e8), // Convert LTC to satoshis
          };
        }

        if (input.redeemScript) {
          psbtInput.redeemScript = Buffer.from(input.redeemScript, 'hex');
        }

        psbt.addInput(psbtInput);
      });

      tx.outs.forEach((output) => {
        psbt.addOutput({
          script: output.script,
          value: output.value,
        });
      });

      psbt.addOutput({
        script: embed.output!,
        value: 0, // OP_RETURN output
      });

      // Log PSBT details
      console.log('PSBT Details:', JSON.stringify(psbt.data, null, 2));

      psbtHex = psbt.toHex();
    }

    return {
      data: { rawtx: rawTx, inputs: finalInputs, psbtHex: psbtHex },
    };
  } catch (error: any) {
    console.error('Error in buildLTCTradeTx:', error.message || error);
    return { error: error.message || 'Failed to build LTC trade transaction' };
  }
};


export const buildTradeTx = async (tradeConfig: IBuildLTCITTxConfig) => {
  try {
    const { buyerKeyPair, sellerKeyPair, amount, payload, commitUTXOs, inputs, network } = tradeConfig;

    const buyerAddress = buyerKeyPair.address;
    const sellerAddress = sellerKeyPair.address;

    // Combine inputs from `inputs` and `commitUTXOs`
    const allInputs = [...(inputs || []), ...commitUTXOs];
    console.log('All Inputs:', JSON.stringify(allInputs));

    const rpcInputs = allInputs.map(({ txid, vout }) => ({ txid, vout }));

    // Outputs: amount to seller and change back to buyer
    const totalInputAmount = allInputs.reduce((sum, utxo) => sum + utxo.amount, 0);
    const fee = 0.0001; // Adjust fee as necessary
    const change = totalInputAmount - amount - fee;

    if (change < 0) {
      throw new Error('Insufficient funds for transaction');
    }

    const rpcOutputs: any = {
      [sellerAddress]: amount,
      [buyerAddress]: change,
    };

    console.log('RPC Inputs:', JSON.stringify(rpcInputs));
    console.log('RPC Outputs:', JSON.stringify(rpcOutputs));

    // Create raw transaction
    const crtRes = await smartRpc('createrawtransaction', [rpcInputs, rpcOutputs], false);
    if (crtRes.error || !crtRes.data) {
      throw new Error(`createrawtransaction: ${crtRes.error}`);
    }

    let rawTx = crtRes.data;

    if (payload) {
      const tx = bitcoin.Transaction.fromHex(rawTx);
      const data = Buffer.from(payload, 'utf8');
      const embed = bitcoin.payments.embed({ data: [data] });

      const psbt = new bitcoin.Psbt({ network: networkMap[network] });
      allInputs.forEach((input, index) => {
        psbt.addInput({
          hash: input.txid,
          index: input.vout,
          witnessUtxo: {
            script: Buffer.from(input.scriptPubKey, 'hex'),
            value: Math.round(input.amount * 1e8),
          },
        });
      });

      tx.outs.forEach((output) => psbt.addOutput(output));
      psbt.addOutput({
        script: embed.output!,
        value: 0, // OP_RETURN output
      });

      rawTx = psbt.toHex();
    }

    return { data: { rawtx: rawTx, inputs: allInputs } };
  } catch (error: any) {
    console.error('Error in buildTradeTx:', error.message || error);
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
  console.log('rawtx in broadcast ' +rawTx)
  try {
    const result = await rpcClient.call("sendrawtransaction", rawTx);
    console.log('result of tx send '+JSON.stringify(result)) 
    return { txid: result };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error 
      ? error.message 
      : "An unexpected error occurred";
    console.error("Error broadcasting transaction:", errorMessage);
    throw new Error(errorMessage);
  }
};
