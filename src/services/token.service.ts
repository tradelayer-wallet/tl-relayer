import { rpcClient } from "../config/rpc.config"

import axios from 'axios';

const BASE_URL = 'http://localhost:3000'; // Your Express server base URL


export const getTokenInfo = async (propid) => {
  try {
    const res = await axios.post(`${BASE_URL}/tl_getProperty`, { params: propid });
    return res.data;
  } catch (error) {
    console.error('Error in getTokenInfo:', error);
    throw error;
  }
};

export const listTokens = async () => {
  try {
    const res = await axios.post(`${BASE_URL}/tl_listProperties`);
    return res.data;
  } catch (error) {
    console.error('Error in listTokens:', error);
    throw error;
  }
};
