import { RpcClient, IRpcClientOptions } from '../libs/rpc-calls';
import { envConfig } from './env.config';

const options: IRpcClientOptions = {
    host: envConfig.RPC_HOST,
    port: envConfig.RPC_PORT,
    username: envConfig.RPC_USER,
    password: envConfig.RPC_PASS,
    timeout: 3000,
};

export const rpcClient = new RpcClient(options);

export const handleRpcConnection = async () => {
    const res = await rpcClient.call('getblockcount');
    return typeof res.data === 'number';
}