// ISO 20022 / SWIFT ADAPTER
const crypto = require('crypto');
const logger = require('../logger');

/**
 * Generates an ISO 20022 PAIN.001 (CustomerCreditTransferInitiationV09) XML buffer
 */
function generatePain001XML(instruction) {
    const messageId = instruction.instruction_id.replace(/-/g, '').substring(0, 35);
    const creationDateTime = new Date().toISOString();

    // In production, an XML builder like xmlbuilder2 would be configured securely
    return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${messageId}</MsgId>
      <CreDtTm>${creationDateTime}</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
      <CtrlSum>${instruction.amount}</CtrlSum>
      <InitgPty>
        <Nm>Project Fusion Treasury</Nm>
      </InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>PMT-${messageId}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <ReqdExctnDt>${creationDateTime.split('T')[0]}</ReqdExctnDt>
      <Dbtr>
        <Nm>Project Fusion Master Account</Nm>
      </Dbtr>
      <DbtrAcct>
        <Id>
          <IBAN>GB29XABC10161234567890</IBAN>
        </Id>
      </DbtrAcct>
      <DbtrAgt>
        <FinInstnId>
          <BICFI>BOFAGB22</BICFI>
        </FinInstnId>
      </DbtrAgt>
      <CdtTrfTxInf>
        <PmtId>
          <EndToEndId>${messageId}</EndToEndId>
        </PmtId>
        <Amt>
          <InstdAmt Ccy="${instruction.currency}">${instruction.amount}</InstdAmt>
        </Amt>
        <Cdtr>
          <Nm>${instruction.recipient}</Nm>
        </Cdtr>
      </CdtTrfTxInf>
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>`;
}

async function executeISO20022Transfer(instruction) {
    logger.info(
        `[ISO-20022] Generating PAIN.001 XML for Instruction ${instruction.instruction_id}`
    );

    try {
        const xmlPayload = generatePain001XML(instruction);

        // Simulating SFTP delivery or direct API connection to Tier 1 Core Banking
        logger.info(`[ISO-20022] Dispatched to Core Banking Gateway:`);
        // We log a small snippet of the XML to prove structural integrity without flooding console
        logger.info(`[ISO-20022] Payload Snippet: ${xmlPayload.substring(0, 200)}...`);

        // Mock 1.5s delay for bank processing
        await new Promise((r) => setTimeout(r, 1500));

        // Generate synthetic external intent matching bank network
        const gatewayAckId = 'iso_' + crypto.randomBytes(8).toString('hex');

        return {
            adapter_type: 'ISO_20022_SWIFT',
            status: 'SUCCESS',
            intent_id: gatewayAckId,
            timestamp: new Date().toISOString(),
        };
    } catch (err) {
        logger.error(`[ISO-20022] Matrix generation failed: ${err.message}`);
        return {
            status: 'FAILED',
            error: err.message,
            timestamp: new Date().toISOString(),
        };
    }
}

async function queryStatus(intentId) {
    if (!intentId) return 'UNKNOWN';
    // MOCK: In production, this would query the bank's API or check for camt.052/053 bank statements
    logger.info(`[ISO-20022] Querying status for Intent: ${intentId}`);

    // Simulate finding the transaction (95% success for mock reconciliation)
    const mockSuccess = !intentId.endsWith('0');
    return mockSuccess ? 'succeeded' : 'pending';
}

module.exports = { executeISO20022Transfer, queryStatus };
