import { FastifyInstance } from "fastify";

export const someRoutes = (fastify: FastifyInstance, opts: any, done: any) => {
    fastify.get('/test', (request, reply) => {
        console.log(request.query);
    });
    done();
}