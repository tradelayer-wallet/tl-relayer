import * as http from 'http';

export interface IRpcClientOptions {
    username: string;
    password: string;
    host: string;
    port: number;
    timeout: number;
}

export interface IRpcResult {
    error?: string;
    data?: any;
    statusCode?: number;
    IECode?: number;
    EECode?: number;
}

export class RpcClient {
    constructor(
        private options: IRpcClientOptions,
    ) { }

    async call(method: string, ...args: any[]): Promise<IRpcResult> {
        const requestObj = {
            id: Date.now(),
            method: method,
            params: args,
        };
        const requestJSON = JSON.stringify(requestObj);
        // Round 8: Content-Length is the byte length. String.length counts UTF-16 units, so any
        // non-ASCII parameter made the declared length short and the node read a truncated body.
        const requestBody = Buffer.from(requestJSON, 'utf8');
        const { host, port, username, password, timeout } = this.options;
        const requestOptions = {
            host: host,
            port: port,
            method: 'POST',
            headers: {
              'Host': 'localhost',
              'Content-Length': requestBody.length,
            },
            agent: false,
            auth:  username + ':' + password,
        };
        const request = http.request(requestOptions);

        return new Promise((res, rej) => {
            // The deadline covers the headers and the body. A call that gave up destroys its
            // request, so the socket does not outlive the timeout.
            const reqTimeOut = setTimeout(() => {
                request.destroy();
                res({ error: 'ETIMEDOUT' });
            }, timeout);
            request.on('error', (error) => {
                clearTimeout(reqTimeOut);
                res({ error: error.message });
            });
            request.on('response', (response) => {
                let buffer = '';
                response.on('data', (chunk) => buffer += chunk);
                response.on('end', () => {
                    clearTimeout(reqTimeOut);
                    const { statusCode } = response;
                    try {
                        if (statusCode === 401) return res({ error: 'Unauthorized', statusCode, IECode: 4 });
                        // if (statusCode !== 200) return res({ error: 'Undefined Error', statusCode, IECode: 5 })
                        const decRes = JSON.parse(buffer);
                        decRes.hasOwnProperty('error') && decRes.error !== null
                            ? res({
                                error: decRes.error.message,
                                statusCode,
                                IECode: 2,
                                EECode: decRes.error.code || 0,
                            })
                            : decRes.hasOwnProperty('result')
                                ? res({ data: decRes.result, statusCode })
                                : res({
                                    error: decRes.error?.message || 'Undefined Error',
                                    statusCode,
                                    IECode: 3,
                                    EECode: decRes.error?.code || 0,
                                });

                    } catch (error) {
                        statusCode !== 200
                            ? res({ error: error.message, statusCode })
                            : res({ error: error.message, statusCode, IECode: 1 });
                    }
                });
              });

            request.end(requestBody);
        });    
    }
}
