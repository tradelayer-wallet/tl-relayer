import { FastifyInstance } from "fastify";
import { someRoutes } from './some-routes.route';

export const handleRoutes = (server: FastifyInstance) => {
    server.register(someRoutes, { prefix: '/some' });
}