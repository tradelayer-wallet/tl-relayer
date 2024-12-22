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
