import { rpcClient } from "../config/rpc.config"
import axios from 'axios';

const BASE_URL = 'http://localhost:3000'; // Your Express server base URL


export const getTx = async (txid: string) => {
  try {
    const res = await axios.post(`${BASE_URL}/tl_getTransaction`, { txid });
    return res.data;
  } catch (error) {
    console.error('Error in getTx:', error);
    throw error;
  }
};


// RPC method for broadcasting the transaction
export const broadcastTx = async (rawTx: string) => {
  try {
    const result = await rpcClient.call("sendrawtransaction", [rawTx]);
    return { txid: result };
  } catch (error) {
    // Explicitly cast error to `Error` or handle `unknown` type
    const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred";
    console.error("Error broadcasting transaction:", errorMessage);
    throw new Error(errorMessage);
  }
};
