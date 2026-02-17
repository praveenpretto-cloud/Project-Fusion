const swaggerJsdoc = require('swagger-jsdoc');

const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Project Fusion API',
            version: '1.0.0',
            description: 'Universal Multi-Rail Settlement Orchestration API',
            contact: {
                name: 'Project Maintainer',
            },
        },
        servers: [
            {
                url: 'https://localhost:3000/api',
                description: 'Local Development Server',
            },
        ],
        components: {
            securitySchemes: {
                ApiKeyAuth: {
                    type: 'apiKey',
                    in: 'header',
                    name: 'x-api-key',
                },
                IdempotencyKey: {
                    type: 'apiKey',
                    in: 'header',
                    name: 'x-idempotency-key',
                },
            },
        },
        security: [
            {
                ApiKeyAuth: [],
            },
        ],
    },
    apis: ['./server.js', './routes/*.js'],
};

module.exports = swaggerJsdoc(options);
