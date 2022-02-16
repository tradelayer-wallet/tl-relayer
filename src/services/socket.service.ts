import { FastifyInstance } from "fastify";
import { Socket, Server } from "socket.io";
import { envConfig } from "../config/env.config";
import { rpcClient } from "../config/rpc.config";

export let walletSocketSevice: SocketService;

export const initSocketConnection = (app: FastifyInstance) => {
    walletSocketSevice = new SocketService(app);
};

export class SocketService {
    public io: Server;
    public lastBlock: number = 0;
    private blockCountingInterval: any;

    constructor(app: FastifyInstance) {
        const socketOptions = { cors: { origin: "*", methods: ["GET", "POST"] } };
        this.io = new Server(envConfig.SOCKET_PORT, socketOptions);
        this.handleEvents();

    }

    private handleEvents() {
        console.log(`Socket Server Started!`);
        this.startBlockCounting();
        this.io.on('connection', (socket) => {
            console.log(`New Connection: ${socket.id}`);
        });
    }

    stopBlockCounting() {
        if (this.blockCountingInterval) {
            clearInterval(this.blockCountingInterval);
            this.blockCountingInterval = null;
        }
    }

    startBlockCounting() {
        if (this.blockCountingInterval) return;
             this.blockCountingInterval = setInterval(async () => {
                if (!rpcClient) return;
                const bbhRes = await rpcClient.call('getbestblockhash');
                if (bbhRes.error || !bbhRes.data) {
                    this.onTimeOutMessage(bbhRes.error);
                    return null;
                }
                const bbRes = await rpcClient.call('getblock', bbhRes.data);
                if (bbRes.error || !bbRes.data) {
                    this.onTimeOutMessage(bbhRes.error);
                    return null;
                };
                const height = bbRes.data.height;
                if (this.lastBlock < height) {
                    this.lastBlock = height;
                    console.log(`New Block: ${height}`)
                    this.io.emit('newBlock', height);
                }
            }, 2500);
    }

    async onTimeOutMessage(message: string) {
        if (message && message.includes('ECONNREFUSED')) {
            const check = await rpcClient.call('tl_getinfo');
            if (check.error || !check.data) {
                this.io.emit('rpc-connection-error');
            }
        }
    }
}