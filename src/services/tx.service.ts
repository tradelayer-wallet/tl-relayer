/********************************************************************
 * relayerTxBuilder.service.ts
 *
 * This file ports the "build" logic from your existing cryptoUtils 
 * and txBuilder service so that it can be used on the Relayer side, 
 * without including any signing logic.
 ********************************************************************/

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
  // If we decide to call the core node directly:
  if (rpcClient && !api) {
    return await rpcClient.call(method, ...params);
  } else {
    // If an API is available, we can route the request there
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
 * Get the minimal vout amount needed for referencing in Omni/LTC-based transactions
 */
const getMinVoutAmount = async (toAddress: string, isApiMode: boolean) => {
  try {
    // For many Omni-based use cases, 0.0000546 LTC is typical. 
    // You can make this dynamic with an RPC call if needed:
    return { data: 0.0000546 };

    // Alternatively, calling `tl_createrawtx_reference`:
    /*
    const crtxrRes = await smartRpc('tl_createrawtx_reference', ['', toAddress], isApiMode);
    if (crtxrRes.error || !crtxrRes.data) throw new Error(`tl_createrawtx_reference: ${crtxrRes.error}`);

    const drwRes = await smartRpc('decoderawtransaction', [crtxrRes.data], isApiMode);
    if (drwRes.error || !drwRes.data) throw new Error(`decoderawtransaction: ${drwRes.error}`);

    const minAmount = parseFloat(drwRes.data.vout[0].value);
    return { data: minAmount };
    */
  } catch (error) {
    return { error: error.message || 'Undefined getMinVoutAmount Error' };
  }
};

/**
 * Gathers enough UTXOs for a target amount. A simplistic approach:
 */
const getEnoughInputs = (_inputs: IInput[], amount: number) => {
  const finalInputs: IInput[] = [];
  _inputs.forEach((u) => {
    const currentSum = finalInputs.reduce((a, b) => a + b.amount, 0);
    if (currentSum < amount) {
      finalInputs.push(u);
    }
  });
  const fee = safeNumber((0.2 * minFeeLtcPerKb) * finalInputs.length);
  return { finalInputs, fee };
};

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
import { networks } from '../utils/networks';  // or wherever your network config is

export const buildPsbt = (buildPsbtOptions: {
  rawtx: string,
  inputs: IInput[],
  network: string
}) => {
  try {
    const { rawtx, inputs, network } = buildPsbtOptions;
    const _network = networks[network];  // e.g. LTC, BTC, etc.

    // Create base transaction
    const tx = Transaction.fromHex(rawtx);

    // Initialize an empty Psbt
    const psbt = new Psbt({ network: _network });

    inputs.forEach((input: IInput) => {
      const hash = input.txid;
      const index = input.vout;
      const value = safeNumber(input.amount * 1e8, 0);
      const script = Buffer.from(input.scriptPubKey, 'hex');
      const witnessUtxo = { script, value };

      const inputObj: any = { hash, index, witnessUtxo };

      // If you have a witnessScript (e.g. multisig, p2wsh):
      if (input.redeemScript) {
        inputObj.witnessScript = Buffer.from(input.redeemScript, 'hex');
      }

      psbt.addInput(inputObj);
    });

    // Add outputs from the original transaction
    psbt.addOutputs(tx.outs);

    // Return the final psbt hex
    const psbtHex = psbt.toHex();
    return { data: psbtHex };
  } catch (error: any) {
    return { error: error.message };
  }
};


/********************************************************************
 * BUILD LTC "Instant" Tx
 *
 * Example of a specialized method that:
 *  1) Validates buyer & seller addresses
 *  2) Collects UTXOs, including "commitUTXOs"
 *  3) Creates raw transaction & attaches OP_RETURN (payload)
 *  4) Returns the final rawTx and optional PSBT for signing
 ********************************************************************/
export const buildLTCInstatTx = async (
  txConfig: IBuildLTCITTxConfig,
  isApiMode: boolean
) => {
  try {
    const { buyerKeyPair, sellerKeyPair, amount, payload, commitUTXOs, network } = txConfig;
    const buyerAddress = buyerKeyPair.address;
    const sellerAddress = sellerKeyPair.address;

    // 1) Validate addresses
    const vaRes1 = await smartRpc('validateaddress', [buyerAddress], isApiMode);
    if (vaRes1.error || !vaRes1.data?.isvalid) {
      throw new Error(`validateaddress(buyer): ${vaRes1.error}`);
    }
    const vaRes2 = await smartRpc('validateaddress', [sellerAddress], isApiMode);
    if (vaRes2.error || !vaRes2.data?.isvalid) {
      throw new Error(`validateaddress(seller): ${vaRes2.error}`);
    }

    // 2) Collect UTXOs from buyer + commitUTXOs
    const luRes = await smartRpc('listunspent', [0, 999999999, [buyerAddress]], false);
    if (luRes.error || !luRes.data) {
      throw new Error(`listunspent(buyer): ${luRes.error}`);
    }
    const _utxos = (luRes.data as IInput[])
      .map((i) => ({ ...i, pubkey: buyerKeyPair.pubkey }))
      .sort((a, b) => b.amount - a.amount);

    // Combine with commitUTXOs (passed in from user)
    const utxos = [...commitUTXOs, ..._utxos];

    // 3) Figure out minimal LTC amount needed and gather enough inputs
    const minAmountRes = await getMinVoutAmount(sellerAddress, isApiMode);
    if (minAmountRes.error || !minAmountRes.data) {
      throw new Error(`getMinVoutAmount: ${minAmountRes.error}`);
    }
    const minAmount = minAmountRes.data;
    const buyerLtcAmount = minAmount;
    const sellerLtcAmount = Math.max(amount, minAmount);
    const minAmountForAllOuts = safeNumber(buyerLtcAmount + sellerLtcAmount);

    const inputsRes = getEnoughInputs2(utxos, minAmountForAllOuts);
    const { finalInputs, fee } = inputsRes;
    if (!finalInputs.length) throw new Error("Not enough UTXOs. Code 3");

    // Summation of all input amounts
    const inputsSum = safeNumber(finalInputs.reduce((a, b) => a + b.amount, 0));

    // Decide how much is going to the buyer (change or buyer's leftover) and seller
    const changeBuyerLtcAmount = safeNumber(
      inputsSum - sellerLtcAmount - fee
    ) > buyerLtcAmount
      ? safeNumber(inputsSum - sellerLtcAmount - fee)
      : buyerLtcAmount;

    if (inputsSum < safeNumber(fee + sellerLtcAmount + changeBuyerLtcAmount)) {
      throw new Error("Not enough coins for fees. Code 1");
    }

    // 4) Build raw transaction
    const _insForRawTx = finalInputs.map(({ txid, vout }) => ({ txid, vout }));
    const _outsForRawTx: any = {
      [buyerAddress]: changeBuyerLtcAmount,
      [sellerAddress]: sellerLtcAmount,
    };

    // create raw transaction via RPC
    const crtRes = await smartRpc('createrawtransaction', [_insForRawTx, _outsForRawTx], isApiMode);
    if (crtRes.error || !crtRes.data) {
      throw new Error(`createrawtransaction: ${crtRes.error}`);
    }

    // attach OP_RETURN (payload) via local JS or a node service
    const crtxoprRes = await jsTlApi('tl_createrawtx_opreturn', [crtRes.data, payload]);
    if (crtxoprRes.error || !crtxoprRes.data) {
      throw new Error(`tl_createrawtx_opreturn: ${crtxoprRes.error}`);
    }

    const finalTx = crtxoprRes.data; // hex of rawTx

    // 5) (Optional) Build PSBT from finalTx if you want to pass it somewhere for signing
    const psbtHexConfig = {
      rawtx: finalTx,
      inputs: finalInputs,
      network: network,
    };
    const psbtHexRes = buildPsbt(psbtHexConfig);
    if (psbtHexRes.error || !psbtHexRes.data) {
      throw new Error(`buildPsbt: ${psbtHexRes.error}`);
    }

    const data: any = {
      rawtx: finalTx,
      inputs: finalInputs,
      psbtHex: psbtHexRes.data,
      // You might also want to return fee, or other info:
      fee,
      sellerLtcAmount,
      buyerLtcAmount: changeBuyerLtcAmount,
    };

    return { data };
  } catch (error: any) {
    return { error: error.message || 'Undefined build Tx Error' };
  }
};


/********************************************************************
 * BUILD GENERIC TX
 *
 * A more generic method (similar to buildTx in your code).
 ********************************************************************/
export const buildTx = async (txConfig: IBuildTxConfig, isApiMode: boolean) => {
  try {
    const { fromKeyPair, toKeyPair, amount, payload, inputs, addPsbt, network } = txConfig;
    const fromAddress = fromKeyPair.address;
    const toAddress = toKeyPair.address;

    // 1) Validate addresses
    const vaRes1 = await smartRpc('validateaddress', [fromAddress], isApiMode);
    if (vaRes1.error || !vaRes1.data?.isvalid) {
      throw new Error(`validateaddress(from): ${vaRes1.error}`);
    }
    const vaRes2 = await smartRpc('validateaddress', [toAddress], isApiMode);
    if (vaRes2.error || !vaRes2.data?.isvalid) {
      throw new Error(`validateaddress(to): ${vaRes2.error}`);
    }

    // 2) Collect UTXOs
    const luRes = await smartRpc('listunspent', [0, 999999999, [fromAddress]], isApiMode);
    if (luRes.error || !luRes.data) {
      throw new Error(`listunspent(from): ${luRes.error}`);
    }
    // Sort UTXOs largest-first, then optionally merge with externally-supplied inputs
    const _utxos = (luRes.data as IInput[])
      .map((i) => ({ ...i, pubkey: fromKeyPair.pubkey }))
      .sort((a, b) => b.amount - a.amount);

    const _inputs = inputs?.length ? inputs : [];
    const utxos = [..._inputs, ..._utxos];

    // 3) Minimum amount logic if relevant
    const minAmountRes = await getMinVoutAmount(toAddress, isApiMode);
    if (minAmountRes.error || !minAmountRes.data) {
      throw new Error(`getMinVoutAmount: ${minAmountRes.error}`);
    }
    const minAmount = minAmountRes.data;
    if ((minAmount > (amount || 0)) && !payload) {
      throw new Error(`Minimum amount is: ${minAmount}`);
    }

    // Ensure the tx is at least the min
    const _amount = Math.max(amount || 0, minAmount);

    // 4) Gather enough inputs
    const inputsRes = getEnoughInputs(utxos, _amount);
    const { finalInputs, fee } = inputsRes;
    if (!finalInputs.length) {
      throw new Error("Not enough coins for paying fees. Code 3");
    }

    // 5) Compute outputs
    const inputsSum = safeNumber(finalInputs.reduce((a, b) => a + b.amount, 0));
    const _toAmount = safeNumber(_amount - fee);
    const toAmount = Math.max(minAmount, _toAmount);

    // If no payload, entire leftover is change; if there's a payload, some fee may be used
    const change = !payload
      ? safeNumber(inputsSum - _amount)
      : safeNumber(inputsSum - _amount - fee);

    if (inputsSum < safeNumber(fee + toAmount + change)) {
      throw new Error("Not enough coins for paying fees. Code 1");
    }
    if (inputsSum < _amount) {
      throw new Error("Not enough coins for paying fees. Code 2");
    }

    // 6) Build raw transaction via RPC
    const _insForRawTx = finalInputs.map(({ txid, vout }) => ({ txid, vout }));
    const _outsForRawTx: any = { [toAddress]: toAmount };
    if (change > 0) _outsForRawTx[fromAddress] = change;

    const crtRes = await smartRpc('createrawtransaction', [_insForRawTx, _outsForRawTx], isApiMode);
    if (crtRes.error || !crtRes.data) {
      throw new Error(`createrawtransaction: ${crtRes.error}`);
    }
    let finalTx = crtRes.data;

    // 7) If there's a payload to attach, do so
    if (payload) {
      const crtxoprRes = await jsTlApi('tl_createrawtx_opreturn', [finalTx, payload], isApiMode);
      if (crtxoprRes.error || !crtxoprRes.data) {
        throw new Error(`tl_createrawtx_opreturn: ${crtxoprRes.error}`);
      }
      finalTx = crtxoprRes.data;
    }

    // 8) Return the rawTx and optionally a PSBT
    const data: any = {
      rawtx: finalTx,
      inputs: finalInputs,
    };

    if (addPsbt) {
      const psbtHexConfig = {
        rawtx: finalTx,
        inputs: finalInputs,
        network: network || "LTCTEST", // or whichever you want default
      };
      const psbtHexRes = buildPsbt(psbtHexConfig);
      if (psbtHexRes.error || !psbtHexRes.data) {
        throw new Error(`buildPsbt: ${psbtHexRes.error}`);
      }
      data.psbtHex = psbtHexRes.data;
    }

    return { data };
  } catch (error: any) {
    return { error: error.message || 'Undefined build Tx Error' };
  }
};


/********************************************************************
 * Additional Relayer Functions
 *
 * Example functions you might have for retrieving or broadcasting 
 * a transaction. Adjust to your environment as needed.
 ********************************************************************/

/**
 * Retrieve a transaction from local node or an HTTP server
 */
export const getTx = async (txid: string) => {
  try {
    // Example of calling a local Node/Express endpoint:
    const res = await axios.post('http://localhost:3000/tl_getTransaction', { txid });
    return res.data;
  } catch (error) {
    console.error('Error in getTx:', error);
    throw error;
  }
};

/**
 * Broadcast the transaction on the network (via your RPC node)
 */
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
