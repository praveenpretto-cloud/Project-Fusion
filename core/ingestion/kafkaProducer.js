const { Kafka } = require('kafkajs');
const logger = require('../../logger');

const kafka = new Kafka({
    clientId: 'fusion-core',
    brokers: [process.env.KAFKA_BROKER || 'localhost:9092'],
});

const producer = kafka.producer();
let isConnected = false;

async function connectProducer() {
    if (isConnected || process.env.LOCAL_ONLY === 'true') return;
    try {
        await producer.connect();
        isConnected = true;
        logger.info('[KAFKA] Producer connected');
    } catch (error) {
        logger.error('[KAFKA] Producer connection error: ' + error.message);
    }
}

async function pushToBatchQueue(topic, messages) {
    if (!messages || messages.length === 0) return;

    if (process.env.LOCAL_ONLY === 'true') {
        logger.info(
            `[LOCAL_ONLY] Bypassing Kafka for ${messages.length} messages on topic ${topic} (handled sequentially in background)`
        );
        return;
    }

    try {
        await connectProducer();
        await producer.send({
            topic,
            messages: messages.map((m) => ({ value: JSON.stringify(m) })),
        });
        logger.info(`[KAFKA] Pushed ${messages.length} messages to topic ${topic}`);
    } catch (error) {
        logger.error('[KAFKA] Send error: ' + error.message);
        throw error;
    }
}

module.exports = { pushToBatchQueue };
