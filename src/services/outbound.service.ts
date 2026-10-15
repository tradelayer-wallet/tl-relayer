import axios, { AxiosResponse } from 'axios';

/** Wall-clock budget for one outbound call to a collator, seed host or UTXO explorer. */
export const OUTBOUND_TIMEOUT_MS = 15_000;

export interface OutboundCall {
    method?: 'GET' | 'POST';
    url: string;
    timeoutMs: number;
    maxBytes?: number;
    headers?: Record<string, string>;
    params?: Record<string, unknown>;
    data?: unknown;
}

/**
 * The single outbound HTTP path. axios `timeout` bounds socket inactivity, so a sender that keeps
 * trickling bytes holds a call open for as long as it likes, and a call that never settles holds
 * whatever waits on it (the registry reconcile loop, a request handler). The AbortController here
 * bounds the whole call, headers and body. Redirects are never followed, and the body is capped
 * when `maxBytes` is set. Errors other than the deadline are rethrown unchanged, so callers still
 * read the response payload they read today.
 */
export const outboundCall = async (call: OutboundCall): Promise<AxiosResponse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), call.timeoutMs);
    try {
        return await axios.request({
            method: call.method || 'GET',
            url: call.url,
            headers: call.headers,
            params: call.params,
            data: call.data,
            signal: controller.signal,
            maxRedirects: 0,
            maxContentLength: call.maxBytes,
        });
    } catch (error) {
        if (controller.signal.aborted) {
            throw new Error(`upstream deadline of ${call.timeoutMs} ms exceeded`);
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
};
