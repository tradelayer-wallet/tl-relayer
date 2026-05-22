import axios from 'axios';
import { isCollatorMode, callRpc } from './address.service';

const BASE_URL = 'http://localhost:3000'; // Your Express server base URL

export const getTokenInfo = async (propid) => {
  try {
    if (isCollatorMode()) {
      const res = await callRpc('tl_getproperty', propid);
      if (res.error) {
        return { error: res.error };
      }
      return res.data;
    }

    const res = await axios.post(`${BASE_URL}/tl_getproperty`, { params: propid });
    return res.data;
  } catch (error) {
    console.error('Error in getTokenInfo:', error);
    throw error;
  }
};

export const listTokens = async () => {
  try {
    if (isCollatorMode()) {
      const res = await callRpc('tl_listproperties');
      if (res.error) {
        return { error: res.error };
      }
      return res.data;
    }

    const res = await axios.post(`${BASE_URL}/tl_listproperties`);
    return res.data;
  } catch (error) {
    console.error('Error in listTokens:', error);
    throw error;
  }
};
