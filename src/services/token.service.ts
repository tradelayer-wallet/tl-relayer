import { callRpc } from './address.service';

export const getTokenInfo = async (propid) => {
  try {
    console.log('[portfolio-heartbeat][relayer][token] getTokenInfo request', {
      propid: Number(propid),
      mappedRpc: 'tl_getproperty',
      sourceEndpoint: 'testnet-api',
    });
    const res = await callRpc('tl_getproperty', propid);
    if (res.error) {
      console.warn('[portfolio-heartbeat][relayer][token] getTokenInfo failed', {
        propid: Number(propid),
        error: res.error,
      });
      return { error: res.error };
    }
    console.log('[portfolio-heartbeat][relayer][token] getTokenInfo response', {
      propid: Number(propid),
      hasData: res.data != null,
    });
    return res.data;
  } catch (error) {
    console.error('Error in getTokenInfo:', error);
    throw error;
  }
};

export const listTokens = async () => {
  try {
    console.log('[portfolio-heartbeat][relayer][token] listTokens request', {
      mappedRpc: 'tl_listproperties',
      sourceEndpoint: 'testnet-api',
    });
    const res = await callRpc('tl_listproperties');
    if (res.error) {
      console.warn('[portfolio-heartbeat][relayer][token] listTokens failed', {
        error: res.error,
      });
      return { error: res.error };
    }
    console.log('[portfolio-heartbeat][relayer][token] listTokens response', {
      hasData: res.data != null,
      responseType: Array.isArray(res.data) ? 'array' : typeof res.data,
    });
    return res.data;
  } catch (error) {
    console.error('Error in listTokens:', error);
    throw error;
  }
};
