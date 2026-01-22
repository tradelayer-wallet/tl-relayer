import { rpcClient } from "../config/rpc.config"
import axios from 'axios';

const BASE_URL = 'http://localhost:3000'; // Your Express server base URL


export const getTx = async (txid) => {
  try {
    const res = await axios.post(`${BASE_URL}/tl_getTransaction`, { txid });
    return res.data;
  } catch (error) {
    console.error('Error in getTx:', error);
    throw error;
  }
};

export const sendTx = async (rawtx: string) => {
  if (!rawtx || typeof rawtx !== 'string') {
    throw new Error('rawtx is required');
  }

  try {
    // allowhighfees = true (important for mempool edge cases)
    const res = await rpcClient.call('sendrawtransaction', rawtx, true);

    if (res.error) {
      throw new Error(res.error);
    }

    return {
      success: true,
      txid: res.data
    };
  } catch (err: any) {
    throw new Error(
      `sendrawtransaction failed: ${err?.message ?? String(err)}`
    );
  }
};
